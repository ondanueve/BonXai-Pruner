import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDom, articleHtml, loadIntoWindow } from './helpers/dom.mjs';
import { createChromeMock, tick } from './helpers/chrome.mjs';

const POL = { id: 'pol', label: 'Sin política', prompt: 'política', mode: 'exclude', enabled: true };

async function boot({ html, settings = {}, classify, overrides } = {}) {
  const dom = makeDom(html);
  const sent = [];
  const { chrome, data } = createChromeMock({
    onSendMessage: async (msg) => {
      sent.push(msg);
      return classify ? classify(msg) : { ok: true, matches: {} };
    }
  });
  data.settings = { filters: [POL], ...settings };
  if (overrides) data.overrides = overrides;
  dom.window.chrome = chrome;
  loadIntoWindow(dom.window, ['lib/rules.js', 'lib/tweet.js', 'content.js']);
  await tick(20);
  return { dom, doc: dom.window.document, data, sent, chrome };
}

const settle = () => tick(30);

test('hidden posts collapse into a bar with the reason and a "Mostrar" button', async () => {
  const { doc } = await boot({
    html: articleHtml({ id: '1', text: 'Votá el domingo' }),
    classify: async () => ({ ok: true, matches: { pol: true } })
  });
  await settle();
  const article = doc.querySelector('article');
  assert.equal(article.getAttribute('data-bonxai-status'), 'pruned');
  assert.ok(article.classList.contains('bonxai-collapsed'));
  const bar = article.querySelector('.bonxai-bar');
  assert.match(bar.textContent, /@ana · Coincide con “Sin política”/);
  const buttons = [...bar.querySelectorAll('button')].map((b) => b.textContent);
  assert.deepEqual(buttons, ['Mostrar', 'No debía ocultarse', 'Nunca filtrar a @ana']);
  bar.querySelector('button').click();
  assert.ok(!article.classList.contains('bonxai-collapsed'));
  assert.equal(article.querySelector('.bonxai-bar'), null);
});

test('posts are blurred (pending) while the model answers', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { doc } = await boot({
    html: articleHtml({ id: '2', text: 'algo' }),
    classify: async () => {
      await gate;
      return { ok: true, matches: { pol: false } };
    }
  });
  await settle();
  const article = doc.querySelector('article');
  assert.ok(article.classList.contains('bonxai-pending'));
  release();
  await settle();
  assert.ok(!article.classList.contains('bonxai-pending'));
  assert.equal(article.getAttribute('data-bonxai-status'), 'kept');
});

test('fail-open: model errors leave the post visible', async () => {
  const { doc } = await boot({ html: articleHtml({ id: '3' }), classify: async () => ({ ok: false, state: 'unavailable' }) });
  await settle();
  const article = doc.querySelector('article');
  assert.equal(article.getAttribute('data-bonxai-status'), 'skipped');
  assert.ok(!article.classList.contains('bonxai-collapsed'));
  assert.ok(!article.classList.contains('bonxai-pending'));
});

test('"No debía ocultarse" stores a few-shot correction and an override', async () => {
  const { doc, data } = await boot({
    html: articleHtml({ id: '4', text: 'Mi abuela votó a los 90' }),
    classify: async () => ({ ok: true, matches: { pol: true } })
  });
  await settle();
  const btn = [...doc.querySelectorAll('.bonxai-bar button')].find((b) => b.textContent === 'No debía ocultarse');
  btn.click();
  await settle();
  assert.deepEqual(data.overrides, ['4']);
  assert.equal(data.corrections.length, 1);
  assert.deepEqual([data.corrections[0].filterPrompt, data.corrections[0].matches], ['política', false]);
  assert.equal(doc.querySelector('article').getAttribute('data-bonxai-status'), 'revealed');
});

test('blocked authors are hidden without calling the model; allowed authors are never filtered', async () => {
  const { doc, sent } = await boot({
    html: articleHtml({ id: '5', author: 'troll' }) + articleHtml({ id: '6', author: 'amiga' }),
    settings: { authors: { block: ['troll'], allow: ['amiga'] } }
  });
  await settle();
  const [a, b] = doc.querySelectorAll('article');
  assert.equal(a.getAttribute('data-bonxai-status'), 'pruned');
  assert.match(a.querySelector('.bonxai-bar').textContent, /Autor bloqueado: @troll/);
  assert.equal(b.getAttribute('data-bonxai-status'), 'kept');
  assert.equal(sent.length, 0);
});

test('hideStyle "remove" hides the post entirely', async () => {
  const { doc } = await boot({
    html: articleHtml({ id: '7' }),
    settings: { hideStyle: 'remove' },
    classify: async () => ({ ok: true, matches: { pol: true } })
  });
  await settle();
  const article = doc.querySelector('article');
  assert.ok(article.classList.contains('bonxai-removed'));
  assert.equal(article.querySelector('.bonxai-bar'), null);
});

test('hidden posts are logged for the popup list', async () => {
  const { data } = await boot({ html: articleHtml({ id: '8', text: 'debate' }), classify: async () => ({ ok: true, matches: { pol: true } }) });
  await tick(700);
  assert.equal(data.filteredLog.length, 1);
  assert.equal(data.filteredLog[0].id, '8');
  assert.equal(data.filteredLog[0].kind, 'exclude');
  assert.equal(data.stats.pruned, 1);
});

