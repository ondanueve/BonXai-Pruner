import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { EXT_DIR } from '../scripts/load-libs.mjs';
import { createChromeMock, tick } from './helpers/chrome.mjs';

async function bootPopup({ aiState = 'ready', data: initial = {}, extra } = {}) {
  const html = readFileSync(join(EXT_DIR, 'popup.html'), 'utf8').replace(/<script[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const sent = [];
  const { chrome, data } = createChromeMock({
    onSendMessage: async (msg) => {
      sent.push(msg);
      if (msg.action === 'CHECK_AI') return { ok: true, state: aiState, message: `estado ${aiState}`, images: false };
      return { ok: true };
    }
  });
  Object.assign(data, initial);
  if (extra) extra(chrome);
  dom.window.chrome = chrome;
  for (const f of ['lib/rules.js', 'popup.js']) dom.window.eval(readFileSync(join(EXT_DIR, f), 'utf8'));
  await tick(30);
  return { dom, doc: dom.window.document, data, sent };
}

test('popup renders default filters with explicit modes and the real model state', async () => {
  const { doc } = await bootPopup({ aiState: 'needs-download' });
  const items = doc.querySelectorAll('#filterList li');
  assert.ok(items.length >= 5);
  assert.equal(items[0].querySelector('select').value, 'exclude');
  assert.equal(doc.getElementById('btnDownload').hidden, false);
  assert.match(doc.getElementById('statusMessage').textContent, /Sin IA/);
});

test('adding a filter and applying stores structured settings', async () => {
  const { doc, data, dom } = await bootPopup();
  doc.getElementById('newMode').value = 'include';
  doc.getElementById('newLabel').value = 'Piano';
  doc.getElementById('newPrompt').value = 'notas de piano y no-nonsense tutoriales';
  doc.getElementById('addFilter').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  doc.getElementById('authorsBlock').value = '@Troll1, troll2';
  doc.getElementById('hideVideos').checked = true;
  doc.getElementById('btnApply').click();
  await tick(30);
  const f = data.settings.filters.at(-1);
  assert.deepEqual([f.label, f.mode, f.enabled], ['Piano', 'include', true], 'mode comes from the select, not from "no " in the text');
  assert.deepEqual(data.settings.authors.block, ['troll1', 'troll2']);
  assert.equal(data.settings.media.hideVideos, true);
  assert.match(doc.getElementById('statusMessage').textContent, /Activo/);
});

test('filtered list offers a one-click correction', async () => {
  const { doc, data } = await bootPopup({
    data: {
      settings: { filters: [{ id: 'pol', label: 'Pol', prompt: 'política', mode: 'exclude', enabled: true }] },
      filteredLog: [{ id: '55', author: 'ana', url: 'https://x.com/ana/status/55', text: 'Mi abuela votó', reason: 'Coincide con “Pol”', kind: 'exclude', filterIds: ['pol'], at: 1 }]
    }
  });
  const btn = [...doc.querySelectorAll('#filteredList button')].find((b) => b.textContent === 'No debía ocultarse');
  btn.click();
  await tick(30);
  assert.deepEqual(data.overrides, ['55']);
  assert.equal(data.corrections[0].matches, false);
  assert.equal(doc.querySelector('#filteredList a').getAttribute('href'), 'https://x.com/ana/status/55');
});

test('popup opens the curated feed in the side panel, or a tab as fallback', async () => {
  const opened = [];
  const { doc } = await bootPopup({
    data: { curatedLog: [{ id: '1', text: 'a', at: 1 }] },
    extra: (chrome) => {
      chrome.windows = { getCurrent: async () => ({ id: 7 }) };
      chrome.sidePanel = { open: async (o) => opened.push(['panel', o.windowId]) };
      chrome.tabs = { create: (o) => opened.push(['tab', o.url]) };
    }
  });
  assert.match(doc.getElementById('btnFeed').textContent, /\(1\)/);
  doc.getElementById('btnFeed').click();
  await tick(10);
  assert.deepEqual(opened, [['panel', 7]]);
  const b = await bootPopup({ extra: (chrome) => (chrome.tabs = { create: (o) => opened.push(['tab', o.url]) }) });
  b.doc.getElementById('btnFeed').click();
  assert.deepEqual(opened.at(-1), ['tab', 'chrome-extension://test/feed.html']);
});

test('popup filtered list: topic chooser for several "Solo mostrar" filters', async () => {
  const filters = [
    { id: 'tech', label: 'Tech', prompt: 'tecnología', mode: 'include', enabled: true },
    { id: 'messi', label: 'Messi', prompt: 'Messi', mode: 'include', enabled: true }
  ];
  const { doc, data } = await bootPopup({
    data: { settings: { filters }, filteredLog: [{ id: '56', text: 'Un poema', kind: 'include', filterIds: ['tech', 'messi'], at: 1 }] }
  });
  [...doc.querySelectorAll('#filteredList button')].find((b) => b.textContent === 'No debía ocultarse').click();
  await tick(10);
  assert.match(doc.getElementById('filteredList').textContent, /¿De qué tema es\?/);
  [...doc.querySelectorAll('#filteredList button')].find((b) => b.textContent === 'Tech').click();
  await tick(30);
  assert.deepEqual(data.overrides, ['56']);
  assert.deepEqual(data.corrections.map((c) => [c.filterPrompt, c.matches]), [['tecnología', true]]);
});

test('curated feed page lists posts, filters by topic and "No es de este tema" stores a negative example', async () => {
  const html = readFileSync(join(EXT_DIR, 'feed.html'), 'utf8').replace(/<script[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const { chrome, data } = createChromeMock();
  Object.assign(data, {
    settings: { filters: [{ id: 'tech', label: 'Tech', prompt: 'tecnología', mode: 'include', enabled: true }, { id: 'messi', label: 'Messi', prompt: 'Messi', mode: 'include', enabled: true }] },
    curatedLog: [
      { id: '1', author: 'leo', url: 'https://x.com/leo/status/1', text: 'Golazo', image: 'https://evil.example/x.jpg', filterIds: ['messi'], labels: ['Messi'], at: Date.now() },
      { id: '2', author: 'dev', url: 'https://x.com/dev/status/2', text: 'Nuevo chip', filterIds: ['tech'], labels: ['Tech'], at: Date.now() }
    ]
  });
  dom.window.chrome = chrome;
  for (const f of ['lib/rules.js', 'feed.js']) dom.window.eval(readFileSync(join(EXT_DIR, f), 'utf8'));
  await tick(20);
  const doc = dom.window.document;
  const texts = () => [...doc.querySelectorAll('#list .text')].map((e) => e.textContent);
  assert.deepEqual(texts(), ['Nuevo chip', 'Golazo'], 'newest first');
  assert.equal(doc.querySelector('#list img'), null, 'only pbs.twimg.com images');
  [...doc.querySelectorAll('.chip')].find((c) => c.textContent === 'Messi').click();
  assert.deepEqual(texts(), ['Golazo']);
  [...doc.querySelectorAll('#list button')].find((b) => b.textContent === 'No es de este tema').click();
  await tick(20);
  assert.deepEqual(data.corrections.map((c) => [c.filterPrompt, c.matches]), [['Messi', false]]);
  assert.deepEqual(data.hiddenIds, ['1']);
  assert.deepEqual(data.curatedLog.map((x) => x.id), ['2']);
  doc.getElementById('search').value = 'zzz';
  doc.getElementById('search').dispatchEvent(new dom.window.Event('input'));
  assert.match(doc.getElementById('empty').textContent, /Nada coincide/);
});
