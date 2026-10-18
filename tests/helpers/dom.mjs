import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXT_DIR } from '../../scripts/load-libs.mjs';

/** Build an X-like <article> for a post. */
export function articleHtml({ id = '100', author = 'ana', text = 'hola', photo = null, alt = '', video = false } = {}) {
  return `<article data-testid="tweet">
    <div data-testid="User-Name"><a href="/${author}">${author}</a><a href="/${author}/status/${id}"><time>1h</time></a></div>
    ${text ? `<div data-testid="tweetText">${text}</div>` : ''}
    ${photo ? `<div data-testid="tweetPhoto"><img src="${photo}" alt="${alt}"></div>` : ''}
    ${video ? '<div data-testid="videoComponent"><video aria-label="Embedded video"></video></div>' : ''}
  </article>`;
}

export function makeDom(bodyHtml = '') {
  const dom = new JSDOM(`<!DOCTYPE html><html><head></head><body><main>${bodyHtml}</main></body></html>`, { runScripts: 'outside-only' });
  return dom;
}

export function loadIntoWindow(window, files) {
  for (const f of files) window.eval(readFileSync(join(EXT_DIR, f), 'utf8'));
}
