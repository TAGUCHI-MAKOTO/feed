function bindThumbError(image, articleId) {
  image.addEventListener('error', async () => {
    const thumb = image.closest('.article-thumb');
    const content = image.closest('.article-content');
    if (thumb) thumb.remove();
    if (content) content.classList.remove('has-image');
    await dbPatchArticle(articleId, { imageUrl: '', imageCheckedAt: new Date().toISOString() });
  }, { once: true });
}

function attachArticleEvents() {
  $$('.article-card').forEach(card => {
    const id = card.dataset.id;

    card.querySelector('.favorite-btn').addEventListener('click', async (event) => {
      event.stopPropagation();
      const article = renderedArticleMap.get(id);
      if (article) {
        const nextFavorite = !article.favorite;
        await dbPatchArticle(id, { favorite: nextFavorite });
        if (!nextFavorite) await cleanupExpiredArticles();
      }
      await render();
    });

    card.querySelector('.read-btn').addEventListener('click', async (event) => {
      event.stopPropagation();
      const article = renderedArticleMap.get(id);
      if (article) await setStoryReadState(id, !article.read);
      await render();
    });

    card.querySelectorAll('.article-link').forEach(link => {
      link.addEventListener('click', async () => {
        await setStoryReadState(id, true);
        setTimeout(render, 150);
      });
    });

    const duplicateToggle = card.querySelector('.duplicate-toggle');
    if (duplicateToggle) {
      duplicateToggle.addEventListener('click', event => {
        event.stopPropagation();
        const list = card.querySelector('.duplicate-list');
        const open = list?.hidden !== false;
        if (list) list.hidden = !open;
        duplicateToggle.setAttribute('aria-expanded', String(open));
        duplicateToggle.querySelector('.duplicate-chevron').textContent = open ? '▴' : '▾';
      });
    }

    card.querySelectorAll('.duplicate-link').forEach(link => {
      link.addEventListener('click', async () => {
        await setStoryReadState(link.dataset.articleId || id, true);
        setTimeout(render, 150);
      });
    });

    const image = card.querySelector('.article-thumb img');
    if (image) bindThumbError(image, id);
  });
}

function shouldEnrichImage(article) {
  if (!article || article.imageUrl || !article.url) return false;
  if (!resolveHttpUrl(article.url)) return false;
  if (!article.imageCheckedAt) return true;
  const checkedAt = new Date(article.imageCheckedAt).getTime();
  return Number.isNaN(checkedAt) || Date.now() - checkedAt > IMAGE_RETRY_MS;
}

async function fetchHtmlPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const type = (response.headers.get('content-type') || '').toLowerCase();
    if (type && !type.includes('html') && !type.includes('xhtml')) return null;
    return { html: await response.text(), finalUrl: response.url || url };
  } finally {
    clearTimeout(timer);
  }
}

function getImageAttr(image, baseUrl) {
  const candidates = [
    image.getAttribute('src'),
    image.getAttribute('data-src'),
    image.getAttribute('data-original'),
    image.getAttribute('data-lazy-src'),
    candidateFromSrcset(image.getAttribute('srcset') || image.getAttribute('data-srcset') || '', baseUrl)
  ];
  for (const candidate of candidates) {
    const resolved = resolveHttpUrl(candidate, baseUrl);
    if (resolved) return resolved;
  }
  return '';
}

function looksLikeDecorativeImage(url, image) {
  const haystack = `${url} ${image.getAttribute('class') || ''} ${image.getAttribute('id') || ''} ${image.getAttribute('alt') || ''}`.toLowerCase();
  if (/logo|icon|avatar|sprite|emoji|tracking|pixel|spacer|badge|advert|(^|[-_])ad([-_]|$)/i.test(haystack)) return true;

  const width = Number.parseInt(image.getAttribute('width') || '0', 10);
  const height = Number.parseInt(image.getAttribute('height') || '0', 10);
  if (width && height && (width < 180 || height < 90)) return true;
  return false;
}

function extractImageFromPage(html, baseUrl) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const metaSelectors = [
    'meta[property="og:image:secure_url"]',
    'meta[property="og:image"]',
    'meta[property="og:image:url"]',
    'meta[name="twitter:image"]',
    'meta[name="twitter:image:src"]',
    'link[rel="image_src"]'
  ];

  for (const selector of metaSelectors) {
    const node = doc.querySelector(selector);
    const raw = node?.getAttribute('content') || node?.getAttribute('href');
    const resolved = resolveHttpUrl(raw, baseUrl);
    if (resolved) return { imageUrl: resolved, doc };
  }

  let hostname = '';
  try { hostname = new URL(baseUrl).hostname; } catch { /* noop */ }
  if (hostname === 'news.google.com') return { imageUrl: '', doc };

  const imageCandidates = [
    ...Array.from(doc.querySelectorAll('article img')),
    ...Array.from(doc.querySelectorAll('main img')),
    ...Array.from(doc.querySelectorAll('img'))
  ];
  const seen = new Set();

  for (const image of imageCandidates) {
    if (seen.has(image)) continue;
    seen.add(image);
    const url = getImageAttr(image, baseUrl);
    if (!url || looksLikeDecorativeImage(url, image)) continue;
    return { imageUrl: url, doc };
  }

  return { imageUrl: '', doc };
}

