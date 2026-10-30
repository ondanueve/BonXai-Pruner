import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadLibs } from '../scripts/load-libs.mjs';

const { rules } = loadLibs(['rules']);

const settingsWith = (over = {}) => ({ ...rules.mergeSettings(null), ...over });
const F = (id, mode, enabled = true) => ({ id, label: id, prompt: `topic ${id}`, mode, enabled });
const post = (over = {}) => ({ id: '1', author: 'ana', text: 'hola mundo', mediaText: '', hasMedia: false, hasImage: false, isVideo: false, imageUrls: [], ...over });

test('handles: normalize and parse lists', () => {
  assert.equal(rules.normalizeHandle('@Ana_B'), 'ana_b');
  assert.equal(rules.normalizeHandle('no valid!'), null);
  assert.deepEqual(rules.parseHandleList('@a, @B  c;@a\n@toolonghandle1234'), ['a', 'b', 'c']);
});

test('mergeSettings: defaults, validation and zero-cloud endpoint check', () => {
  const s = rules.mergeSettings({ includeCombine: 'bogus', hideStyle: 'remove', ollama: { endpoint: 'https://api.example.com/v1/chat/completions' } });
  assert.equal(s.includeCombine, 'any');
  assert.equal(s.hideStyle, 'remove');
  assert.equal(s.ollama.endpoint, rules.DEFAULT_SETTINGS.ollama.endpoint, 'remote endpoints are rejected');
  assert.equal(s.provider, 'nano');
});

test('mergeSettings: migrates v1.0 savedPrunings using the stored type, not the prompt text', () => {
  const s = rules.mergeSettings(null, {
    savedPrunings: [
      { id: 'a', label: 'Piano', prompt: 'piano notes and no-nonsense tutorials', type: 'inclusion', enabled: true },
      { id: 'b', label: 'Pol', prompt: 'politics', type: 'exclusion', enabled: false }
    ],
    extensionEnabled: false,
    uncaptionedPolicy: 'strict'
  });
  assert.equal(s.filters[0].mode, 'include');
  assert.equal(s.filters[1].mode, 'exclude');
  assert.equal(s.enabled, false);
  assert.equal(s.uncaptioned, 'hide');
});

test('filter mode never depends on words like "no " inside the prompt', () => {
  const f = rules.normalizeFilter({ prompt: 'technology news and piano notes', mode: 'include', enabled: true }, 0);
  assert.equal(f.mode, 'include');
  const g = rules.normalizeFilter({ prompt: 'no politics' }, 0);
  assert.equal(g.mode, 'exclude', 'default mode is explicit (exclude), not inferred');
});

test('preDecide: disabled, overrides and author lists skip the AI', () => {
  assert.equal(rules.preDecide(settingsWith({ enabled: false }), post(), []).action, 'show');
  assert.equal(rules.preDecide(settingsWith(), post(), ['1']).reason, 'corrected');
  const s = settingsWith({ authors: { allow: ['ana'], block: ['troll'] } });
  assert.equal(rules.preDecide(s, post(), []).reason, 'author-allow');
  const d = rules.preDecide(s, post({ author: 'Troll' }), []);
  assert.equal(d.action, 'hide');
  assert.equal(d.kind, 'author');
});

test('preDecide: explicit media rules', () => {
  const s = settingsWith({ media: { hideImages: false, hideVideos: true, requireMedia: false } });
  assert.equal(rules.preDecide(s, post({ hasMedia: true, isVideo: true }), []).reason, 'Tiene video');
  const r = settingsWith({ media: { hideImages: false, hideVideos: false, requireMedia: true } });
  assert.equal(rules.preDecide(r, post(), []).action, 'hide');
  assert.equal(rules.preDecide(r, post({ hasMedia: true, hasImage: true }), []).final, false);
});

test('preDecide: uncaptioned media uses the explicit policy and filter modes', () => {
  const media = post({ text: '', hasMedia: true, hasImage: true, imageUrls: ['https://pbs.twimg.com/x.jpg'] });
  const exclOnly = settingsWith({ filters: [F('pol', 'exclude')] });
  assert.equal(rules.preDecide(exclOnly, media, []).action, 'show');
  const withInclude = settingsWith({ filters: [F('pol', 'exclude'), F('tech', 'include')] });
  assert.equal(rules.preDecide(withInclude, media, []).action, 'hide');
  assert.equal(rules.preDecide({ ...withInclude, uncaptioned: 'keep' }, media, []).action, 'show');
  const img = rules.preDecide({ ...withInclude, analyzeImages: true }, media, []);
  assert.equal(img.final, false);
  assert.equal(img.useImage, true);
});

