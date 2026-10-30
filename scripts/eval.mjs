#!/usr/bin/env node
// Precision / recall of the topic classifier on extension/eval/dataset.json.
//
//   node scripts/eval.mjs                      # mock: keyword baseline, checks the pipeline only
//   node scripts/eval.mjs --provider ollama [--endpoint http://localhost:11434/v1/chat/completions] [--model gemma3:4b]
//
// For the real Gemini Nano, open the extension's eval page (popup → Opciones →
// "Evaluar el modelo"): the Prompt API only exists inside Chrome.
import { loadLibs, readDataset } from './load-libs.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const { providers, metrics } = loadLibs();
const dataset = readDataset();
const providerName = opt('provider', 'mock');

// Deliberately naive keyword baseline. Its numbers say nothing about Gemini Nano;
// they only prove the dataset + metrics pipeline works and give a floor to beat.
// Generic keywords chosen up front, NOT tuned on the dataset.
const KEYWORDS = {
  politica: ['elecci', 'vot', 'gobierno', 'polític', 'election', 'senator'],
  messi: ['messi'],
  tech: ['software', 'model', 'app', 'paper'],
  poesia: ['poema', 'poesía', 'verso', 'poem'],
  cripto: ['bitcoin', 'cripto', 'crypto', 'nft']
};
const mock = {
  name: 'mock',
  async classify({ filters, post }) {
    const t = post.text.toLowerCase();
    return { matches: Object.fromEntries(filters.map((f) => [f.id, (KEYWORDS[f.id] || []).some((k) => t.includes(k))])) };
  }
};

let provider = mock;
if (providerName === 'ollama') {
  provider = providers.createOllamaProvider({
    endpoint: opt('endpoint', 'http://localhost:11434/v1/chat/completions'),
    model: opt('model', 'gemma3:4b')
  });
  const s = await provider.status();
  if (s.state !== 'ready') {
    console.error(`Local model not reachable: ${s.message}`);
    process.exit(2);
  }
} else if (providerName !== 'mock') {
  console.error(`Unknown provider "${providerName}". Use mock or ollama.`);
  process.exit(2);
}

const result = await metrics.evaluate(dataset, async (filters, item) => (await provider.classify({ filters, post: { text: item.text }, examples: [] })).matches);
console.log(`provider: ${provider.name}${provider.name === 'mock' ? ' (keyword baseline — NOT a model quality number)' : ''}`);
console.log(metrics.formatReport(result));
if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
