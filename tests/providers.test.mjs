import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadLibs } from '../scripts/load-libs.mjs';
import { createFakeLanguageModel, allTopics } from './helpers/model.mjs';

const { providers } = loadLibs(['rules', 'classifier', 'providers']);
const filters = [
  { id: 'pol', label: 'Pol', prompt: 'política', mode: 'exclude', enabled: true },
  { id: 'tech', label: 'Tech', prompt: 'tecnología', mode: 'include', enabled: true }
];

beforeEach(() => {
  delete globalThis.LanguageModel;
});

test('nano: unsupported when LanguageModel is missing', async () => {
  const p = providers.createNanoProvider();
  assert.equal((await p.status()).state, 'unsupported');
  await assert.rejects(p.classify({ filters, post: { text: 'x' } }), (e) => e.state === 'unsupported');
});

test('nano: maps availability to user-facing states', async () => {
  for (const [availability, state] of [['downloadable', 'needs-download'], ['downloading', 'downloading'], ['unavailable', 'unavailable'], ['available', 'ready']]) {
    globalThis.LanguageModel = createFakeLanguageModel({ availability }).LanguageModel;
    assert.equal((await providers.createNanoProvider().status()).state, state, availability);
  }
});

test('nano: one base session with system prompt, a fresh clone per post, JSON schema constraint', async () => {
  const fake = createFakeLanguageModel({ answer: allTopics((text, k) => k === 't0' && text.includes('elecciones')) });
  globalThis.LanguageModel = fake.LanguageModel;
  const p = providers.createNanoProvider();
  const a = await p.classify({ filters, post: { text: 'Mañana hay elecciones' }, examples: [] });
  const b = await p.classify({ filters, post: { text: 'Nuevo modelo de IA' }, examples: [] });
  assert.deepEqual(a.matches, { pol: true, tech: false });
  assert.deepEqual(b.matches, { pol: false, tech: false });
  assert.equal(fake.calls.create.length, 1, 'base session created once');
  assert.equal(fake.calls.create[0].initialPrompts[0].role, 'system');
  assert.deepEqual(fake.calls.create[0].expectedInputs[0].languages, ['en', 'es']);
  assert.equal(fake.calls.clone, 2, 'one clone per post');
  assert.equal(fake.calls.destroyed, 2, 'clones are destroyed');
  assert.equal(fake.calls.prompt[0].options.responseConstraint.type, 'object');
});

test('nano: sends the image when image input is available, falls back to text otherwise', async () => {
  const blob = new Blob(['x'], { type: 'image/jpeg' });
  let fake = createFakeLanguageModel({ answer: allTopics(false) });
  globalThis.LanguageModel = fake.LanguageModel;
  let r = await providers.createNanoProvider().classify({ filters, post: { text: '' }, examples: [], image: blob });
  assert.equal(r.usedImage, true);
  const content = fake.calls.prompt[0].input[0].content;
  assert.equal(content[1].type, 'image');
  assert.equal(content[1].value, blob);

  fake = createFakeLanguageModel({ imageAvailability: 'unavailable', answer: allTopics(false) });
  globalThis.LanguageModel = fake.LanguageModel;
  r = await providers.createNanoProvider().classify({ filters, post: { text: 'hola' }, examples: [], image: blob });
  assert.equal(r.usedImage, false);
  assert.equal(typeof fake.calls.prompt[0].input, 'string');
});

test('nano: invalid model output is an error (caller fails open)', async () => {
  globalThis.LanguageModel = createFakeLanguageModel({ answer: () => 'YES' }).LanguageModel;
  await assert.rejects(providers.createNanoProvider().classify({ filters, post: { text: 'x' }, examples: [] }));
});

test('ollama: refuses non-local endpoints and parses OpenAI-compatible responses', async () => {
  const remote = providers.createOllamaProvider({ endpoint: 'https://api.example.com/v1/chat/completions', model: 'm' }, async () => {
    throw new Error('must not be called');
  });
  assert.equal((await remote.status()).state, 'error');

  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    if (!init) return { ok: true, status: 200 };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"t0": false, "t1": true}' } }] }) };
  };
  const p = providers.createOllamaProvider({ endpoint: 'http://localhost:11434/v1/chat/completions', model: 'gemma3:4b' }, fetchImpl);
  assert.equal((await p.status()).state, 'ready');
  assert.equal(requests[0].url, 'http://localhost:11434/v1/models');
  const r = await p.classify({ filters, post: { text: 'nuevo release' }, examples: [] });
  assert.deepEqual(r.matches, { pol: false, tech: true });
  const body = JSON.parse(requests[1].init.body);
  assert.equal(body.model, 'gemma3:4b');
  assert.equal(body.temperature, 0);
  assert.equal(body.messages[0].role, 'system');
});

test('ollama: 403 explains OLLAMA_ORIGINS', async () => {
  const p = providers.createOllamaProvider({ endpoint: 'http://127.0.0.1:11434/v1/chat/completions', model: 'm' }, async () => ({ ok: false, status: 403 }));
  assert.match((await p.status()).message, /OLLAMA_ORIGINS/);
});

test('nano and ollama: suggest() returns a label/topic for a new filter', async () => {
  const fake = createFakeLanguageModel({ answer: () => '{"label":"Cripto","topic":"criptomonedas"}' });
  globalThis.LanguageModel = fake.LanguageModel;
  const nano = providers.createNanoProvider();
  assert.deepEqual(await nano.suggest({ post: { text: 'BTC' } }), { label: 'Cripto', topic: 'criptomonedas' });
  assert.deepEqual(fake.calls.prompt[0].options.responseConstraint.required, ['label', 'topic']);

  const bodies = [];
  const ollama = providers.createOllamaProvider({ endpoint: 'http://localhost:11434/v1/chat/completions', model: 'm' }, async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"label":"Cripto","topic":"criptomonedas"}' } }] }) };
  });
  assert.deepEqual(await ollama.suggest({ post: { text: 'BTC' } }), { label: 'Cripto', topic: 'criptomonedas' });
  assert.match(bodies[0].messages.at(-1).content, /BTC/);
});
