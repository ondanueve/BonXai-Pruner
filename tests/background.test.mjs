import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { EXT_DIR } from '../scripts/load-libs.mjs';
import { createChromeMock } from './helpers/chrome.mjs';
import { createFakeLanguageModel, allTopics } from './helpers/model.mjs';

function boot({ answer, availability, settings, corrections, fetchImpl, store } = {}) {
  const { chrome, data, messageListeners } = createChromeMock();
  if (store) Object.assign(data, JSON.parse(JSON.stringify(store)));
  if (settings) data.settings = settings;
  if (corrections) data.corrections = corrections;
  const fake = createFakeLanguageModel({ availability, answer: answer || allTopics(false) });
  // Fresh global scope per boot, like a service worker restart.
  const ctx = vm.createContext({ chrome, LanguageModel: fake.LanguageModel, fetch: fetchImpl || (async () => ({ ok: false })), Blob, URL, btoa, console, setTimeout, clearTimeout });
  ctx.self = ctx;
  ctx.importScripts = (...files) => {
    for (const f of files) vm.runInContext(readFileSync(join(EXT_DIR, f), 'utf8'), ctx, { filename: f });
  };
  vm.runInContext(readFileSync(join(EXT_DIR, 'background.js'), 'utf8'), ctx, { filename: 'background.js' });
  // Messages are serialized between contexts in Chrome; mimic that.
  const send = (msg) => new Promise((resolve) => messageListeners[0](msg, {}, (r) => resolve(JSON.parse(JSON.stringify(r)))));
  return { send, fake, data };
}

const filters = [{ id: 'pol', label: 'Pol', prompt: 'política', mode: 'exclude', enabled: true }];

test('CLASSIFY returns matches and caches by tweet id', async () => {
  const { send, fake } = boot({ answer: allTopics(true) });
  const r1 = await send({ action: 'CLASSIFY', post: { id: '1', text: 'elecciones' }, filters });
  assert.deepEqual(r1, { ok: true, matches: { pol: true }, usedImage: false, cached: false });
  const r2 = await send({ action: 'CLASSIFY', post: { id: '1', text: 'elecciones' }, filters });
  assert.equal(r2.cached, true);
  assert.equal(fake.calls.prompt.length, 1, 'second call served from cache');
});

test('CLASSIFY includes user corrections as few-shot examples', async () => {
  const { send, fake } = boot({ corrections: [{ text: 'Mi abuela votó', filterPrompt: 'política', matches: false }] });
  await send({ action: 'CLASSIFY', post: { id: '2', text: 'algo' }, filters });
  assert.match(fake.calls.prompt[0].input, /Mi abuela votó""" → t0: false/);
});

test('CLASSIFY reports the model state and stores it for the popup', async () => {
  const { send, data } = boot({ availability: 'downloadable' });
  const r = await send({ action: 'CLASSIFY', post: { id: '3', text: 'x' }, filters });
  assert.equal(r.ok, false);
  assert.equal(r.state, 'needs-download');
  assert.equal(data.aiStatus.state, 'needs-download');
});

test('CLASSIFY with an image fetches only pbs.twimg.com URLs', async () => {
  const fetched = [];
  const { send, fake } = boot({
    fetchImpl: async (url) => {
      fetched.push(url);
      return { ok: true, blob: async () => new Blob(['img'], { type: 'image/jpeg' }) };
    }
  });
  await send({ action: 'CLASSIFY', post: { id: '4', text: '', imageUrls: ['https://pbs.twimg.com/media/a.jpg?name=small'] }, filters, useImage: true });
  await send({ action: 'CLASSIFY', post: { id: '5', text: '', imageUrls: ['https://evil.example/a.jpg'] }, filters, useImage: true });
  assert.deepEqual(fetched, ['https://pbs.twimg.com/media/a.jpg?name=small']);
  assert.equal(fake.calls.prompt[0].input[0].content[1].type, 'image');
  assert.equal(typeof fake.calls.prompt[1].input, 'string');
});

test('CHECK_AI returns the provider status', async () => {
  const { send } = boot();
  const r = await send({ action: 'CHECK_AI' });
  assert.equal(r.state, 'ready');
});

test('classification cache survives a service worker restart (chrome.storage.local)', async () => {
  const first = boot({ answer: allTopics(true) });
  await first.send({ action: 'CLASSIFY', post: { id: '42', text: 'elecciones' }, filters });
  await new Promise((r) => setTimeout(r, 1700)); // debounced save
  assert.ok(Object.keys(first.data.classCache).length === 1);
  const second = boot({ answer: allTopics(false), store: first.data });
  const r = await second.send({ action: 'CLASSIFY', post: { id: '42', text: 'elecciones' }, filters });
  assert.deepEqual([r.cached, r.matches.pol], [true, true]);
  assert.equal(second.fake.calls.prompt.length, 0, 'no model call after restart');
  await second.send({ action: 'CLEAR_CACHE' });
  assert.deepEqual(second.data.classCache, {});
});

test('SUGGEST_TOPIC asks the local model for a filter label and topic', async () => {
  const { send } = boot({ answer: () => '{"label":"Cripto","topic":"criptomonedas"}' });
  assert.deepEqual(await send({ action: 'SUGGEST_TOPIC', post: { text: 'BTC' } }), { ok: true, label: 'Cripto', topic: 'criptomonedas' });
  const off = boot({ availability: 'unavailable' });
  const r = await off.send({ action: 'SUGGEST_TOPIC', post: { text: 'BTC' } });
  assert.equal(r.ok, false);
});
