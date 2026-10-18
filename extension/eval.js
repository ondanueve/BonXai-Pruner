/**
 * BonXai Pruner - In-extension evaluation page.
 * Runs eval/dataset.json through the real model (Gemini Nano or the local endpoint)
 * and reports precision / recall per topic. No numbers are shipped with the repo:
 * run it on your machine to get them.
 */
(() => {
  'use strict';
  const { rules, providers, metrics } = globalThis.BonXai;
  const $ = (id) => document.getElementById(id);
  let lastResult = null;

  $('run').addEventListener('click', async () => {
    $('run').disabled = true;
    $('download').hidden = true;
    $('report').hidden = true;
    try {
      const dataset = await (await fetch(chrome.runtime.getURL('eval/dataset.json'))).json();
      const { settings } = await chrome.storage.local.get(['settings']);
      const s = rules.mergeSettings(settings);
      const provider = $('provider').value === 'ollama' ? providers.createOllamaProvider(s.ollama) : providers.createNanoProvider();
      const status = await provider.status();
      if (status.state !== 'ready') throw new Error(status.message);

      const result = await metrics.evaluate(
        dataset,
        async (filters, item) => (await provider.classify({ filters, post: { text: item.text }, examples: [] })).matches,
        (done, total) => ($('status').textContent = `Evaluando… ${done}/${total}`)
      );
      provider.reset();
      lastResult = { provider: provider.name, date: new Date().toISOString(), dataset: dataset.description, ...result };
      $('status').textContent = `Listo (${provider.name}).`;
      $('report').textContent = metrics.formatReport(result);
      $('report').hidden = false;
      $('download').hidden = false;

      const byId = new Map(dataset.items.map((i) => [i.id, i.text]));
      const tbody = $('mistakes').querySelector('tbody');
      tbody.textContent = '';
      for (const m of result.mistakes) {
        const tr = document.createElement('tr');
        for (const v of [m.topic, String(m.expected), byId.get(m.itemId)]) {
          const td = document.createElement('td');
          td.textContent = v;
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      $('mistakes').hidden = $('mistakesTitle').hidden = result.mistakes.length === 0;
    } catch (err) {
      $('status').textContent = `No se pudo evaluar: ${err && err.message ? err.message : err}`;
    } finally {
      $('run').disabled = false;
    }
  });

  $('download').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(lastResult, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `bonxai-eval-${lastResult.provider}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
})();
