/**
 * BonXai Pruner - Settings and deterministic rules (no AI involved).
 *
 * Loaded as a classic script in the content script, popup, eval page and
 * service worker (importScripts). Exposes globalThis.BonXai.rules.
 *
 * Filters are structured: { id, label, prompt, mode: 'include' | 'exclude', enabled }.
 *  - mode 'exclude' ("Ocultar"): hide posts that match the topic.
 *  - mode 'include' ("Solo mostrar"): keep only posts that match the topic(s).
 * The mode is an explicit UI choice; it is never guessed from the prompt text.
 */
(function (root) {
  'use strict';
  const BonXai = (root.BonXai = root.BonXai || {});

  const DEFAULT_FILTERS = [
    {
      id: 'p-nopolitics',
      label: 'Sin política',
      prompt: 'debates políticos, elecciones, campañas o peleas partidarias',
      mode: 'exclude',
      enabled: true
    },
    {
      id: 'p-ragebait',
      label: 'Sin rage bait',
      prompt: 'posts escritos para provocar enojo, indignación o pelea (rage bait, engagement bait)',
      mode: 'exclude',
      enabled: false
    },
    {
      id: 'p-tech',
      label: 'Tech',
      prompt: 'anuncios de tecnología, lanzamientos de software, modelos de IA o papers de ingeniería',
      mode: 'include',
      enabled: false
    },
    {
      id: 'p-messi',
      label: 'Messi',
      prompt: 'elogios, goles o admiración por Lionel Messi',
      mode: 'include',
      enabled: false
    },
    {
      id: 'p-poetry',
      label: 'Poesía',
      prompt: 'poesía o versos con rima',
      mode: 'include',
      enabled: false
    }
  ];

  const DEFAULT_SETTINGS = {
    enabled: true,
    filters: DEFAULT_FILTERS,
    // How several "Solo mostrar" filters combine: 'any' = matches at least one, 'all' = matches every one.
    includeCombine: 'any',
    media: { hideImages: false, hideVideos: false, requireMedia: false },
    // Posts with photo/video but no text or alt text: 'auto' | 'keep' | 'hide'.
    uncaptioned: 'auto',
    // Send the post image to the model when the text alone is not enough.
    analyzeImages: false,
    // 'collapse' = one-line bar with the reason and a "Mostrar" button; 'remove' = display:none.
    hideStyle: 'collapse',
    // 'nano' = Chrome built-in Gemini Nano (default, 100% local);
    // 'ollama' = a model you run yourself on this computer (OpenAI-compatible endpoint on localhost).
    provider: 'nano',
    ollama: { endpoint: 'http://localhost:11434/v1/chat/completions', model: 'gemma3:4b' },
    authors: { allow: [], block: [] }
  };

  const MAX_CORRECTIONS = 50;
  const MAX_OVERRIDES = 500;
  const MAX_FILTERED_LOG = 50;
  const MAX_HIDDEN_IDS = 500;
  const MAX_CURATED = 200;

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function normalizeHandle(raw) {
    const h = String(raw || '').trim().replace(/^@/, '').toLowerCase();
    return /^[a-z0-9_]{1,15}$/.test(h) ? h : null;
  }

  function parseHandleList(text) {
    const out = [];
    for (const part of String(text || '').split(/[\s,;]+/)) {
      const h = normalizeHandle(part);
      if (h && !out.includes(h)) out.push(h);
    }
    return out;
  }

  function normalizeFilter(f, i) {
    if (!f || typeof f !== 'object') return null;
    const prompt = String(f.prompt || '').trim();
    if (!prompt) return null;
    return {
      id: String(f.id || `f-${i}-${Date.now()}`),
      label: String(f.label || prompt.slice(0, 24)).trim(),
      prompt,
      mode: f.mode === 'include' ? 'include' : 'exclude',
      enabled: Boolean(f.enabled)
    };
  }

  /**
   * Merge stored settings with defaults. Also migrates the v1.0 storage format
   * (savedPrunings with type 'inclusion' | 'exclusion').
   */
  function mergeSettings(stored, legacy) {
    const s = clone(DEFAULT_SETTINGS);
    const src = stored && typeof stored === 'object' ? stored : {};

    if (!stored && legacy && Array.isArray(legacy.savedPrunings)) {
      s.filters = legacy.savedPrunings
        .map((p, i) =>
          normalizeFilter(
            { id: p.id, label: p.label, prompt: p.prompt, enabled: p.enabled, mode: p.type === 'inclusion' ? 'include' : 'exclude' },
            i
          )
        )
        .filter(Boolean);
      if (typeof legacy.extensionEnabled === 'boolean') s.enabled = legacy.extensionEnabled;
      if (legacy.uncaptionedPolicy === 'always-keep') s.uncaptioned = 'keep';
      if (legacy.uncaptionedPolicy === 'strict') s.uncaptioned = 'hide';
      return s;
    }

    if (typeof src.enabled === 'boolean') s.enabled = src.enabled;
    if (Array.isArray(src.filters)) s.filters = src.filters.map(normalizeFilter).filter(Boolean);
    if (src.includeCombine === 'all' || src.includeCombine === 'any') s.includeCombine = src.includeCombine;
    if (src.media && typeof src.media === 'object') {
      for (const k of Object.keys(s.media)) if (typeof src.media[k] === 'boolean') s.media[k] = src.media[k];
    }
    if (['auto', 'keep', 'hide'].includes(src.uncaptioned)) s.uncaptioned = src.uncaptioned;
    if (typeof src.analyzeImages === 'boolean') s.analyzeImages = src.analyzeImages;
    if (src.hideStyle === 'remove' || src.hideStyle === 'collapse') s.hideStyle = src.hideStyle;
    if (src.provider === 'ollama' || src.provider === 'nano') s.provider = src.provider;
    if (src.ollama && typeof src.ollama === 'object') {
      if (typeof src.ollama.endpoint === 'string' && isLocalEndpoint(src.ollama.endpoint)) s.ollama.endpoint = src.ollama.endpoint;
      if (typeof src.ollama.model === 'string' && src.ollama.model.trim()) s.ollama.model = src.ollama.model.trim();
    }
    if (src.authors && typeof src.authors === 'object') {
      s.authors.allow = parseHandleList((src.authors.allow || []).join(' '));
      s.authors.block = parseHandleList((src.authors.block || []).join(' '));
    }
    return s;
  }

  /** Only endpoints on this computer are accepted: zero cloud. */
  function isLocalEndpoint(url) {
    try {
      const u = new URL(url);
      return (u.protocol === 'http:' || u.protocol === 'https:') && ['localhost', '127.0.0.1'].includes(u.hostname);
    } catch {
      return false;
    }
  }

  function activeFilters(settings) {
    return (settings.filters || []).filter((f) => f.enabled && f.prompt.trim());
  }

  const show = (reason) => ({ final: true, action: 'show', reason: reason || null });
  const hide = (reason, kind, filterIds) => ({ final: true, action: 'hide', reason, kind, filterIds: filterIds || [] });

  /**
   * Deterministic first pass. Returns a final decision, or { final: false, filters, useImage }
   * when the AI must classify the post.
   * tweet: { id, author, text, mediaText, hasMedia, hasImage, isVideo, imageUrls }
   * overrides: array of tweet ids the user said must stay visible.
   * hiddenIds: array of tweet ids the user hid with "Ocultar posts como este".
   */
  function preDecide(settings, tweet, overrides, hiddenIds) {
    if (!settings.enabled) return show();
    if (tweet.id && overrides && overrides.includes(tweet.id)) return show('corrected');
    if (tweet.id && hiddenIds && hiddenIds.includes(tweet.id)) return hide('Ocultado por vos', 'user', []);

    const author = normalizeHandle(tweet.author);
    if (author && settings.authors.allow.includes(author)) return show('author-allow');
    if (author && settings.authors.block.includes(author)) return hide(`Autor bloqueado: @${author}`, 'author', []);

    const m = settings.media;
    if (m.hideVideos && tweet.isVideo) return hide('Tiene video', 'media', []);
    if (m.hideImages && tweet.hasImage) return hide('Tiene imágenes', 'media', []);
    if (m.requireMedia && !tweet.hasMedia) return hide('Sin foto ni video', 'media', []);

    const filters = activeFilters(settings);
    if (filters.length === 0) return show();

    const hasText = Boolean((tweet.text || '').trim() || (tweet.mediaText || '').trim());
    const canUseImage = settings.analyzeImages && tweet.hasImage && (tweet.imageUrls || []).length > 0;

    if (!hasText) {
      if (canUseImage) return { final: false, filters, useImage: true };
      if (!tweet.hasMedia) return show();
      if (settings.uncaptioned === 'keep') return show();
      if (settings.uncaptioned === 'hide') return hide('Foto o video sin texto', 'media', []);
      // 'auto': with "Solo mostrar" filters we cannot prove a match, so hide; with only "Ocultar" filters, keep.
      const hasInclude = filters.some((f) => f.mode === 'include');
      return hasInclude ? hide('Foto o video sin texto (no se puede comprobar)', 'media', []) : show();
    }

    // Short text + image: the image probably carries the meaning.
    const shortText = ((tweet.text || '') + (tweet.mediaText || '')).trim().length < 60;
    return { final: false, filters, useImage: canUseImage && shortText };
  }

  /**
   * Second pass, after the model said which topics the post matches.
   * matches: { [filterId]: boolean }
   */
  function finalDecide(settings, filters, matches) {
    const excludeHits = filters.filter((f) => f.mode === 'exclude' && matches[f.id] === true);
    if (excludeHits.length) {
      return hide(`Coincide con “${excludeHits.map((f) => f.label).join('”, “')}”`, 'exclude', excludeHits.map((f) => f.id));
    }
    const includes = filters.filter((f) => f.mode === 'include');
    if (includes.length) {
      const hits = includes.filter((f) => matches[f.id] === true);
      if (settings.includeCombine === 'all' && hits.length < includes.length) {
        const missing = includes.filter((f) => matches[f.id] !== true);
        return hide(`No cumple “${missing.map((f) => f.label).join('”, “')}”`, 'include', missing.map((f) => f.id));
      }
      if (settings.includeCombine !== 'all' && hits.length === 0) {
        return hide(`No es de: ${includes.map((f) => f.label).join(', ')}`, 'include', includes.map((f) => f.id));
      }
      // Kept because it matched "Solo mostrar" topics: feeds the curated view.
      return { ...show(), matchedIds: hits.map((f) => f.id) };
    }
    return show();
  }

  /** True when a "No debía ocultarse" correction needs the user to pick the topic. */
  function needsTopicChoice(settings, decision) {
    return Boolean(
      decision && decision.kind === 'include' && settings.includeCombine !== 'all' && (decision.filterIds || []).length > 1
    );
  }

  /**
   * Turn a "No debía ocultarse" click into few-shot examples.
   * Returns the examples to store (may be empty, e.g. for author/media rules
   * or when several "Solo mostrar" filters make the right label ambiguous).
   */
  function correctionExamples(settings, decision, text, chosenFilterId) {
    const snippet = String(text || '').trim().slice(0, 280);
    if (!snippet || !decision || decision.action !== 'hide') return [];
    const byId = new Map((settings.filters || []).map((f) => [f.id, f]));
    if (decision.kind === 'exclude') {
      return decision.filterIds
        .map((id) => byId.get(id))
        .filter(Boolean)
        .map((f) => ({ text: snippet, filterPrompt: f.prompt, matches: false, at: Date.now() }));
    }
    if (decision.kind === 'include') {
      const ids = decision.filterIds;
      // Several "Solo mostrar" filters in 'any' mode: only the topic the user picked.
      if (chosenFilterId && ids.includes(chosenFilterId) && byId.get(chosenFilterId)) {
        return [{ text: snippet, filterPrompt: byId.get(chosenFilterId).prompt, matches: true, at: Date.now() }];
      }
      // With one "Solo mostrar" filter (or 'all'), the post must match each missing filter.
      if (ids.length === 1 || settings.includeCombine === 'all') {
        return ids
          .map((id) => byId.get(id))
          .filter(Boolean)
          .map((f) => ({ text: snippet, filterPrompt: f.prompt, matches: true, at: Date.now() }));
      }
    }
    return [];
  }

  /**
   * "Ocultar posts como este" on a visible post: few-shot example that makes the
   * model hide similar posts under the chosen filter.
   *  - exclude filter → the post IS about that topic (matches: true)
   *  - include filter → the post is NOT about that topic (matches: false)
   */
  function hideLikeExample(filter, text) {
    const snippet = String(text || '').trim().slice(0, 280);
    if (!snippet || !filter) return null;
    return { text: snippet, filterPrompt: filter.prompt, matches: filter.mode === 'exclude', at: Date.now(), source: 'hide-like' };
  }

  /** Filter created from a post when the model cannot suggest a topic. */
  function fallbackTopicFilter(post) {
    const snippet = String((post && (post.text || post.mediaText)) || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const who = post && post.author ? ` de @${post.author}` : '';
    return {
      id: `like-${Date.now()}`,
      label: (post && post.author ? `Como @${post.author}` : 'Como este post').slice(0, 30),
      prompt: snippet ? `posts sobre el mismo tema que este${who}: "${snippet}"` : `posts parecidos a este${who}`,
      mode: 'exclude',
      enabled: true
    };
  }

  function pushCapped(list, items, max, keyFn) {
    const out = Array.isArray(list) ? list.slice() : [];
    for (const item of items) {
      if (keyFn) {
        const k = keyFn(item);
        const idx = out.findIndex((x) => keyFn(x) === k);
        if (idx >= 0) out.splice(idx, 1);
      }
      out.push(item);
    }
    return out.slice(-max);
  }

  BonXai.rules = {
    DEFAULT_FILTERS,
    DEFAULT_SETTINGS,
    MAX_CORRECTIONS,
    MAX_OVERRIDES,
    MAX_FILTERED_LOG,
    MAX_HIDDEN_IDS,
    MAX_CURATED,
    needsTopicChoice,
    hideLikeExample,
    fallbackTopicFilter,
    normalizeHandle,
    parseHandleList,
    normalizeFilter,
    mergeSettings,
    isLocalEndpoint,
    activeFilters,
    preDecide,
    finalDecide,
    correctionExamples,
    pushCapped
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
