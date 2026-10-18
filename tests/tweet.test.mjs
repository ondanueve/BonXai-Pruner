import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDom, articleHtml, loadIntoWindow } from './helpers/dom.mjs';

function extract(html) {
  const dom = makeDom(html);
  loadIntoWindow(dom.window, ['lib/tweet.js']);
  return JSON.parse(JSON.stringify(dom.window.BonXai.tweet.extractTweet(dom.window.document.querySelector("article"))));
}

test('extracts id, author, url and text', () => {
  const t = extract(articleHtml({ id: '1789', author: 'Ana_B', text: 'Hola mundo' }));
  assert.equal(t.id, '1789');
  assert.equal(t.author, 'ana_b');
  assert.equal(t.url, 'https://x.com/ana_b/status/1789');
  assert.equal(t.text, 'Hola mundo');
  assert.equal(t.hasMedia, false);
});

test('extracts photos, alt text and small image URLs from pbs.twimg.com only', () => {
  const t = extract(articleHtml({ text: '', photo: 'https://pbs.twimg.com/media/abc?format=jpg&name=large', alt: 'Un gato durmiendo' }));
  assert.equal(t.hasImage, true);
  assert.equal(t.hasMedia, true);
  assert.match(t.mediaText, /Un gato durmiendo/);
  assert.deepEqual(t.imageUrls, ['https://pbs.twimg.com/media/abc?format=jpg&name=small']);
  const generic = extract(articleHtml({ text: '', photo: 'https://evil.example/x.jpg', alt: 'Image' }));
  assert.equal(generic.mediaText, '');
  assert.deepEqual(generic.imageUrls, []);
});

test('detects video without using the generic "Embedded video" label', () => {
  const t = extract(articleHtml({ video: true }));
  assert.equal(t.isVideo, true);
  assert.equal(t.mediaText, '');
});
