/**
 * BonXai Pruner - Model providers.
 *
 *  - nano:   Chrome built-in Gemini Nano through the Prompt API (global LanguageModel).
 *            Default. 100% on-device, free. Works in the service worker and extension
 *            pages, NOT in content scripts.
 *            Docs: https://developer.chrome.com/docs/extensions/ai/prompt-api
 *  - ollama: optional, a model the user runs on this same computer through an
 *            OpenAI-compatible endpoint on localhost (e.g. Ollama). Free, still local.
 *
 * Both expose: status() → { state, message }, classify({ filters, post, examples, image }) →
 * { matches: { [filterId]: boolean }, usedImage }, reset().
 * Requires BonXai.classifier. Exposes globalThis.BonXai.providers.
 */
(function (root) {
  'use strict';
  const BonXai = (root.BonXai = root.BonXai || {});
  const C = () => BonXai.classifier;

  function stateError(state, message) {
    const err = new Error(message);
    err.state = state;
    return err;
  }

  const NANO_MESSAGES = {
    available: ['ready', 'Gemini Nano listo en este equipo (100% local).'],
    downloadable: ['needs-download', 'Gemini Nano está soportado pero falta descargarlo. Tocá “Descargar modelo”.'],
    downloading: ['downloading', 'Gemini Nano se está descargando…'],
    unavailable: ['unavailable', 'Este equipo no puede correr Gemini Nano (revisá disco, GPU/RAM y sistema en el README).'],
    unsupported: ['unsupported', 'Este Chrome no tiene la Prompt API (LanguageModel). Hace falta Chrome 138+ de escritorio.']
  };

  function createNanoProvider() {
    const LANGS = [['en', 'es'], ['en']];
    const sessions = { text: null, image: null };
    const pending = { text: null, image: null };

    function optionsFor(langs, withImage) {
      const expectedInputs = [{ type: 'text', languages: langs }];
      if (withImage) expectedInputs.push({ type: 'image' });
      return { expectedInputs, expectedOutputs: [{ type: 'text', languages: ['en'] }] };
    }

    async function resolve(withImage) {
      if (typeof root.LanguageModel === 'undefined') return { availability: 'unsupported', options: null };
      for (const langs of LANGS) {
        const options = optionsFor(langs, withImage);
        try {
          const availability = await root.LanguageModel.availability(options);
          if (availability !== 'unavailable') return { availability, options };
        } catch {
          // try next option set
        }
      }
      return { availability: 'unavailable', options: null };
    }

    async function status() {
      const { availability, options } = await resolve(false);
      const [state, message] = NANO_MESSAGES[availability] || NANO_MESSAGES.unavailable;
      let images = false;
      if (availability === 'available') images = (await resolve(true)).availability === 'available';
      return { state, message, images, options };
    }

    async function getBase(kind) {
      if (sessions[kind]) return sessions[kind];
      if (pending[kind]) return pending[kind];
      pending[kind] = (async () => {
        const { availability, options } = await resolve(kind === 'image');
        if (availability !== 'available') {
          const [state, message] = NANO_MESSAGES[availability] || NANO_MESSAGES.unavailable;
          throw stateError(state, message);
        }
        const session = await root.LanguageModel.create({
          ...options,
          initialPrompts: [{ role: 'system', content: C().SYSTEM_PROMPT }]
        });
        sessions[kind] = session;
        return session;
      })();
      try {
        return await pending[kind];
      } finally {
        pending[kind] = null;
      }
    }

    async function classify({ filters, post, examples, image }) {
      let usedImage = false;
      let base;
      if (image) {
        try {
          base = await getBase('image');
          usedImage = true;
        } catch (err) {
          if (err.state === 'unsupported') throw err;
          base = null; // image input not available: fall back to text only
        }
      }
      if (!base) base = await getBase('text');

      // Fresh context per post: clone the base session (system prompt only).
      const session = typeof base.clone === 'function' ? await base.clone() : base;
      try {
        const text = C().buildUserPrompt(filters, post, examples, usedImage);
        const input = usedImage
          ? [{ role: 'user', content: [{ type: 'text', value: text }, { type: 'image', value: image }] }]
          : text;
        const raw = await session.prompt(input, { responseConstraint: C().buildSchema(filters) });
        return { matches: C().parseResponse(raw, filters), usedImage };
      } finally {
        if (session !== base) {
          try {
            session.destroy();
          } catch {
            // ignore
          }
        }
      }
    }

    /** Suggest a filter topic for "Ocultar posts como este". */
    async function suggest({ post }) {
      const base = await getBase('text');
      const session = typeof base.clone === 'function' ? await base.clone() : base;
      try {
        const raw = await session.prompt(C().buildSuggestPrompt(post), { responseConstraint: C().SUGGEST_SCHEMA });
        return C().parseSuggestion(raw);
      } finally {
        if (session !== base) {
          try {
            session.destroy();
          } catch {
            // ignore
          }
        }
      }
    }

    function reset() {
      for (const k of Object.keys(sessions)) {
        try {
          sessions[k] && sessions[k].destroy();
        } catch {
          // ignore
        }
        sessions[k] = null;
      }
    }

    return { name: 'nano', status, classify, suggest, reset };
  }

  function bytesToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  function createOllamaProvider(config, fetchImpl) {
    const doFetch = fetchImpl || ((...a) => root.fetch(...a));
    const endpoint = config.endpoint;
    const model = config.model;

    async function status() {
      if (!BonXai.rules || !BonXai.rules.isLocalEndpoint(endpoint)) {
        return { state: 'error', message: 'El endpoint tiene que ser localhost o 127.0.0.1.' };
      }
      try {
        const res = await doFetch(endpoint.replace(/\/chat\/completions\/?$/, '/models'));
        if (res.status === 403) {
          return { state: 'error', message: 'El servidor local rechazó la extensión (403). En Ollama: OLLAMA_ORIGINS=chrome-extension://*' };
        }
        if (!res.ok) return { state: 'error', message: `El servidor local respondió ${res.status}.` };
        return { state: 'ready', message: `Modelo local “${model}” en ${new URL(endpoint).host}.`, images: true };
      } catch (err) {
        return { state: 'unavailable', message: `No se pudo conectar a ${endpoint}. ¿Está corriendo Ollama?` };
      }
    }

    async function chat(messages) {
      const res = await doFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, temperature: 0, stream: false, response_format: { type: 'json_object' }, messages })
      });
      if (!res.ok) throw stateError('error', `Servidor local: HTTP ${res.status}`);
      const data = await res.json();
      return data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    }

    async function suggest({ post }) {
      const raw = await chat([
        { role: 'system', content: 'You help users write topic filters for their social media feed. Reply only with JSON.' },
        { role: 'user', content: C().buildSuggestPrompt(post) }
      ]);
      return C().parseSuggestion(raw);
    }

    async function classify({ filters, post, examples, image }) {
      const text = C().buildUserPrompt(filters, post, examples, Boolean(image));
      let content = text;
      if (image) {
        const dataUrl = `data:${image.type || 'image/jpeg'};base64,${bytesToBase64(await image.arrayBuffer())}`;
        content = [
          { type: 'text', text },
          { type: 'image_url', image_url: { url: dataUrl } }
        ];
      }
      const raw = await chat([
        { role: 'system', content: C().SYSTEM_PROMPT },
        { role: 'user', content }
      ]);
      return { matches: C().parseResponse(raw, filters), usedImage: Boolean(image) };
    }

    return { name: 'ollama', status, classify, suggest, reset() {} };
  }

  BonXai.providers = { createNanoProvider, createOllamaProvider, NANO_MESSAGES };
})(typeof globalThis !== 'undefined' ? globalThis : self);