test('preDecide: no active filters → show; otherwise ask the AI', () => {
  assert.equal(rules.preDecide(settingsWith({ filters: [F('x', 'exclude', false)] }), post(), []).action, 'show');
  const d = rules.preDecide(settingsWith({ filters: [F('x', 'exclude')] }), post(), []);
  assert.equal(d.final, false);
  assert.deepEqual(d.filters.map((f) => f.id), ['x']);
});

test('finalDecide: exclude wins, include any/all', () => {
  const filters = [F('pol', 'exclude'), F('tech', 'include'), F('messi', 'include')];
  const any = settingsWith({ includeCombine: 'any' });
  const all = settingsWith({ includeCombine: 'all' });
  assert.equal(rules.finalDecide(any, filters, { pol: true, tech: true, messi: true }).kind, 'exclude');
  assert.equal(rules.finalDecide(any, filters, { pol: false, tech: true, messi: false }).action, 'show');
  assert.equal(rules.finalDecide(any, filters, { pol: false, tech: false, messi: false }).kind, 'include');
  const d = rules.finalDecide(all, filters, { pol: false, tech: true, messi: false });
  assert.equal(d.action, 'hide');
  assert.deepEqual(d.filterIds, ['messi']);
  assert.equal(rules.finalDecide(any, [F('pol', 'exclude')], { pol: false }).action, 'show');
});

test('correctionExamples: flips the label of the filter that caused the hide', () => {
  const s = settingsWith({ filters: [F('pol', 'exclude'), F('tech', 'include'), F('messi', 'include')] });
  const ex = rules.correctionExamples(s, { action: 'hide', kind: 'exclude', filterIds: ['pol'] }, 'texto');
  assert.deepEqual(ex.map((e) => [e.filterPrompt, e.matches]), [['topic pol', false]]);
  const one = rules.correctionExamples(s, { action: 'hide', kind: 'include', filterIds: ['tech'] }, 'texto');
  assert.deepEqual(one.map((e) => [e.filterPrompt, e.matches]), [['topic tech', true]]);
  assert.deepEqual(rules.correctionExamples(s, { action: 'hide', kind: 'include', filterIds: ['tech', 'messi'] }, 'texto'), [], 'ambiguous with several includes in "any" mode');
  assert.deepEqual(rules.correctionExamples(s, { action: 'hide', kind: 'author', filterIds: [] }, 'texto'), []);
});

test('pushCapped keeps the newest items and dedupes by key', () => {
  assert.deepEqual(rules.pushCapped([1, 2, 3], [4, 5], 3), [3, 4, 5]);
  assert.deepEqual(rules.pushCapped(['a', 'b'], ['a'], 5, (x) => x), ['b', 'a']);
});

test('v1.3: posts hidden by the user stay hidden; include matches report matchedIds', () => {
  const s = settingsWith({ filters: [F('a', 'include'), F('b', 'include')] });
  const d = rules.preDecide(s, post({ id: '7' }), [], ['7']);
  assert.deepEqual([d.action, d.kind], ['hide', 'user']);
  assert.equal(rules.preDecide(s, post({ id: '7' }), ['7'], ['7']).action, 'show', 'override wins');
  const kept = rules.finalDecide(s, rules.activeFilters(s), { a: false, b: true });
  assert.deepEqual([kept.action, kept.matchedIds], ['show', ['b']]);
});

test('v1.3: multi "Solo mostrar" corrections need a topic choice and use only that topic', () => {
  const s = settingsWith({ filters: [F('a', 'include'), F('b', 'include')] });
  const d = rules.finalDecide(s, rules.activeFilters(s), { a: false, b: false });
  assert.equal(rules.needsTopicChoice(s, d), true);
  assert.deepEqual(rules.correctionExamples(s, d, 'texto'), [], 'ambiguous without a choice');
  const ex = rules.correctionExamples(s, d, 'texto', 'b');
  assert.deepEqual(ex.map((e) => [e.filterPrompt, e.matches]), [['topic b', true]]);
  assert.equal(rules.needsTopicChoice({ ...s, includeCombine: 'all' }, d), false);
  const single = settingsWith({ filters: [F('a', 'include')] });
  assert.equal(rules.needsTopicChoice(single, rules.finalDecide(single, rules.activeFilters(single), { a: false })), false);
});

test('v1.3: hide-like examples and the fallback filter', () => {
  assert.equal(rules.hideLikeExample(F('x', 'exclude'), 'hola').matches, true);
  assert.equal(rules.hideLikeExample(F('y', 'include'), 'hola').matches, false);
  assert.equal(rules.hideLikeExample(F('y', 'include'), '  '), null);
  const f = rules.fallbackTopicFilter(post({ author: 'ana', text: 'Bitcoin a la luna   🚀' }));
  assert.deepEqual([f.mode, f.enabled, f.label], ['exclude', true, 'Como @ana']);
  assert.match(f.prompt, /de @ana: "Bitcoin a la luna 🚀"/);
  assert.equal(rules.normalizeFilter(f).mode, 'exclude');
});
