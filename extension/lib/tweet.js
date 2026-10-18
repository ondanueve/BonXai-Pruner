/**
 * BonXai Pruner - Extract a post from an X/Twitter <article> element.
 * All X DOM selectors live here so a markup change only touches this file.
 * Exposes globalThis.BonXai.tweet.
 */
(function (root) {
  'use strict';
  const BonXai = (root.BonXai = root.BonXai || {});

  const STATUS_RE = /\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/;
  const GENERIC_ALTS = ['image', 'photo', 'graphic', 'embedded video', 'imagen', 'foto', 'video'];

  function statusLink(article) {
    const time = article.querySelector('time');
    const fromTime = time && time.closest('a[href*="/status/"]');
    return fromTime || article.querySelector('a[href*="/status/"]');
  }

  function extractTweet(article) {
    const link = statusLink(article);
    const m = link && (link.getAttribute('href') || '').match(STATUS_RE);
    const id = m ? m[2] : null;

    let author = null;
    const userLink = article.querySelector('[data-testid="User-Name"] a[href^="/"]');
    if (userLink) {
      const h = (userLink.getAttribute('href') || '').replace(/^\//, '').split(/[/?#]/)[0];
      if (/^[A-Za-z0-9_]{1,15}$/.test(h)) author = h.toLowerCase();
    }
    if (!author && m) author = m[1].toLowerCase();

    let text = '';
    const textNode = article.querySelector('[data-testid="tweetText"]');
    if (textNode) text = (textNode.innerText || textNode.textContent || '').trim();

    const photos = Array.from(article.querySelectorAll('[data-testid="tweetPhoto"] img'));
    const videoEl = article.querySelector('[data-testid="videoComponent"], [data-testid="videoPlayer"], video');
    const card = article.querySelector('[data-testid="card.layoutLarge.media"], [data-testid="card.wrapper"]');
    const hasImage = photos.length > 0;
    const isVideo = Boolean(videoEl);
    const hasMedia = hasImage || isVideo || Boolean(article.querySelector('[data-testid="card.layoutLarge.media"]'));

    const mediaParts = [];
    for (const img of photos) {
      const alt = (img.getAttribute('alt') || '').trim();
      if (alt.length > 3 && !GENERIC_ALTS.includes(alt.toLowerCase())) mediaParts.push(`[Image description: ${alt}]`);
    }
    if (videoEl) {
      const label = videoEl.getAttribute('aria-label') || (videoEl.closest('[aria-label]') || { getAttribute: () => '' }).getAttribute('aria-label');
      if (label && label.length > 4 && !/embedded video/i.test(label)) mediaParts.push(`[Video: ${label}]`);
    }
    if (card) {
      const cardText = (card.innerText || card.textContent || '').trim();
      if (cardText) mediaParts.push(`[Link card: ${cardText.slice(0, 200)}]`);
    }

    const imageUrls = photos
      .map((img) => img.getAttribute('src') || '')
      .filter((src) => /^https:\/\/pbs\.twimg\.com\//.test(src))
      .map((src) => src.replace(/name=\w+/, 'name=small'));

    return {
      id,
      author,
      url: id && author ? `https://x.com/${author}/status/${id}` : null,
      text,
      mediaText: mediaParts.join('\n'),
      hasMedia,
      hasImage,
      isVideo,
      imageUrls
    };
  }

  BonXai.tweet = { extractTweet };
})(typeof globalThis !== 'undefined' ? globalThis : self);
