/**
 * BonXai Pruner - Background service worker.
 *
 * Owns the model. Content scripts cannot use the Prompt API, so content.js sends
 * each post here with chrome.runtime.sendMessage({ action: 'CLASSIFY', post, filters, useImage }).
 *
 *  - Default provider: Chrome built-in Gemini Nano (LanguageModel), 100% local.
 *  - Optional provider: a model on localhost (Ollama / OpenAI-compatible), also local and free.
 *  - Results are cached per tweet id + filter set (LRU persisted in chrome.storage.local,
 *    3-day TTL, so the cache survives service worker and browser restarts).
 *  - User corrections are sent to the model as few-shot examples.
 */
importScripts('lib/rules.js', 'lib/classifier.js', 'lib/providers.js');

const { rules, classifier, providers } = self.BonXai;

const IMAGE_MAX_BYTES = 4 * 1024 * 1024;
const CACHE_KEY = 'classCache';
const cache = new classifier.PersistentCache({
  max: 3000,
  ttlMs: 3 * 24 * 3600 * 1000,
  load: () => chrome.storage.local.get([CACHE_KEY]).then((r) => r[CACHE_KEY] || {}),
  save: (obj) => chrome.storage.local.set({ [CACHE_KEY]: obj })
});
const nano = providers.createNanoProvider();
let ollama = null;
let ollamaKey = '';
let settings = null;
let corrections = [];
let statePromise = null;

function loadState() {
  if (settings) return Promise.resolve();
  if (!statePromise) {
    statePromise = chrome.storage.local
      .get(['settings', 'corrections', 'savedPrunings', 'extensionEnabled', 'uncaptionedPolicy'])
      .then((st) => {
        settings = rules.mergeSettings(st.settings, st);
        corrections = Array.isArray(st.corrections) ? st.corrections : [];
      })
      .finally(() => {
        statePromise = null;
      });
  }
  return statePromise;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.settings) settings = rules.mergeSettings(changes.settings.newValue);
  if (changes.corrections) corrections = Array.isArray(changes.corrections.newValue) ? changes.corrections.newValue : [];
});

function currentProvider() {
  if (settings && settings.provider === 'ollama') {
    const key = `${settings.ollama.endpoint}|${settings.ollama.model}`;
    if (!ollama || key !== ollamaKey) {
      ollama = providers.createOllamaProvider(settings.ollama);
      ollamaKey = key;
    }
    return ollama;
  }
  return nano;
}

function setAiStatus(status) {
  return chrome.storage.local.set({
    aiStatus: {
      state: status.state,
      message: status.message,
      images: Boolean(status.images),
      provider: currentProvider().name,
      updatedAt: Date.now()
    }
  });
}

async function fetchImage(url) {
  if (!/^https:\/\/pbs\.twimg\.com\//.test(url || '')) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    return blob.size <= IMAGE_MAX_BYTES ? blob : null;
  } catch {
    return null;
  }
}

async function classify(message) {
  await loadState();
  const filters = (message.filters || []).filter((f) => f && f.id && f.prompt);
  const post = message.post || {};
  if (!filters.length) return { ok: true, matches: {}, cached: false };

  const examples = classifier.selectExamples(filters, corrections);
  const wantImage = Boolean(message.useImage && post.imageUrls && post.imageUrls.length);
  const provider = currentProvider();
  const key = classifier.cacheKey(post, filters, examples, wantImage, provider.name);
  await cache.ready();
  const hit = cache.get(key);
  if (hit) return { ok: true, matches: hit.matches, usedImage: hit.usedImage, cached: true };

  const image = wantImage ? await fetchImage(post.imageUrls[0]) : null;
  const result = await provider.classify({ filters, post, examples, image });
  cache.set(key, result);
  return { ok: true, matches: result.matches, usedImage: result.usedImage, cached: false };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.action !== 'string') return false;

  if (message.action === 'CLASSIFY') {
    classify(message)
      .then(sendResponse)
      .catch(async (err) => {
        const state = err.state || 'error';
        if (state !== 'error') {
          await setAiStatus({ state, message: err.message });
        } else {
          await setAiStatus({ state: 'error', message: `Error del modelo: ${err.message || err}` });
        }
        sendResponse({ ok: false, state, error: String(err.message || err) });
      });
    return true;
  }

  if (message.action === 'CHECK_AI') {
    loadState()
      .then(() => currentProvider().status())
      .then(async (status) => {
        await setAiStatus(status);
        sendResponse({ ok: true, ...status, options: undefined });
      })
      .catch((err) => sendResponse({ ok: false, state: 'error', message: String(err.message || err) }));
    return true;
  }

  if (message.action === 'SUGGEST_TOPIC') {
    loadState()
      .then(() => currentProvider().suggest({ post: message.post || {} }))
      .then((suggestion) => sendResponse({ ok: true, ...suggestion }))
      .catch((err) => sendResponse({ ok: false, state: err.state || 'error', error: String(err.message || err) }));
    return true;
  }

  if (message.action === 'RESET_AI') {
    // Cached results stay valid: their key includes the filters, examples and provider.
    nano.reset();
    sendResponse({ ok: true });
    return false;
  }

  if (message.action === 'CLEAR_CACHE') {
    cache.clear().then(() => sendResponse({ ok: true }));
    return true;
  }

  return false;
});

// Migrate v1.0 storage (filterPrompt / savedPrunings) to the structured settings format.
chrome.runtime.onInstalled.addListener(async () => {
  const st = await chrome.storage.local.get(null);
  if (!st.settings) {
    await chrome.storage.local.set({ settings: rules.mergeSettings(null, st) });
    await chrome.storage.local.remove(['filterPrompt', 'savedPrunings', 'extensionEnabled', 'uncaptionedPolicy', 'prunedCount']);
  }
  settings = null;
  await loadState();
  try {
    await setAiStatus(await currentProvider().status());
  } catch {
    // ignore
  }
});
