/**
 * BonXai Pruner - Curated feed (extension page / side panel).
 * Lists the posts that matched the user's "Solo mostrar" filters while browsing
 * x.com (stored locally by content.js in chrome.storage.local.curatedLog).
 * "No es de este tema" stores a few-shot correction and hides the post on x.com.
 */
(() => {
  'use strict';
  const { rules } = globalThis.BonXai;
  const $ = (id) => document.getElementById(id);

  let log = [];
  let settings = rules.mergeSettings(null);
  let activeTopic = null; // filter id or null = all

  function timeAgo(ts) {
    const m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return 'recién';
    if (m < 60) return `hace ${m} min`;
    const h = Math.round(m / 60);
    if (h < 24) return `hace ${h} h`;
    return `hace ${Math.round(h / 24)} d`;
  }

  function includeFilters() {
    return settings.filters.filter((f) => f.mode === 'include');
  }

  function renderChips() {
    const chips = $('chips');
    chips.textContent = '';
    const topics = includeFilters().filter((f) => log.some((it) => (it.filterIds || []).includes(f.id)));
    if (!topics.length) return;
    const mk = (label, id) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = label;
      b.setAttribute('aria-pressed', String(activeTopic === id));
      b.addEventListener('click', () => {
        activeTopic = id;
        render();
      });
      chips.appendChild(b);
    };
    mk('Todos', null);
    for (const f of topics) mk(f.label, f.id);
  }

  function visibleItems() {
    const q = $('search').value.trim().toLowerCase();
    return log
      .slice()
      .reverse()
      .filter((it) => !activeTopic || (it.filterIds || []).includes(activeTopic))
      .filter((it) => !q || `${it.text} ${it.author || ''} ${(it.labels || []).join(' ')}`.toLowerCase().includes(q));
  }

  async function removeItem(it) {
    const st = await chrome.storage.local.get({ curatedLog: [] });
    await chrome.storage.local.set({ curatedLog: st.curatedLog.filter((x) => (x.id || x.text) !== (it.id || it.text)) });
  }

  /** "No es de este tema": negative example for each matched "Solo mostrar" topic + hide it on x.com. */
  async function notThisTopic(it) {
    const byId = new Map(settings.filters.map((f) => [f.id, f]));
    const examples = (it.filterIds || []).map((id) => rules.hideLikeExample(byId.get(id), it.text)).filter(Boolean);
    const st = await chrome.storage.local.get({ corrections: [], hiddenIds: [] });
    await chrome.storage.local.set({
      corrections: rules.pushCapped(st.corrections, examples, rules.MAX_CORRECTIONS),
      hiddenIds: it.id ? rules.pushCapped(st.hiddenIds, [it.id], rules.MAX_HIDDEN_IDS, (x) => x) : st.hiddenIds
    });
    await removeItem(it);
  }

  function render() {
    renderChips();
    const items = visibleItems();
    $('count').textContent = log.length ? `${log.length} posts` : '';
    const list = $('list');
    list.textContent = '';
    const empty = $('empty');
    if (!items.length) {
      empty.hidden = false;
      empty.textContent = !includeFilters().some((f) => f.enabled)
        ? 'Activá al menos un filtro “Solo mostrar” en el popup y scrolleá x.com: acá van a aparecer los posts que coincidan.'
        : log.length
          ? 'Nada coincide con la búsqueda.'
          : 'Todavía no hay posts. Scrolleá x.com con BonXai activo.';
      return;
    }
    empty.hidden = true;
    for (const it of items) {
      const li = document.createElement('li');
      li.className = 'item';

      const meta = document.createElement('div');
      meta.className = 'meta';
      if (it.author) {
        const who = document.createElement('strong');
        who.textContent = '@' + it.author;
        meta.appendChild(who);
      }
      const when = document.createElement('span');
      when.textContent = timeAgo(it.at);
      meta.appendChild(when);
      for (const label of it.labels || []) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = label;
        meta.appendChild(tag);
      }

      const text = document.createElement('div');
      text.className = 'text';
      text.textContent = it.text || '(sin texto)';
      li.append(meta, text);

      if (it.image && /^https:\/\/pbs\.twimg\.com\//.test(it.image)) {
        const img = document.createElement('img');
        img.className = 'thumb';
        img.src = it.image;
        img.alt = '';
        img.loading = 'lazy';
        li.appendChild(img);
      }

      const actions = document.createElement('div');
      actions.className = 'actions';
      if (it.url) {
        const a = document.createElement('a');
        a.href = it.url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.className = 'link-btn';
        a.textContent = 'Ver en X';
        actions.appendChild(a);
      }
      const mkBtn = (label, fn) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'link-btn';
        b.textContent = label;
        b.addEventListener('click', fn);
        actions.appendChild(b);
      };
      mkBtn('No es de este tema', () => notThisTopic(it));
      mkBtn('Quitar', () => removeItem(it));
      li.appendChild(actions);
      list.appendChild(li);
    }
  }

  $('search').addEventListener('input', render);
  $('btnClear').addEventListener('click', () => chrome.storage.local.set({ curatedLog: [] }));

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.curatedLog) log = changes.curatedLog.newValue || [];
    if (changes.settings) settings = rules.mergeSettings(changes.settings.newValue);
    if (changes.curatedLog || changes.settings) render();
  });

  (async () => {
    const st = await chrome.storage.local.get(['curatedLog', 'settings']);
    log = Array.isArray(st.curatedLog) ? st.curatedLog : [];
    settings = rules.mergeSettings(st.settings);
    render();
  })();
})();