function googleExternalArticleCandidate(doc, baseUrl) {
  let baseHost = '';
  try { baseHost = new URL(baseUrl).hostname; } catch { return ''; }
  if (baseHost !== 'news.google.com') return '';

  const rejectedHosts = ['google.com', 'www.google.com', 'news.google.com', 'accounts.google.com', 'support.google.com', 'policies.google.com', 'gstatic.com', 'googleusercontent.com'];
  const anchors = [
    ...Array.from(doc.querySelectorAll('article a[href]')),
    ...Array.from(doc.querySelectorAll('main a[href]'))
  ];

  for (const anchor of anchors) {
    const href = resolveHttpUrl(anchor.getAttribute('href'), baseUrl);
    if (!href) continue;
    try {
      const host = new URL(href).hostname;
      if (rejectedHosts.some(rejected => host === rejected || host.endsWith(`.${rejected}`))) continue;
      if ((anchor.textContent || '').trim().length < 4) continue;
      return href;
    } catch {
    }
  }
  return '';
}

async function fetchPreviewImage(article) {
  const first = await fetchHtmlPage(article.url);
  if (!first) return '';

  const firstResult = extractImageFromPage(first.html, first.finalUrl);
  if (firstResult.imageUrl) return firstResult.imageUrl;

  if (article.sourceType === 'google' || (() => {
    try { return new URL(first.finalUrl).hostname === 'news.google.com'; } catch { return false; }
  })()) {
    const externalUrl = googleExternalArticleCandidate(firstResult.doc, first.finalUrl);
    if (externalUrl) {
      try {
        const second = await fetchHtmlPage(externalUrl);
        if (second) return extractImageFromPage(second.html, second.finalUrl).imageUrl;
      } catch (error) {
        console.debug('Google News image fallback failed', error);
      }
    }
  }

  return '';
}

function insertImageIntoCard(article, imageUrl) {
  const card = document.querySelector(`.article-card[data-id="${CSS.escape(article.id)}"]`);
  if (!card) return;
  const content = card.querySelector('.article-content');
  if (!content || content.querySelector('.article-thumb')) return;

  const thumb = document.createElement('a');
  thumb.className = 'article-thumb article-link';
  thumb.href = article.url || imageUrl;
  thumb.target = '_blank';
  thumb.rel = 'noreferrer';
  thumb.tabIndex = -1;
  thumb.setAttribute('aria-label', article.title || '記事画像');

  const image = document.createElement('img');
  image.src = imageUrl;
  image.alt = '';
  image.loading = 'lazy';
  image.decoding = 'async';
  image.referrerPolicy = 'no-referrer';
  bindThumbError(image, article.id);

  thumb.addEventListener('click', async () => {
    await dbPatchArticle(article.id, { read: true });
    setTimeout(render, 150);
  });

  thumb.appendChild(image);
  content.prepend(thumb);
  content.classList.add('has-image');
}

function enqueueImageEnrichment(article) {
  if (!shouldEnrichImage(article) || imageEnrichQueued.has(article.id)) return;
  imageEnrichQueued.add(article.id);
  imageEnrichQueue.push(article);
  pumpImageEnrichmentQueue();
}

function pumpImageEnrichmentQueue() {
  while (imageEnrichActive < IMAGE_ENRICH_CONCURRENCY && imageEnrichQueue.length) {
    const article = imageEnrichQueue.shift();
    imageEnrichActive++;

    (async () => {
      let imageUrl = '';
      try {
        imageUrl = await fetchPreviewImage(article);
      } catch (error) {
        console.debug('画像補完をスキップ:', article.title, error);
      }

      const checkedAt = new Date().toISOString();
      await dbPatchArticle(article.id, { imageUrl: imageUrl || '', imageCheckedAt: checkedAt });

      if (imageUrl) {
        const updated = { ...article, imageUrl, imageCheckedAt: checkedAt };
        renderedArticleMap.set(article.id, updated);
        insertImageIntoCard(updated, imageUrl);
      }
    })().finally(() => {
      imageEnrichActive--;
      imageEnrichQueued.delete(article.id);
      pumpImageEnrichmentQueue();
    });
  }
}

function setupLazyImageEnrichment(visible, viewMode) {
  if (imageObserver) imageObserver.disconnect();
  if (viewMode !== 'card') return;

  const candidates = visible.filter(shouldEnrichImage);
  if (!candidates.length) return;

  const articleById = new Map(candidates.map(article => [article.id, article]));

  if (!('IntersectionObserver' in window)) {
    candidates.slice(0, 12).forEach(enqueueImageEnrichment);
    return;
  }

  imageObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      imageObserver.unobserve(entry.target);
      const article = articleById.get(entry.target.dataset.id);
      if (article) enqueueImageEnrichment(article);
    }
  }, { rootMargin: '500px 0px' });

  for (const article of candidates) {
    const card = document.querySelector(`.article-card[data-id="${CSS.escape(article.id)}"]`);
    if (card) imageObserver.observe(card);
  }
}
