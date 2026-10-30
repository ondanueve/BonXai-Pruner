// Minimal in-memory mock of the chrome.* APIs used by BonXai Pruner.
export function createChromeMock({ onSendMessage } = {}) {
  const data = {};
  const changeListeners = [];
  const messageListeners = [];
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

  function emit(changes) {
    for (const l of changeListeners) l(changes, 'local');
  }

  const local = {
    data,
    async get(keys) {
      if (keys == null) return clone(data);
      if (typeof keys === 'string') keys = [keys];
      if (Array.isArray(keys)) return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, clone(data[k])]));
      return Object.fromEntries(Object.entries(keys).map(([k, def]) => [k, k in data ? clone(data[k]) : def]));
    },
    async set(obj) {
      const changes = {};
      for (const [k, v] of Object.entries(obj)) {
        changes[k] = { oldValue: clone(data[k]), newValue: clone(v) };
        data[k] = clone(v);
      }
      emit(changes);
    },
    async remove(keys) {
      const changes = {};
      for (const k of [].concat(keys)) {
        if (k in data) changes[k] = { oldValue: data[k] };
        delete data[k];
      }
      emit(changes);
    }
  };

  const chrome = {
    storage: { local, onChanged: { addListener: (f) => changeListeners.push(f) } },
    runtime: {
      onMessage: { addListener: (f) => messageListeners.push(f) },
      onInstalled: { addListener() {} },
      getManifest: () => ({ version: 'test' }),
      getURL: (p) => `chrome-extension://test/${p}`,
      async sendMessage(msg) {
        if (onSendMessage) return onSendMessage(msg);
        // Route to the registered onMessage listeners (background in the same process).
        return new Promise((resolve) => {
          for (const l of messageListeners) {
            const keepOpen = l(msg, {}, resolve);
            if (keepOpen === true) return;
          }
          resolve(undefined);
        });
      }
    },
    permissions: { request: async () => true }
  };
  return { chrome, data, messageListeners };
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
