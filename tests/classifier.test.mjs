import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadLibs } from '../scripts/load-libs.mjs';

const { classifier: C } = loadLibs(['rules', 'classifier']);
const filters = [
  { id: 'pol', label: 'Pol', prompt: 'política', mode: 'exclude', enabled: true },
  { id: 'tech', label: 'Tech', prompt: 'tecnología', mode: 'include', enabled: true }
];

test('schema is a strict object of booleans, one key per topic', () => {
  assert.deepEqual(C.buildSchema(filters), {
    type: 'object',
    properties: { t0: { type: 'boolean' }, t1: { type: 'boolean' } },
    required: ['t0', 't1'],
    additionalProperties: false
  });
});

test('user prompt lists topics, examples, post text, author and image note', () => {
  const p = C.buildUserPrompt(filters, { text: 'Hola', mediaText: '[Image description: gato]', author: 'ana' }, [{ key: 't0', text: 'ej', matches: false }], true);
  assert.match(p, /t0: "política"/);
  assert.match(p, /t1: "tecnología"/);
  assert.match(p, /Examples labelled by the user:\n- Post: """ej""" → t0: false/);
  assert.match(p, /Hola\n\[Image description: gato\]/);
  assert.match(p, /Author: @ana/);
  assert.match(p, /An image from the post is attached/);
});

test('user prompt cannot be broken out of with triple quotes', () => {
  const p = C.buildUserPrompt(filters, { text: 'a """ b' }, [], false);
  assert.ok(!p.includes('a """ b'));
});

test('parseResponse maps keys to filter ids and rejects bad output', () => {
  assert.deepEqual(C.parseResponse('{"t0": true, "t1": false}', filters), { pol: true, tech: false });
  assert.deepEqual(C.parseResponse('```json\n{"t0": false, "t1": true}\n```', filters), { pol: false, tech: true });
  assert.throws(() => C.parseResponse('{"t0": "yes"}', filters));
  assert.throws(() => C.parseResponse('NO', filters));
});

test('selectExamples: only corrections for current topics, newest first-capped', () => {
  const corrections = [
    { text: 'viejo', filterPrompt: 'política', matches: false },
    { text: 'otro tema', filterPrompt: 'cocina', matches: true },
    { text: 'nuevo', filterPrompt: 'tecnología', matches: true }
  ];
  assert.deepEqual(C.selectExamples(filters, corrections), [
    { key: 't0', text: 'viejo', matches: false },
    { key: 't1', text: 'nuevo', matches: true }
  ]);
  const many = Array.from({ length: 20 }, (_, i) => ({ text: `c${i}`, filterPrompt: 'política', matches: false }));
  const sel = C.selectExamples(filters, many);
  assert.equal(sel.length, 6);
  assert.equal(sel.at(-1).text, 'c19');
});

test('cacheKey: by tweet id, changes with filters, examples or image', () => {
  const k1 = C.cacheKey({ id: '42', text: 'a' }, filters, [], false);
  assert.equal(k1, C.cacheKey({ id: '42', text: 'different text' }, filters, [], false));
  assert.notEqual(k1, C.cacheKey({ id: '42' }, filters.slice(0, 1), [], false));
  assert.notEqual(k1, C.cacheKey({ id: '42' }, filters, [{ key: 't0', text: 'x', matches: true }], false));
  assert.notEqual(k1, C.cacheKey({ id: '42' }, filters, [], true));
  assert.match(C.cacheKey({ text: 'sin id' }, filters, [], false), /^h:/);
});

test('LruCache evicts the least recently used entry', () => {
  const c = new C.LruCache(2);
  c.set('a', 1);
  c.set('b', 2);
  c.get('a');
  c.set('c', 3);
  assert.equal(c.get('b'), undefined);
  assert.equal(c.get('a'), 1);
  assert.equal(c.size, 2);
});

test('PersistentCache: loads fresh entries, drops expired, keeps writes made while loading', async () => {
  let now = 10_000;
  let saved = null;
  let releaseLoad;
  const cache = new C.PersistentCache({
    max: 3,
    ttlMs: 1000,
    now: () => now,
    debounceMs: 5,
    load: () => new Promise((r) => (releaseLoad = () => r({ old: { v: 'x', t: 8000 }, fresh: { v: 'f', t: 9500 } }))),
    save: (obj) => (saved = obj)
  });
  const ready = cache.ready();
  cache.set('new', 'n');
  releaseLoad();
  await ready;
  assert.equal(cache.get('old'), undefined, 'expired by TTL');
  assert.equal(cache.get('fresh'), 'f');
  assert.equal(cache.get('new'), 'n');
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(Object.keys(saved).sort(), ['fresh', 'new']);
  now = 10_600;
  assert.equal(cache.get('fresh'), undefined, 'expires while running too');
  for (const k of ['a', 'b', 'c', 'd']) cache.set(k, k);
  assert.equal(cache.size, 3, 'size cap');
  await cache.clear();
  assert.deepEqual(saved, {});
});

test('cache keys depend on the provider', () => {
  const post = { id: '1', text: 'x' };
  assert.notEqual(C.cacheKey(post, filters, [], false, 'nano'), C.cacheKey(post, filters, [], false, 'ollama'));
});

test('topic suggestion prompt and parsing', () => {
  assert.match(C.buildSuggestPrompt({ text: 'Bitcoin a 100k' }), /Bitcoin a 100k/);
  assert.deepEqual(C.parseSuggestion('Sure: {"label":" Cripto ","topic":"criptomonedas y trading"}'), { label: 'Cripto', topic: 'criptomonedas y trading' });
  assert.throws(() => C.parseSuggestion('{"label":"","topic":""}'));
  assert.deepEqual(C.SUGGEST_SCHEMA.required, ['label', 'topic']);
});
