/**
 * BonXai Pruner - Prompt building, structured output and caching helpers.
 * Pure functions, shared by the service worker, the eval page and Node tests.
 * Exposes globalThis.BonXai.classifier.
 *
 * The model is asked a narrow question: for each topic, does this post match it?
 * The keep/hide decision is then taken in code (rules.finalDecide), so the
 * model never has to reason about "include" vs "exclude" semantics.
 */
(function (root) {
  'use strict';
  const BonXai = (root.BonXai = root.BonXai || {});

  const SYSTEM_PROMPT = `You classify social media posts by topic.
You receive a list of topics, each with a key (t0, t1, ...) and a description, and one post.
For every key answer true if the post is clearly about or matches that topic description, false otherwise.
Rules:
- Judge meaning and intent, not isolated keywords. A post that only mentions a word in passing does not match.
- Posts and topic descriptions may be in Spanish or English. Language does not matter.
- If an image from the post is attached, use it together with the text.
- Each post is independent of any previous post.
- Follow the examples labelled by the user when a post is similar to them.
- Reply only with the JSON object.`;

  const MAX_TEXT_CHARS = 2000;
  const MAX_EXAMPLES = 6;

  /** FNV-1a 32-bit hash, hex. Stable across contexts, no crypto needed. */
  function hash(str) {
    let h = 0x811c9dc5;
    const s = String(str);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  function topicKeys(filters) {
    return filters.map((_, i) => `t${i}`);
  }

  /** JSON Schema for responseConstraint: { t0: boolean, t1: boolean, ... } */
  function buildSchema(filters) {
    const properties = {};
    for (const key of topicKeys(filters)) properties[key] = { type: 'boolean' };
    return { type: 'object', properties, required: topicKeys(filters), additionalProperties: false };
  }

  /** Few-shot examples from user corrections that apply to the current topics. */
  function selectExamples(filters, corrections) {
    const keyByPrompt = new Map(filters.map((f, i) => [f.prompt, `t${i}`]));
    const out = [];
    for (let i = (corrections || []).length - 1; i >= 0 && out.length < MAX_EXAMPLES; i--) {
      const c = corrections[i];
      const key = keyByPrompt.get(c.filterPrompt);
      if (key && c.text) out.push({ key, text: String(c.text).slice(0, 280), matches: Boolean(c.matches) });
    }
    return out.reverse();
  }

  function quote(text) {
    return String(text).replace(/"""/g, '"”"');
  }

  function buildUserPrompt(filters, post, examples, withImage) {
    const lines = ['Topics:'];
    filters.forEach((f, i) => lines.push(`t${i}: "${quote(f.prompt)}"`));
    if (examples && examples.length) {
      lines.push('', 'Examples labelled by the user:');
      for (const ex of examples) lines.push(`- Post: """${quote(ex.text)}""" → ${ex.key}: ${ex.matches}`);
    }
    const body = [post.text, post.mediaText].filter((x) => x && String(x).trim()).join('\n');
    lines.push('', 'Post:', `"""`, quote(body.slice(0, MAX_TEXT_CHARS)) || '(no text)', `"""`);
    if (post.author) lines.push(`Author: @${post.author}`);
    if (withImage) lines.push('An image from the post is attached.');
    lines.push('', `Return a JSON object with a boolean for each key: ${topicKeys(filters).join(', ')}.`);
    return lines.join('\n');
  }

  /** Parse the model output into { [filterId]: boolean }. Throws on bad output. */
  function parseResponse(raw, filters) {
    let text = String(raw == null ? '' : raw).trim();
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) text = fenced[1].trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) text = text.slice(start, end + 1);
    const obj = JSON.parse(text);
    const out = {};
    filters.forEach((f, i) => {
      const v = obj[`t${i}`];
      if (typeof v !== 'boolean') throw new Error(`Missing boolean for t${i} in model output: ${raw}`);
      out[f.id] = v;
    });
    return out;
  }

  /**
   * Cache key: tweet id (or text hash) + the exact set of topics and the examples
   * that apply to them. Changing a filter or adding a correction invalidates it.
   */
  function cacheKey(post, filters, examples, withImage, providerName) {
    const who = post.id ? `id:${post.id}` : `h:${hash((post.text || '') + '|' + (post.mediaText || ''))}`;
    const what = hash(JSON.stringify([filters.map((f) => f.prompt), examples || [], Boolean(withImage), providerName || 'nano']));
    return `${who}|${what}`;
  }

  class LruCache {
    constructor(max) {
      this.max = max || 1000;
      this.map = new Map();
    }
    get(key) {
      if (!this.map.has(key)) return undefined;
      const v = this.map.get(key);
      this.map.delete(key);
      this.map.set(key, v);
      return v;
    }
    set(key, value) {
      this.map.delete(key);
      this.map.set(key, value);
      while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    }
    clear() {
      this.map.clear();
    }
    get size() {
      return this.map.size;
    }
  }

  /**
   * LRU cache persisted to storage so results survive service worker restarts
   * (and browser restarts when backed by chrome.storage.local).
   * Entries expire after ttlMs. Writes are debounced.
   *   load(): Promise<{ [key]: { v, t } }>, save(obj): Promise<void>
   */
  class PersistentCache {
    constructor({ max = 3000, ttlMs = 3 * 24 * 3600 * 1000, load, save, now = () => Date.now(), debounceMs = 1500 } = {}) {
      this.lru = new LruCache(max);
      this.ttlMs = ttlMs;
      this.load = load;
      this.save = save;
      this.now = now;
      this.debounceMs = debounceMs;
      this.timer = null;
      this.loading = null;
    }
    ready() {
      if (!this.loading) {
        this.loading = Promise.resolve(this.load ? this.load() : {})
          .catch(() => ({}))
          .then((obj) => {
            const fresh = Object.entries(obj || {})
              .filter(([, e]) => e && typeof e.t === 'number' && this.now() - e.t < this.ttlMs)
              .sort((a, b) => a[1].t - b[1].t);
            // Keep anything set before loading finished: it is newer.
            const pendingWrites = [...this.lru.map.entries()];
            this.lru.clear();
            for (const [k, e] of fresh) this.lru.set(k, e);
            for (const [k, e] of pendingWrites) this.lru.set(k, e);
          });
      }
      return this.loading;
    }
    get(key) {
      const e = this.lru.get(key);
      if (!e) return undefined;
      if (this.now() - e.t >= this.ttlMs) {
        this.lru.map.delete(key);
        return undefined;
      }
      return e.v;
    }
    set(key, value) {
      this.lru.set(key, { v: value, t: this.now() });
      this.scheduleSave();
    }
    clear() {
      this.lru.clear();
      return this.flush();
    }
    get size() {
      return this.lru.size;
    }
    scheduleSave() {
      if (this.timer || !this.save) return;
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, this.debounceMs);
    }
    flush() {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      return this.save ? Promise.resolve(this.save(Object.fromEntries(this.lru.map))) : Promise.resolve();
    }
  }

  // ---------- "Ocultar posts como este": topic suggestion ----------
  const SUGGEST_SCHEMA = {
    type: 'object',
    properties: { label: { type: 'string' }, topic: { type: 'string' } },
    required: ['label', 'topic'],
    additionalProperties: false
  };

  function buildSuggestPrompt(post) {
    const body = [post.text, post.mediaText].filter((x) => x && String(x).trim()).join('\n').slice(0, MAX_TEXT_CHARS);
    return [
      'The user wants to hide posts like the following one from their feed.',
      'Write, in Spanish, a short topic description (max 15 words) that would match this post and similar ones,',
      'and a short label (max 3 words) for that filter. Describe the general topic, not this specific post.',
      'Ignore the "Topics" format used elsewhere: answer only with JSON {"label": "...", "topic": "..."}.',
      '',
      'Post:',
      '"""',
      quote(body) || '(no text)',
      '"""'
    ].join('\n');
  }

  function parseSuggestion(raw) {
    let text = String(raw == null ? '' : raw).trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) text = text.slice(start, end + 1);
    const obj = JSON.parse(text);
    const label = String(obj.label || '').trim().slice(0, 30);
    const topic = String(obj.topic || '').trim().slice(0, 200);
    if (!label || !topic) throw new Error('Empty suggestion');
    return { label, topic };
  }

  BonXai.classifier = {
    SYSTEM_PROMPT,
    hash,
    buildSchema,
    selectExamples,
    buildUserPrompt,
    parseResponse,
    cacheKey,
    LruCache,
    PersistentCache,
    SUGGEST_SCHEMA,
    buildSuggestPrompt,
    parseSuggestion
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
