import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadLibs, readDataset } from '../scripts/load-libs.mjs';

const { metrics } = loadLibs(['metrics']);

test('scores: precision, recall, f1', () => {
  const s = metrics.scores({ tp: 3, fp: 1, fn: 2, tn: 4 });
  assert.equal(s.precision, 0.75);
  assert.equal(s.recall, 0.6);
  assert.ok(Math.abs(s.f1 - 2 / 3) < 1e-9);
  assert.equal(s.accuracy, 0.7);
  assert.equal(metrics.scores({ tp: 0, fp: 0, fn: 0, tn: 5 }).precision, null);
});

test('evaluate: perfect oracle scores 100%, inverted oracle 0%, errors are counted', async () => {
  const ds = readDataset();
  const byId = new Map(ds.items.map((i) => [i.text, i.labels]));
  const oracle = await metrics.evaluate(ds, async (_f, item) => byId.get(item.text));
  assert.equal(oracle.overall.precision, 1);
  assert.equal(oracle.overall.recall, 1);
  assert.equal(oracle.mistakes.length, 0);

  const inverted = await metrics.evaluate(ds, async (_f, item) => Object.fromEntries(Object.entries(item.labels).map(([k, v]) => [k, !v])));
  assert.equal(inverted.overall.tp, 0);

  let n = 0;
  const flaky = await metrics.evaluate(ds, async (_f, item) => {
    if (n++ === 0) throw new Error('boom');
    return item.labels;
  });
  assert.equal(flaky.errors.length, 1);
  assert.match(metrics.formatReport(flaky), /errors: 1/);
});

test('dataset: every item has a boolean label for every topic', () => {
  const ds = readDataset();
  assert.ok(ds.items.length >= 30);
  for (const item of ds.items) for (const t of ds.topics) assert.equal(typeof item.labels[t.id], 'boolean', `${item.id}/${t.id}`);
  for (const t of ds.topics) assert.ok(ds.items.some((i) => i.labels[t.id]), `topic ${t.id} has positives`);
});