test('changing settings re-evaluates the feed; overrides reveal posts live', async () => {
  let pol = true;
  const { doc, chrome, data } = await boot({
    html: articleHtml({ id: '9' }) + articleHtml({ id: '10' }),
    classify: async (msg) => ({ ok: true, matches: { pol: msg.post.id === '9' ? pol : false } })
  });
  await settle();
  const [a] = doc.querySelectorAll('article');
  assert.equal(a.getAttribute('data-bonxai-status'), 'pruned');
  await chrome.storage.local.set({ overrides: ['9'] });
  assert.equal(a.getAttribute('data-bonxai-status'), 'revealed');
  pol = false;
  await chrome.storage.local.set({ overrides: [], settings: { ...data.settings, includeCombine: 'all' } });
  await settle();
  assert.equal(a.getAttribute('data-bonxai-status'), 'kept');
});

test('new posts added later (infinite scroll) are picked up', async () => {
  const { doc, dom } = await boot({ html: '', classify: async () => ({ ok: true, matches: { pol: true } }) });
  doc.querySelector('main').insertAdjacentHTML('beforeend', articleHtml({ id: '11' }));
  await tick(200);
  assert.equal(doc.querySelector('article').getAttribute('data-bonxai-status'), 'pruned');
  dom.window.close();
});

const TECH = { id: 'tech', label: 'Tech', prompt: 'tecnología', mode: 'include', enabled: true };
const MESSI = { id: 'messi', label: 'Messi', prompt: 'Messi', mode: 'include', enabled: true };
const clickText = (root, text) => {
  const b = [...root.querySelectorAll('button')].find((x) => x.textContent === text);
  assert.ok(b, `button "${text}"`);
  b.click();
};

test('"Ocultar posts como este" on a kept post stores an example, hides it and can be undone', async () => {
  const { doc, data } = await boot({ html: articleHtml({ id: '20', text: 'Votá a Pérez' }), classify: async () => ({ ok: true, matches: { pol: false } }) });
  await settle();
  const article = doc.querySelector('article');
  assert.equal(article.getAttribute('data-bonxai-status'), 'kept');
  clickText(article, '✂ Ocultar posts como este');
  clickText(article, 'Es “Sin política”');
  await settle();
  assert.deepEqual(data.hiddenIds, ['20']);
  assert.deepEqual([data.corrections[0].text, data.corrections[0].filterPrompt, data.corrections[0].matches], ['Votá a Pérez', 'política', true]);
  assert.ok(article.classList.contains('bonxai-collapsed'));
  assert.match(article.querySelector('.bonxai-bar').textContent, /Ocultado por vos/);
  clickText(article.querySelector('.bonxai-bar'), 'Deshacer');
  await settle();
  assert.deepEqual(data.hiddenIds, []);
  assert.equal(article.getAttribute('data-bonxai-status'), 'kept');
});

test('"Nuevo filtro con este tema" uses the model suggestion, or a fallback when the model is off', async () => {
  for (const [suggest, label] of [[{ ok: true, label: 'Cripto', topic: 'criptomonedas' }, 'Cripto'], [{ ok: false, state: 'unavailable' }, 'Como @ana']]) {
    const { doc, data, sent } = await boot({
      html: articleHtml({ id: '21', text: 'Bitcoin a la luna' }),
      classify: async (msg) => (msg.action === 'SUGGEST_TOPIC' ? suggest : { ok: true, matches: {} })
    });
    await settle();
    const article = doc.querySelector('article');
    clickText(article, '✂ Ocultar posts como este');
    clickText(article, '+ Nuevo filtro con este tema');
    await settle();
    assert.ok(sent.some((m) => m.action === 'SUGGEST_TOPIC' && m.post.id === '21'));
    const f = data.settings.filters.at(-1);
    assert.deepEqual([f.label, f.mode, f.enabled], [label, 'exclude', true]);
    assert.equal(data.corrections.at(-1).filterPrompt, f.prompt);
    assert.equal(article.getAttribute('data-bonxai-status'), 'pruned');
  }
});

test('posts kept by "Solo mostrar" filters feed the local curated log', async () => {
  const { data } = await boot({
    html: articleHtml({ id: '30', author: 'leo', text: 'Golazo de Messi' }) + articleHtml({ id: '31', text: 'nada' }),
    settings: { filters: [TECH, MESSI] },
    classify: async (msg) => ({ ok: true, matches: { tech: false, messi: msg.post.id === '30' } })
  });
  await tick(650);
  assert.equal(data.curatedLog.length, 1);
  assert.deepEqual([data.curatedLog[0].id, data.curatedLog[0].author, data.curatedLog[0].labels], ['30', 'leo', ['Messi']]);
});

test('"No debía ocultarse" with several "Solo mostrar" filters asks for the topic', async () => {
  const { doc, data } = await boot({
    html: articleHtml({ id: '32', text: 'Un poema' }),
    settings: { filters: [TECH, MESSI] },
    classify: async () => ({ ok: true, matches: { tech: false, messi: false } })
  });
  await settle();
  const bar = doc.querySelector('.bonxai-bar');
  clickText(bar, 'No debía ocultarse');
  assert.match(bar.textContent, /¿De qué tema es\?/);
  clickText(bar, 'Messi');
  await settle();
  assert.deepEqual(data.overrides, ['32']);
  assert.deepEqual(data.corrections.map((c) => [c.filterPrompt, c.matches]), [['Messi', true]]);
});
