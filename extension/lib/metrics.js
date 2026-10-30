/**
 * BonXai Pruner - Evaluation metrics (precision / recall per topic).
 * Shared by the in-extension eval page (real Gemini Nano) and scripts/eval.mjs.
 * Exposes globalThis.BonXai.metrics.
 *
 * Dataset format (extension/eval/dataset.json):
 *   { topics: [{ id, prompt }], items: [{ id, text, labels: { [topicId]: boolean } }] }
 * Positive class = "the post matches the topic".
 */
(function (root) {
  'use strict';
  const BonXai = (root.BonXai = root.BonXai || {});

  function confusion(pairs) {
    const c = { tp: 0, fp: 0, fn: 0, tn: 0 };
    for (const { expected, predicted } of pairs) {
      if (expected && predicted) c.tp++;
      else if (!expected && predicted) c.fp++;
      else if (expected && !predicted) c.fn++;
      else c.tn++;
    }
    return c;
  }

  function scores(c) {
    const precision = c.tp + c.fp ? c.tp / (c.tp + c.fp) : null;
    const recall = c.tp + c.fn ? c.tp / (c.tp + c.fn) : null;
    const f1 = precision != null && recall != null && precision + recall ? (2 * precision * recall) / (precision + recall) : null;
    const total = c.tp + c.fp + c.fn + c.tn;
    const accuracy = total ? (c.tp + c.tn) / total : null;
    return { ...c, precision, recall, f1, accuracy };
  }

  /**
   * Run a classifier over the dataset.
   * classify(filters, item) must resolve to { [topicId]: boolean } (the filter ids are the topic ids).
   */
  async function evaluate(dataset, classify, onProgress) {
    const filters = dataset.topics.map((t) => ({ id: t.id, label: t.id, prompt: t.prompt, mode: 'include', enabled: true }));
    const pairsByTopic = Object.fromEntries(dataset.topics.map((t) => [t.id, []]));
    const errors = [];
    const started = Date.now();
    let done = 0;
    for (const item of dataset.items) {
      try {
        const matches = await classify(filters, item);
        for (const t of dataset.topics) {
          if (typeof item.labels[t.id] !== 'boolean') continue;
          pairsByTopic[t.id].push({ expected: item.labels[t.id], predicted: matches[t.id] === true, itemId: item.id });
        }
      } catch (err) {
        errors.push({ itemId: item.id, error: String((err && err.message) || err) });
      }
      done++;
      if (onProgress) onProgress(done, dataset.items.length);
    }
    const perTopic = {};
    for (const t of dataset.topics) perTopic[t.id] = scores(confusion(pairsByTopic[t.id]));
    const overall = scores(confusion(Object.values(pairsByTopic).flat()));
    const mistakes = Object.entries(pairsByTopic).flatMap(([topic, pairs]) =>
      pairs.filter((p) => p.expected !== p.predicted).map((p) => ({ topic, itemId: p.itemId, expected: p.expected }))
    );
    return {
      perTopic,
      overall,
      errors,
      mistakes,
      items: dataset.items.length,
      msPerItem: dataset.items.length ? Math.round((Date.now() - started) / dataset.items.length) : 0
    };
  }

  function fmt(x) {
    return x == null ? '—' : (x * 100).toFixed(1) + '%';
  }

  function formatReport(result) {
    const rows = [['topic', 'precision', 'recall', 'f1', 'tp', 'fp', 'fn', 'tn']];
    for (const [id, s] of Object.entries(result.perTopic)) rows.push([id, fmt(s.precision), fmt(s.recall), fmt(s.f1), s.tp, s.fp, s.fn, s.tn]);
    const o = result.overall;
    rows.push(['(micro)', fmt(o.precision), fmt(o.recall), fmt(o.f1), o.tp, o.fp, o.fn, o.tn]);
    const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
    const lines = rows.map((r) => r.map((v, i) => String(v).padEnd(widths[i])).join('  '));
    lines.push(`items: ${result.items} · errors: ${result.errors.length} · ~${result.msPerItem} ms/item`);
    return lines.join('\n');
  }

  BonXai.metrics = { confusion, scores, evaluate, formatReport };
})(typeof globalThis !== 'undefined' ? globalThis : self);
