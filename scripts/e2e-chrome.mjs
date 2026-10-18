#!/usr/bin/env node
// End-to-end smoke test in a real Chrome (headless), without X and without a real model:
//  - loads extension/ unpacked and checks the service worker exposes LanguageModel,
//  - swaps in a FAKE model inside the real service worker,
//  - serves a fake x.com page (request interception) and checks posts get collapsed,
//    that author rules skip the model, and that "No debía ocultarse" stores a correction.
// Usage: CHROME_PATH=/usr/bin/google-chrome npm run e2e
import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ext = join(import.meta.dirname, '..', 'extension');
const executablePath = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const browser = await puppeteer.launch({
  executablePath,
  headless: 'new',
  pipe: true,
  enableExtensions: [ext],
  args: ['--no-sandbox', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'bonxai-e2e-'))}`]
});
try {
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'), { timeout: 15000 });
  const sw = await swTarget.worker();
  const id = new URL(swTarget.url()).host;
  const realAvailability = await sw.evaluate(async () =>
    typeof LanguageModel === 'undefined' ? 'no LanguageModel' : LanguageModel.availability({ expectedInputs: [{ type: 'text', languages: ['en', 'es'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }] })
  );
  console.log(`Chrome ${(await browser.version()).split('/')[1]} · real LanguageModel in service worker: ${realAvailability}`);

  await sw.evaluate(() => {
    self.LanguageModel = {
      availability: async () => 'available',
      create: async () => ({
        async clone() {
          return this;
        },
        destroy() {},
        async prompt(input, opts) {
          const text = typeof input === 'string' ? input : input[0].content[0].value;
          const post = text.split('Post:')[1] || '';
          const keys = Object.keys(opts.responseConstraint.properties);
          return JSON.stringify(Object.fromEntries(keys.map((k) => [k, /elecci|vot/i.test(post)])));
        }
      })
    };
  });
  await sw.evaluate(() =>
    chrome.storage.local.set({
      settings: { filters: [{ id: 'pol', label: 'Sin política', prompt: 'política', mode: 'exclude', enabled: true }], authors: { block: ['troll'], allow: [] } }
    })
  );

  const art = (tid, author, text) =>
    `<article><div data-testid="User-Name"><a href="/${author}">${author}</a><a href="/${author}/status/${tid}"><time>1h</time></a></div><div data-testid="tweetText">${text}</div></article>`;
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', (r) =>
    r.url().startsWith('https://x.com/')
      ? r.respond({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><main>${art('1', 'ana', 'Votá el domingo en las elecciones')}${art('2', 'beto', 'Receta de tarta de manzana')}${art('3', 'troll', 'lo que sea')}</main></body></html>`
        })
      : r.continue()
  );
  await page.goto('https://x.com/home');
  await page.waitForFunction(() => [...document.querySelectorAll('article')].every((a) => ['kept', 'pruned'].includes(a.getAttribute('data-bonxai-status'))), { timeout: 10000 });
  const statuses = await page.evaluate(() => [...document.querySelectorAll('article')].map((a) => a.getAttribute('data-bonxai-status')));
  assert.deepEqual(statuses, ['pruned', 'kept', 'pruned']);
  assert.match(await page.$eval('article .bonxai-bar', (b) => b.textContent), /Coincide con “Sin política”/);

  await page.evaluate(() => [...document.querySelector('article').querySelectorAll('.bonxai-bar button')].find((b) => b.textContent === 'No debía ocultarse').click());
  await page.waitForFunction(() => document.querySelector('article').getAttribute('data-bonxai-status') === 'revealed');
  const st = await sw.evaluate(() => chrome.storage.local.get(['corrections', 'overrides']));
  assert.deepEqual(st.overrides, ['1']);
  assert.equal(st.corrections[0].matches, false);

  // v1.3: "Ocultar posts como este" on a kept post.
  await page.evaluate(() => {
    const a = document.querySelectorAll('article')[1];
    const click = (t) => [...a.querySelectorAll('button')].find((b) => b.textContent === t).click();
    click('✂ Ocultar posts como este');
    click('Es “Sin política”');
  });
  await page.waitForFunction(() => document.querySelectorAll('article')[1].getAttribute('data-bonxai-status') === 'pruned');
  const st2 = await sw.evaluate(() => chrome.storage.local.get(['corrections', 'hiddenIds']));
  assert.deepEqual(st2.hiddenIds, ['2']);
  assert.equal(st2.corrections.at(-1).matches, true);

  // v1.3: the classification cache is persisted to chrome.storage.local.
  await new Promise((r) => setTimeout(r, 1800));
  const cached = await sw.evaluate(() => chrome.storage.local.get('classCache').then((r) => Object.keys(r.classCache || {}).length));
  assert.ok(cached >= 1, 'classCache persisted');
  assert.equal(await sw.evaluate(() => typeof chrome.sidePanel?.open), 'function', 'sidePanel API available');

  // v1.3: curated feed page renders the local log without errors.
  await sw.evaluate(() =>
    chrome.storage.local.set({ curatedLog: [{ id: '9', author: 'leo', url: 'https://x.com/leo/status/9', text: 'Golazo', filterIds: [], labels: ['Messi'], at: Date.now() }] })
  );
  const feed = await browser.newPage();
  const feedErrors = [];
  feed.on('pageerror', (e) => feedErrors.push(String(e)));
  await feed.goto(`chrome-extension://${id}/feed.html`);
  await feed.waitForSelector('#list .item');
  assert.equal(await feed.$eval('#list .text', (e) => e.textContent), 'Golazo');
  assert.deepEqual(feedErrors, []);

  const popup = await browser.newPage();
  const errors = [];
  popup.on('pageerror', (e) => errors.push(String(e)));
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.waitForFunction(() => document.getElementById('aiStatusText').textContent !== 'Revisando el modelo…');
  assert.deepEqual(errors, []);
  console.log('✓ e2e OK: extension loads, posts collapse with reason, author rules skip the model, corrections are stored, hide-like works, cache persists, feed page + popup have no errors');
} finally {
  await browser.close();
}
