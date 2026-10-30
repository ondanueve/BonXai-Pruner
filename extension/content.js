/**
 * BonXai Pruner - Content script for x.com / twitter.com.
 *
 * 1. Watches the timeline for new <article> posts (MutationObserver).
 * 2. Applies deterministic rules first (authors, media, uncaptioned posts) without AI.
 * 3. Otherwise blurs the post while the background worker asks the model, then
 *    collapses it into a one-line bar with the reason and a "Mostrar" button.
 * 4. Visible posts get a discreet "Ocultar posts como este" button that teaches the
 *    model (few-shot example) or creates a new filter from the post.
 * 5. Posts kept by "Solo mostrar" filters are logged for the curated feed (feed.html).
 * 6. Fail-open: if the model is missing or errors, the post stays visible.
 *
 * Depends on lib/rules.js and lib/tweet.js (loaded before this file by the manifest).
 */
(() => {
  'use strict';
  const { rules, tweet: tweetLib } = globalThis.BonXai;

  const STATUS_ATTR = 'data-bonxai-status';
  const ID_ATTR = 'data-bonxai-id';
  const S = { QUEUED: 'queued', EVALUATING: 'evaluating', KEPT: 'kept', PRUNED: 'pruned', REVEALED: 'revealed', SKIPPED: 'skipped' };
  const MAX_CONCURRENT = 2;
  const AI_PAUSE_MS = 30000;

  let settings = rules.mergeSettings(null);
  let overrides = [];
  let hiddenIds = [];
  let ready = false;
  let aiPausedUntil = 0;
  let generation = 0; // bumps on settings change so stale answers are ignored
  let activeWorkers = 0;
  const queue = [];
  const decisions = new WeakMap(); // article -> { post, decision }

  // ---------- styles ----------
  function injectStyles() {
    if (document.getElementById('bonxai-style')) return;
    const style = document.createElement('style');
    style.id = 'bonxai-style';
    style.textContent = `
      article.bonxai-pending { position: relative; }
      article.bonxai-pending > :not(.bonxai-bar) { filter: blur(6px); opacity: .55; pointer-events: none; transition: filter .15s ease; }
      article.bonxai-pending::after { content: 'BonXai evaluando…'; position: absolute; top: 10px; right: 14px; z-index: 2;
        font: 600 11px/1 system-ui, sans-serif; color: #10b981; background: rgba(15, 23, 42, .85); padding: 4px 8px; border-radius: 999px; }
      article.bonxai-collapsed > :not(.bonxai-bar) { display: none !important; }
      article.bonxai-removed { display: none !important; }
      .bonxai-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; padding: 10px 16px;
        font: 13px/1.4 system-ui, sans-serif; color: rgb(113, 118, 123); cursor: default; }
      .bonxai-bar .bonxai-reason { flex: 1 1 200px; min-width: 0; }
      .bonxai-bar button { background: transparent; border: 1px solid rgba(113, 118, 123, .5); color: inherit;
        border-radius: 999px; padding: 2px 10px; font: inherit; cursor: pointer; }
      .bonxai-bar button:hover { border-color: #10b981; color: #10b981; }
      .bonxai-bar button.bonxai-primary { border-color: #10b981; color: #10b981; }
      .bonxai-note { font-size: 12px; color: #10b981; }
      .bonxai-mini { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; padding: 0 16px 6px;
        font: 12px/1.4 system-ui, sans-serif; color: rgb(113, 118, 123); opacity: 0; transition: opacity .15s ease; }
      article:hover .bonxai-mini, .bonxai-mini:focus-within, .bonxai-mini.bonxai-open { opacity: 1; }
      .bonxai-mini button, .bonxai-choices button { background: transparent; border: 1px solid rgba(113, 118, 123, .4); color: inherit;
        border-radius: 999px; padding: 1px 9px; font: inherit; cursor: pointer; }
      .bonxai-mini button:hover, .bonxai-choices button:hover { border-color: #10b981; color: #10b981; }
      .bonxai-choices { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; width: 100%; justify-content: flex-end; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  // ---------- applying decisions ----------
  function removeBar(article) {
    const bar = article.querySelector(':scope > .bonxai-bar');
    if (bar) bar.remove();
  }

  function clearVisualState(article) {
    article.classList.remove('bonxai-pending', 'bonxai-collapsed', 'bonxai-removed');
    removeBar(article);
    const mini = article.querySelector(':scope > .bonxai-mini');
    if (mini) mini.remove();
  }

  /** Replace the content of `container` with a row of choice buttons. */
  function showChoices(container, title, choices) {
    container.textContent = '';
    const row = document.createElement('div');
    row.className = 'bonxai-choices';
    const label = document.createElement('span');
    label.textContent = title;
    row.appendChild(label);
    for (const c of choices) row.appendChild(button(c.label, c.onClick, c.primary));
    container.appendChild(row);
  }

  function setPending(article, on) {
    article.classList.toggle('bonxai-pending', on);
  }

  function button(label, onClick, primary) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (primary) b.className = 'bonxai-primary';
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick(b);
    });
    return b;
  }

  function reveal(article, note) {
    clearVisualState(article);
    article.setAttribute(STATUS_ATTR, S.REVEALED);
    if (note) {
      const bar = document.createElement('div');
      bar.className = 'bonxai-bar';
      const span = document.createElement('span');
      span.className = 'bonxai-note';
      span.textContent = note;
      bar.appendChild(span);
      bar.addEventListener('click', (e) => e.stopPropagation());
      article.prepend(bar);
      setTimeout(() => bar.remove(), 4000);
    }
  }

  function buildBar(article, post, decision) {
    const bar = document.createElement('div');
    bar.className = 'bonxai-bar';
    bar.setAttribute('role', 'note');
    bar.addEventListener('click', (e) => e.stopPropagation());

    const reason = document.createElement('span');
    reason.className = 'bonxai-reason';
    reason.textContent = `✂ BonXai ocultó un post${post.author ? ` de @${post.author}` : ''} · ${decision.reason}`;
    bar.appendChild(reason);

    bar.appendChild(button('Mostrar', () => reveal(article), true));

    if (decision.kind === 'user') {
      bar.appendChild(button('Deshacer', () => undoHide(article, post)));
    } else if (decision.kind === 'author') {
      bar.appendChild(button(`Desbloquear @${post.author}`, () => updateAuthors(post.author, 'unblock')));
    } else {
      bar.appendChild(
        button('No debía ocultarse', () => {
          if (!rules.needsTopicChoice(settings, decision)) return correct(article, post, decision);
          // Several "Solo mostrar" filters in 'any' mode: ask which topic the post belongs to.
          const byId = new Map(settings.filters.map((f) => [f.id, f]));
          showChoices(bar, '¿De qué tema es?', [
            ...decision.filterIds
              .map((id) => byId.get(id))
              .filter(Boolean)
              .map((f) => ({ label: f.label, onClick: () => correct(article, post, decision, f.id) })),
            { label: 'De ninguno, solo mostralo', onClick: () => correct(article, post, decision, null) }
          ]);
        })
      );
      if (post.author) bar.appendChild(button(`Nunca filtrar a @${post.author}`, () => updateAuthors(post.author, 'allow')));
    }
    return bar;
  }

  function buildMini(article, post) {
    const mini = document.createElement('div');
    mini.className = 'bonxai-mini';
    mini.addEventListener('click', (e) => e.stopPropagation());
    const open = () => {
      mini.classList.add('bonxai-open');
      const active = rules.activeFilters(settings);
      const choices = active.map((f) => ({
        label: f.mode === 'exclude' ? `Es “${f.label}”` : `No es “${f.label}”`,
        onClick: () => hideLike(article, post, f)
      }));
      choices.push({ label: '+ Nuevo filtro con este tema', onClick: (b) => hideLikeNewFilter(article, post, b), primary: true });
      choices.push({ label: 'Cancelar', onClick: () => reset() });
      showChoices(mini, 'Ocultar posts como este:', choices);
    };
    const reset = () => {
      mini.classList.remove('bonxai-open');
      mini.textContent = '';
      mini.appendChild(button('✂ Ocultar posts como este', open));
    };
    reset();
    return mini;
  }

  function apply(article, post, decision) {
    clearVisualState(article);
    decisions.set(article, { post, decision });
    if (decision.action === 'show') {
      article.setAttribute(STATUS_ATTR, S.KEPT);
      if (settings.enabled) article.appendChild(buildMini(article, post));
      if (decision.matchedIds && decision.matchedIds.length) logCurated(post, decision.matchedIds);
      return;
    }
    article.setAttribute(STATUS_ATTR, S.PRUNED);
    if (settings.hideStyle === 'remove') {
      article.classList.add('bonxai-removed');
    } else {
      article.classList.add('bonxai-collapsed');
      article.prepend(buildBar(article, post, decision));
    }
    logFiltered(post, decision);
  }

  // ---------- storage writes (corrections, authors, log) ----------
  async function correct(article, post, decision, chosenFilterId) {
    const st = await chrome.storage.local.get({ corrections: [], overrides: [] });
    const examples = rules.correctionExamples(settings, decision, [post.text, post.mediaText].filter(Boolean).join('\n'), chosenFilterId);
    const update = {
      corrections: rules.pushCapped(st.corrections, examples, rules.MAX_CORRECTIONS),
      overrides: post.id ? rules.pushCapped(st.overrides, [post.id], rules.MAX_OVERRIDES, (x) => x) : st.overrides
    };
    await chrome.storage.local.set(update);
    reveal(article, examples.length ? 'Gracias: lo uso como ejemplo para los próximos posts.' : 'Listo: este post queda visible.');
  }

  const postText = (post) => [post.text, post.mediaText].filter(Boolean).join('\n');

  function hideNow(article, post) {
    apply(article, post, { action: 'hide', reason: 'Ocultado por vos', kind: 'user', filterIds: [] });
  }

  async function rememberHidden(post) {
    if (!post.id) return;
    const st = await chrome.storage.local.get({ hiddenIds: [], overrides: [] });
    await chrome.storage.local.set({
      hiddenIds: rules.pushCapped(st.hiddenIds, [post.id], rules.MAX_HIDDEN_IDS, (x) => x),
      overrides: st.overrides.filter((x) => x !== post.id)
    });
  }

  /** "Ocultar posts como este" → few-shot example for an existing filter. */
  async function hideLike(article, post, filter) {
    const example = rules.hideLikeExample(filter, postText(post));
    const st = await chrome.storage.local.get({ corrections: [] });
    if (example) await chrome.storage.local.set({ corrections: rules.pushCapped(st.corrections, [example], rules.MAX_CORRECTIONS) });
    await rememberHidden(post);
    hideNow(article, post);
  }

  /** "Ocultar posts como este" → new "Ocultar" filter, topic suggested by the local model. */
  async function hideLikeNewFilter(article, post, btn) {
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Pensando un nombre…';
    }
    let filter = rules.fallbackTopicFilter(post);
    try {
      const res = await chrome.runtime.sendMessage({ action: 'SUGGEST_TOPIC', post });
      if (res && res.ok && res.topic) filter = { ...filter, label: res.label, prompt: res.topic };
    } catch {
      // model unavailable: keep the fallback filter
    }
    const st = await chrome.storage.local.get(['settings', 'corrections']);
    const s = rules.mergeSettings(st.settings);
    s.filters.push(filter);
    const example = rules.hideLikeExample(filter, postText(post));
    await rememberHidden(post);
    await chrome.storage.local.set({
      corrections: rules.pushCapped(st.corrections || [], example ? [example] : [], rules.MAX_CORRECTIONS),
      settings: s // triggers a rescan with the new filter
    });
  }

  async function undoHide(article, post) {
    const st = await chrome.storage.local.get({ hiddenIds: [] });
    await chrome.storage.local.set({ hiddenIds: st.hiddenIds.filter((x) => x !== post.id) });
    clearVisualState(article);
    article.removeAttribute(STATUS_ATTR);
    scan();
  }

  async function updateAuthors(handle, op) {
    const h = rules.normalizeHandle(handle);
    if (!h) return;
    const st = await chrome.storage.local.get(['settings']);
    const s = rules.mergeSettings(st.settings);
    s.authors.allow = s.authors.allow.filter((x) => x !== h);
    s.authors.block = s.authors.block.filter((x) => x !== h);
    if (op === 'allow') s.authors.allow.push(h);
    if (op === 'block') s.authors.block.push(h);
    await chrome.storage.local.set({ settings: s }); // triggers a rescan via storage.onChanged
  }

  let pendingLog = [];
  let logTimer = null;
  function logFiltered(post, decision) {
    pendingLog.push({
      id: post.id || null,
      author: post.author || null,
      url: post.url || null,
      text: [post.text, post.mediaText].filter(Boolean).join(' ').slice(0, 160),
      reason: decision.reason,
      kind: decision.kind,
      filterIds: decision.filterIds || [],
      at: Date.now()
    });
    if (logTimer) return;
    logTimer = setTimeout(async () => {
      logTimer = null;
      const items = pendingLog;
      pendingLog = [];
      const st = await chrome.storage.local.get({ filteredLog: [], stats: { pruned: 0 } });
      await chrome.storage.local.set({
        filteredLog: rules.pushCapped(st.filteredLog, items, rules.MAX_FILTERED_LOG, (x) => x.id || x.text),
        stats: { pruned: (st.stats.pruned || 0) + items.length }
      });
    }, 500);
  }

  let pendingCurated = [];
  let curatedTimer = null;
  function logCurated(post, matchedIds) {
    if (!post.id && !post.text) return;
    const byId = new Map(settings.filters.map((f) => [f.id, f]));
    pendingCurated.push({
      id: post.id || null,
      author: post.author || null,
      url: post.url || null,
      text: postText(post).slice(0, 500),
      image: (post.imageUrls || [])[0] || null,
      filterIds: matchedIds,
      labels: matchedIds.map((id) => (byId.get(id) || {}).label).filter(Boolean),
      at: Date.now()
    });
    if (curatedTimer) return;
    curatedTimer = setTimeout(async () => {
      curatedTimer = null;
      const items = pendingCurated;
      pendingCurated = [];
      const st = await chrome.storage.local.get({ curatedLog: [] });
      await chrome.storage.local.set({ curatedLog: rules.pushCapped(st.curatedLog, items, rules.MAX_CURATED, (x) => x.id || x.text) });
    }, 500);
  }

  // ---------- evaluation ----------
  async function askModel(post, filters, useImage) {
    if (Date.now() < aiPausedUntil) return null;
    try {
      const res = await chrome.runtime.sendMessage({ action: 'CLASSIFY', post, filters, useImage });
      if (res && res.ok) return res.matches;
      if (res && res.state && res.state !== 'error') aiPausedUntil = Date.now() + AI_PAUSE_MS;
      return null;
    } catch (err) {
      console.warn('[BonXai Pruner] Could not reach background worker:', err);
      return null;
    }
  }

  async function evaluate(article) {
    const gen = generation;
    const post = tweetLib.extractTweet(article);
    article.setAttribute(ID_ATTR, post.id || '');

    const pre = rules.preDecide(settings, post, overrides, hiddenIds);
    if (pre.final) {
      apply(article, post, pre);
      return;
    }

    article.setAttribute(STATUS_ATTR, S.EVALUATING);
    setPending(article, true);
    const matches = await askModel(post, pre.filters, pre.useImage);
    if (gen !== generation) return; // settings changed meanwhile; article was reset
    setPending(article, false);

    if (!matches) {
      article.setAttribute(STATUS_ATTR, S.SKIPPED); // fail-open
      return;
    }
    apply(article, post, rules.finalDecide(settings, pre.filters, matches));
  }

  function processQueue() {
    while (activeWorkers < MAX_CONCURRENT && queue.length) {
      const article = queue.shift();
      if (!article || !article.isConnected || article.getAttribute(STATUS_ATTR) !== S.QUEUED) continue;
      activeWorkers++;
      evaluate(article)
        .catch((err) => {
          console.warn('[BonXai Pruner] Evaluation error:', err);
          setPending(article, false);
          article.setAttribute(STATUS_ATTR, S.SKIPPED);
        })
        .finally(() => {
          activeWorkers--;
          processQueue();
        });
    }
  }

  function currentId(article) {
    const link = article.querySelector('time') && article.querySelector('time').closest('a[href*="/status/"]');
    const m = link && (link.getAttribute('href') || '').match(/\/status\/(\d+)/);
    return m ? m[1] : '';
  }

  function scan() {
    if (!ready) return;
    for (const article of document.querySelectorAll('article')) {
      const status = article.getAttribute(STATUS_ATTR);
      if (status && status !== S.QUEUED && status !== S.EVALUATING) {
        // X may recycle an <article> for a different post: re-evaluate if the id changed.
        if (article.getAttribute(ID_ATTR) !== currentId(article)) {
          clearVisualState(article);
          article.removeAttribute(STATUS_ATTR);
        } else {
          continue;
        }
      }
      if (status === S.QUEUED || status === S.EVALUATING) continue;
      article.setAttribute(STATUS_ATTR, S.QUEUED);
      queue.push(article);
    }
    processQueue();
  }

  function resetAll() {
    generation++;
    queue.length = 0;
    for (const article of document.querySelectorAll(`article[${STATUS_ATTR}]`)) {
      clearVisualState(article);
      article.removeAttribute(STATUS_ATTR);
    }
    aiPausedUntil = 0;
    scan();
  }

  let scanTimer = null;
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, 80);
  }

  // ---------- wiring ----------
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.settings) {
      settings = rules.mergeSettings(changes.settings.newValue);
      resetAll();
    }
    if (changes.overrides) {
      overrides = changes.overrides.newValue || [];
      for (const article of document.querySelectorAll(`article[${STATUS_ATTR}="${S.PRUNED}"]`)) {
        const id = article.getAttribute(ID_ATTR);
        if (id && overrides.includes(id)) reveal(article);
      }
    }
    if (changes.hiddenIds) {
      hiddenIds = changes.hiddenIds.newValue || [];
    }
    if (changes.aiStatus && changes.aiStatus.newValue && changes.aiStatus.newValue.state === 'ready' && aiPausedUntil) {
      // Model became ready (e.g. download finished): retry posts skipped meanwhile.
      aiPausedUntil = 0;
      for (const article of document.querySelectorAll(`article[${STATUS_ATTR}="${S.SKIPPED}"]`)) article.removeAttribute(STATUS_ATTR);
      scan();
    }
  });

  async function init() {
    injectStyles();
    const st = await chrome.storage.local.get(['settings', 'overrides', 'hiddenIds', 'savedPrunings', 'extensionEnabled', 'uncaptionedPolicy']);
    settings = rules.mergeSettings(st.settings, st);
    overrides = Array.isArray(st.overrides) ? st.overrides : [];
    hiddenIds = Array.isArray(st.hiddenIds) ? st.hiddenIds : [];
    ready = true;
    scan();
    new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.addedNodes && m.addedNodes.length) {
          scheduleScan();
          return;
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  // Exposed for tests only.
  globalThis.BonXai.content = { scan, resetAll, ready: () => ready };

  init();
})();
