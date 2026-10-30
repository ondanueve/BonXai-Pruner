/**
 * BonXai Pruner - Popup.
 * Edits structured settings (filters with explicit "Ocultar" / "Solo mostrar" mode,
 * media rules, author lists, engine), shows the real model status, lets the user
 * download Gemini Nano (needs a click), and lists recently hidden posts with a
 * one-click correction. Everything is stored in chrome.storage.local; content
 * scripts react to storage changes.
 */
(() => {
  'use strict';
  const { rules } = globalThis.BonXai;
  const $ = (id) => document.getElementById(id);

  let draft = rules.mergeSettings(null);
  let aiState = { state: 'checking', message: 'Revisando el modelo…', images: false };
  let stats = { pruned: 0 };
  let windowId = null;

  // ---------- rendering ----------
  function renderFilters() {
    const list = $('filterList');
    list.textContent = '';
    if (!draft.filters.length) {
      const li = document.createElement('li');
      li.innerHTML = '<span class="hint">No hay filtros. Agregá uno abajo.</span>';
      list.appendChild(li);
    }
    draft.filters.forEach((f) => {
      const li = document.createElement('li');

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = f.enabled;
      cb.title = 'Activar este filtro';
      cb.addEventListener('change', () => {
        f.enabled = cb.checked;
        pending();
      });

      const label = document.createElement('div');
      label.className = 'label';
      const strong = document.createElement('strong');
      strong.textContent = f.label;
      const small = document.createElement('small');
      small.textContent = f.prompt;
      small.title = f.prompt;
      label.append(strong, small);

      const mode = document.createElement('select');
      mode.innerHTML = '<option value="exclude">Ocultar</option><option value="include">Solo mostrar</option>';
      mode.value = f.mode;
      mode.addEventListener('change', () => {
        f.mode = mode.value;
        pending();
      });

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'icon-btn';
      del.textContent = '×';
      del.title = `Borrar “${f.label}”`;
      del.addEventListener('click', () => {
        draft.filters = draft.filters.filter((x) => x.id !== f.id);
        renderFilters();
        pending();
      });

      li.append(cb, label, mode, del);
      list.appendChild(li);
    });
  }

  function renderForm() {
    $('enabled').checked = draft.enabled;
    $('includeCombine').value = draft.includeCombine;
    $('hideImages').checked = draft.media.hideImages;
    $('hideVideos').checked = draft.media.hideVideos;
    $('requireMedia').checked = draft.media.requireMedia;
    $('analyzeImages').checked = draft.analyzeImages;
    $('uncaptioned').value = draft.uncaptioned;
    $('authorsAllow').value = draft.authors.allow.map((h) => '@' + h).join(' ');
    $('authorsBlock').value = draft.authors.block.map((h) => '@' + h).join(' ');
    $('hideStyle').value = draft.hideStyle;
    $('provider').value = draft.provider;
    $('ollamaEndpoint').value = draft.ollama.endpoint;
    $('ollamaModel').value = draft.ollama.model;
    $('ollamaFields').hidden = draft.provider !== 'ollama';
    renderFilters();
  }

  function readForm() {
    draft.enabled = $('enabled').checked;
    draft.includeCombine = $('includeCombine').value;
    draft.media = { hideImages: $('hideImages').checked, hideVideos: $('hideVideos').checked, requireMedia: $('requireMedia').checked };
    draft.analyzeImages = $('analyzeImages').checked;
    draft.uncaptioned = $('uncaptioned').value;
    draft.authors = { allow: rules.parseHandleList($('authorsAllow').value), block: rules.parseHandleList($('authorsBlock').value) };
    draft.hideStyle = $('hideStyle').value;
    draft.provider = $('provider').value;
    draft.ollama = { endpoint: $('ollamaEndpoint').value.trim() || rules.DEFAULT_SETTINGS.ollama.endpoint, model: $('ollamaModel').value.trim() || rules.DEFAULT_SETTINGS.ollama.model };
  }

  function renderAi() {
    const box = $('aiStatus');
    const s = aiState.state;
    box.className = 'ai-status ' + (s === 'ready' ? 'ok' : ['needs-download', 'downloading', 'checking'].includes(s) ? 'warn' : 'error');
    $('aiStatusText').textContent = aiState.message;
    const canDownload = draft.provider === 'nano' && (s === 'needs-download' || s === 'downloading');
    $('btnDownload').hidden = !canDownload;
    $('imagesHint').textContent = s === 'ready' ? (aiState.images ? '(soportado)' : '(este modelo no acepta imágenes: se usa solo texto)') : '';
    renderFooter();
  }

  function renderFooter() {
    const dot = $('statusDot');
    const msg = $('statusMessage');
    if (!draft.enabled) {
      dot.className = 'dot off';
      msg.textContent = 'Pausado';
    } else if (aiState.state === 'checking') {
      dot.className = 'dot warn';
      msg.textContent = 'Revisando el modelo…';
    } else if (aiState.state !== 'ready') {
      dot.className = ['needs-download', 'downloading'].includes(aiState.state) ? 'dot warn' : 'dot error';
      msg.textContent = 'Sin IA: solo se aplican reglas de autores y media';
    } else {
      dot.className = 'dot';
      msg.textContent = stats.pruned ? `Activo · ${stats.pruned} posts ocultados` : 'Activo en X';
    }
  }

  function renderFiltered(log) {
    const list = $('filteredList');
    list.textContent = '';
    const items = (log || []).slice().reverse().slice(0, 20);
    $('filteredCount').textContent = log && log.length ? `(${log.length})` : '';
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'hint';
      li.textContent = 'Todavía no se ocultó nada.';
      list.appendChild(li);
      return;
    }
    for (const it of items) {
      const li = document.createElement('li');
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = `${it.author ? '@' + it.author + ' · ' : ''}${it.reason}`;
      const text = document.createElement('div');
      text.textContent = it.text || '(sin texto)';
      const actions = document.createElement('div');
      actions.className = 'actions';
      if (it.url) {
        const a = document.createElement('a');
        a.href = it.url;
        a.target = '_blank';
        a.className = 'link-btn';
        a.textContent = 'Ver post';
        actions.appendChild(a);
      }
      const linkButton = (label, onClick) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'link-btn';
        b.textContent = label;
        b.addEventListener('click', () => onClick(b));
        return b;
      };
      const done = (el, text) => {
        const span = document.createElement('span');
        span.className = 'hint';
        span.textContent = text;
        el.replaceWith(span);
      };
      if (it.kind === 'user') {
        actions.appendChild(
          linkButton('Deshacer', async (b) => {
            const st = await chrome.storage.local.get({ hiddenIds: [] });
            await chrome.storage.local.set({ hiddenIds: st.hiddenIds.filter((x) => x !== it.id) });
            done(b, 'Deshecho ✓');
          })
        );
      } else if (it.kind === 'exclude' || it.kind === 'include' || it.kind === 'media') {
        const decision = { action: 'hide', kind: it.kind, filterIds: it.filterIds || [] };
        actions.appendChild(
          linkButton('No debía ocultarse', async (b) => {
            if (!rules.needsTopicChoice(draft, decision)) {
              await correctFromLog(it);
              return done(b, 'Corregido ✓');
            }
            // Several "Solo mostrar" filters in 'any' mode: ask which topic it belongs to.
            const byId = new Map(draft.filters.map((f) => [f.id, f]));
            const row = document.createElement('div');
            row.className = 'choices';
            row.append('¿De qué tema es?');
            for (const id of decision.filterIds) {
              const f = byId.get(id);
              if (f) row.appendChild(linkButton(f.label, async () => { await correctFromLog(it, f.id); done(row, `Corregido como “${f.label}” ✓`); }));
            }
            row.appendChild(linkButton('De ninguno', async () => { await correctFromLog(it, null); done(row, 'Queda visible ✓'); }));
            b.replaceWith(row);
          })
        );
      }
      li.append(meta, text, actions);
      list.appendChild(li);
    }
  }

  async function renderCorrections() {
    const { corrections } = await chrome.storage.local.get({ corrections: [] });
    $('correctionsInfo').textContent = `${corrections.length} corrección(es) guardadas como ejemplos`;
  }

  function pending() {
    $('applyMsg').textContent = 'Cambios sin aplicar: tocá “Aplicar”.';
    $('applyMsg').style.color = '#f59e0b';
  }

  // ---------- actions ----------
  async function correctFromLog(it, chosenFilterId) {
    const st = await chrome.storage.local.get({ corrections: [], overrides: [] });
    const examples = rules.correctionExamples(draft, { action: 'hide', kind: it.kind, filterIds: it.filterIds || [] }, it.text, chosenFilterId);
    await chrome.storage.local.set({
      corrections: rules.pushCapped(st.corrections, examples, rules.MAX_CORRECTIONS),
      overrides: it.id ? rules.pushCapped(st.overrides, [it.id], rules.MAX_OVERRIDES, (x) => x) : st.overrides
    });
    renderCorrections();
  }

  async function checkAi() {
    try {
      const res = await chrome.runtime.sendMessage({ action: 'CHECK_AI' });
      aiState = res && res.state ? res : { state: 'error', message: 'No se pudo consultar el estado del modelo.' };
    } catch (err) {
      aiState = { state: 'error', message: 'No se pudo hablar con el service worker de la extensión.' };
    }
    renderAi();
  }

  async function nanoOptions() {
    for (const langs of [['en', 'es'], ['en']]) {
      const options = { expectedInputs: [{ type: 'text', languages: langs }], expectedOutputs: [{ type: 'text', languages: ['en'] }] };
      try {
        if ((await LanguageModel.availability(options)) !== 'unavailable') return options;
      } catch {
        // try next
      }
    }
    return null;
  }

  $('btnDownload').addEventListener('click', async () => {
    if (typeof LanguageModel === 'undefined') return;
    const btn = $('btnDownload');
    btn.disabled = true;
    aiState = { state: 'downloading', message: 'Descargando Gemini Nano… 0%' };
    renderAi();
    try {
      const options = await nanoOptions();
      if (!options) throw new Error('el modelo no está disponible en este equipo');
      // create() needs a user gesture to start the download: this click provides it.
      const session = await LanguageModel.create({
        ...options,
        monitor(m) {
          m.addEventListener('downloadprogress', (e) => {
            aiState = { state: 'downloading', message: `Descargando Gemini Nano… ${Math.round((e.loaded || 0) * 100)}%` };
            renderAi();
          });
        }
      });
      session.destroy();
      await chrome.runtime.sendMessage({ action: 'RESET_AI' });
    } catch (err) {
      aiState = { state: 'error', message: `Falló la descarga: ${err && err.message ? err.message : err}` };
      renderAi();
    } finally {
      btn.disabled = false;
      if (aiState.state !== 'error') await checkAi();
    }
  });

  $('addFilter').addEventListener('submit', (e) => {
    e.preventDefault();
    const prompt = $('newPrompt').value.trim();
    if (!prompt) {
      $('newPrompt').focus();
      return;
    }
    const f = rules.normalizeFilter(
      { id: `custom-${Date.now()}`, label: $('newLabel').value.trim() || prompt.slice(0, 24), prompt, mode: $('newMode').value, enabled: true },
      draft.filters.length
    );
    draft.filters.push(f);
    $('newPrompt').value = '';
    $('newLabel').value = '';
    renderFilters();
    pending();
  });

  for (const id of ['includeCombine', 'hideImages', 'hideVideos', 'requireMedia', 'analyzeImages', 'uncaptioned', 'authorsAllow', 'authorsBlock', 'hideStyle', 'ollamaEndpoint', 'ollamaModel']) {
    $(id).addEventListener('input', pending);
    $(id).addEventListener('change', pending);
  }
  $('provider').addEventListener('change', () => {
    $('ollamaFields').hidden = $('provider').value !== 'ollama';
    pending();
  });

  $('enabled').addEventListener('change', async () => {
    const st = await chrome.storage.local.get(['settings']);
    const s = rules.mergeSettings(st.settings);
    s.enabled = $('enabled').checked;
    draft.enabled = s.enabled;
    await chrome.storage.local.set({ settings: s });
    renderFooter();
  });

  $('btnApply').addEventListener('click', async () => {
    readForm();
    const msg = $('applyMsg');
    if (draft.provider === 'ollama') {
      if (!rules.isLocalEndpoint(draft.ollama.endpoint)) {
        msg.textContent = 'El endpoint tiene que ser http://localhost o http://127.0.0.1 (nada en la nube).';
        msg.style.color = '#f87171';
        return;
      }
      // Must run inside the click gesture.
      const origin = `${new URL(draft.ollama.endpoint).protocol}//${new URL(draft.ollama.endpoint).hostname}/*`;
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) {
        msg.textContent = 'Sin permiso para hablar con el servidor local: se sigue usando Gemini Nano.';
        msg.style.color = '#f87171';
        draft.provider = 'nano';
        $('provider').value = 'nano';
        $('ollamaFields').hidden = true;
      }
    }
    await chrome.storage.local.set({ settings: draft });
    msg.textContent = 'Aplicado al feed.';
    msg.style.color = '#34d399';
    await chrome.runtime.sendMessage({ action: 'RESET_AI' }).catch(() => {});
    checkAi();
  });

  $('btnClearCorrections').addEventListener('click', async () => {
    await chrome.storage.local.set({ corrections: [] });
    renderCorrections();
  });

  $('btnClearCache').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ action: 'CLEAR_CACHE' }).catch(() => {});
    $('applyMsg').textContent = 'Caché vaciada.';
    $('applyMsg').style.color = '#34d399';
  });

  // Curated feed: side panel when available (keeps x.com visible), otherwise a tab.
  $('btnFeed').addEventListener('click', () => {
    if (chrome.sidePanel && chrome.sidePanel.open && windowId != null) {
      chrome.sidePanel.open({ windowId }).then(() => window.close()).catch(() => chrome.tabs.create({ url: chrome.runtime.getURL('feed.html') }));
    } else {
      chrome.tabs.create({ url: chrome.runtime.getURL('feed.html') });
    }
  });

  function renderCuratedCount(log) {
    $('curatedCount').textContent = log && log.length ? `(${log.length})` : '';
  }

  $('btnClearLog').addEventListener('click', async () => {
    await chrome.storage.local.set({ filteredLog: [] });
    renderFiltered([]);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.filteredLog) renderFiltered(changes.filteredLog.newValue);
    if (changes.curatedLog) renderCuratedCount(changes.curatedLog.newValue);
    if (changes.stats) {
      stats = changes.stats.newValue || stats;
      renderFooter();
    }
    if (changes.aiStatus && changes.aiStatus.newValue && changes.aiStatus.newValue.state === 'error') {
      aiState = changes.aiStatus.newValue;
      renderAi();
    }
  });

  // ---------- init ----------
  (async () => {
    $('version').textContent = 'v' + chrome.runtime.getManifest().version;
    const st = await chrome.storage.local.get(null);
    draft = rules.mergeSettings(st.settings, st);
    stats = st.stats || stats;
    renderForm();
    renderAi();
    renderFiltered(st.filteredLog || []);
    renderCuratedCount(st.curatedLog || []);
    if (chrome.windows && chrome.windows.getCurrent) {
      chrome.windows.getCurrent().then((w) => (windowId = w.id)).catch(() => {});
    }
    renderCorrections();
    checkAi();
  })();
})();
