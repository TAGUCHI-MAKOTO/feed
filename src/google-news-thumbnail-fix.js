// Google News thumbnail recovery
// Keep genuine Google News proxy thumbnails, reject only branding/placeholders,
// and retry blank Google News cards once per app session.

const GOOGLE_MEDIA_NS = 'http://search.yahoo.com/mrss/';
const googleImageAttemptedThisSession = new Set();

function isGoogleNewsProxyThumbnailUrl(value = '') {
  const url = resolveHttpUrl(value);
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (!(host === 'googleusercontent.com' || host.endsWith('.googleusercontent.com'))) return false;
    const target = `${parsed.pathname}${parsed.search}${parsed.hash}`.toLowerCase();
    return target.includes('/proxy/')
      || /(?:^|[-_=])w\d+(?:[-_=]|$)/.test(target) && /(?:^|[-_=])h\d+(?:[-_=]|$)/.test(target) && /(?:^|[-_=])c(?:[-_=]|$)/.test(target);
  } catch {
    return false;
  }
}

// Compatibility name used by image-enrichment.js.
// TRUE means "Google branding / placeholder", not every Google-hosted image.
function isGoogleNewsImageUrl(value = '') {
  const url = resolveHttpUrl(value);
  if (!url) return false;
  if (isGoogleNewsProxyThumbnailUrl(url)) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'news.google.com'
      || host === 'google.com'
      || host.endsWith('.google.com')
      || host === 'gstatic.com'
      || host.endsWith('.gstatic.com')
      || host === 'googleusercontent.com'
      || host.endsWith('.googleusercontent.com');
  } catch {
    return false;
  }
}

function googleMediaNodes(entry) {
  const nodes = [];
  const add = node => {
    if (node && !nodes.includes(node)) nodes.push(node);
  };

  try {
    Array.from(entry.getElementsByTagNameNS(GOOGLE_MEDIA_NS, 'content')).forEach(add);
    Array.from(entry.getElementsByTagNameNS(GOOGLE_MEDIA_NS, 'thumbnail')).forEach(add);
  } catch { /* namespace fallback below */ }

  Array.from(entry.getElementsByTagName('*')).forEach(node => {
    const local = (node.localName || '').toLowerCase();
    const prefix = (node.prefix || '').toLowerCase();
    if ((node.namespaceURI === GOOGLE_MEDIA_NS || prefix === 'media') && (local === 'content' || local === 'thumbnail')) add(node);
  });

  return nodes;
}

function imageUrlFromHtmlNode(image, baseUrl = '') {
  const values = [
    image.getAttribute('src'),
    image.getAttribute('data-src'),
    image.getAttribute('data-original'),
    image.getAttribute('data-lazy-src'),
    candidateFromSrcset(image.getAttribute('srcset') || image.getAttribute('data-srcset') || '', baseUrl)
  ];
  for (const value of values) {
    const resolved = resolveHttpUrl(value, baseUrl);
    if (resolved) return resolved;
  }
  return '';
}

function extractFirstImageFromHtml(html = '', baseUrl = '') {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const candidates = Array.from(doc.querySelectorAll('img'))
    .map(image => ({ image, url: imageUrlFromHtmlNode(image, baseUrl) }))
    .filter(item => item.url);

  const proxy = candidates.find(item => isGoogleNewsProxyThumbnailUrl(item.url));
  if (proxy) return proxy.url;

  const normal = candidates.find(item => {
    if (isGoogleNewsImageUrl(item.url)) return false;
    const haystack = `${item.url} ${item.image.getAttribute('class') || ''} ${item.image.getAttribute('id') || ''} ${item.image.getAttribute('alt') || ''}`.toLowerCase();
    return !/logo|icon|avatar|sprite|emoji|tracking|pixel|spacer|badge|advert/.test(haystack);
  });
  return normal?.url || '';
}

function imageFromXmlEntry(entry, rawHtml, baseUrl, articleUrl = '') {
  const preferredBase = articleUrl || baseUrl;
  const mediaCandidates = [];

  for (const node of googleMediaNodes(entry)) {
    const rawUrl = node.getAttribute('url') || node.getAttribute('href');
    const medium = (node.getAttribute('medium') || '').toLowerCase();
    const type = (node.getAttribute('type') || '').toLowerCase();
    if (medium && medium !== 'image') continue;
    if (type && !type.startsWith('image/')) continue;
    const resolved = resolveHttpUrl(rawUrl, preferredBase);
    if (resolved) mediaCandidates.push(resolved);
  }

  const proxy = mediaCandidates.find(isGoogleNewsProxyThumbnailUrl);
  if (proxy) return proxy;
  const nonPlaceholder = mediaCandidates.find(url => !isGoogleNewsImageUrl(url));
  if (nonPlaceholder) return nonPlaceholder;

  for (const enclosure of Array.from(entry.getElementsByTagName('enclosure'))) {
    const type = (enclosure.getAttribute('type') || '').toLowerCase();
    if (type && !type.startsWith('image/')) continue;
    const resolved = resolveHttpUrl(enclosure.getAttribute('url'), preferredBase);
    if (resolved && !isGoogleNewsImageUrl(resolved)) return resolved;
  }

  return extractFirstImageFromHtml(rawHtml, preferredBase);
}

async function normalizeItems(items, source) {
  const result = [];
  for (const item of items) {
    const title = stripHtml(item.title || '(無題)');
    const url = item.url || '';
    const basis = item.guid || url || `${source.id}|${title}|${item.publishedAt}`;
    const imageUrl = resolveHttpUrl(item.imageUrl || '', url || sourceUrl(source));
    result.push({
      id: await hashText(basis),
      sourceId: source.id,
      sourceName: source.name,
      sourceType: source.type,
      title,
      description: stripHtml(item.description || '').slice(0, 500),
      imageUrl,
      imageCheckedAt: '',
      url,
      publishedAt: normalizeDate(item.publishedAt),
      fetchedAt: new Date().toISOString(),
      read: false,
      favorite: false
    });
  }
  return result;
}

function shouldEnrichImage(article) {
  if (!article || !article.url || !resolveHttpUrl(article.url)) return false;
  const googleArticle = article.sourceType === 'google';
  const googlePlaceholder = googleArticle && isGoogleNewsImageUrl(article.imageUrl);

  if (article.imageUrl && !googlePlaceholder) return false;

  if (googleArticle) {
    if (googleImageAttemptedThisSession.has(article.id)) return false;
    return true;
  }

  if (!article.imageCheckedAt) return true;
  const checkedAt = new Date(article.imageCheckedAt).getTime();
  return Number.isNaN(checkedAt) || Date.now() - checkedAt > IMAGE_RETRY_MS;
}

function extractImageFromPage(html, baseUrl) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  let hostname = '';
  try { hostname = new URL(baseUrl).hostname.toLowerCase(); } catch { /* noop */ }

  if (hostname === 'news.google.com') {
    const proxyImages = Array.from(doc.querySelectorAll('img'))
      .map(image => imageUrlFromHtmlNode(image, baseUrl))
      .filter(isGoogleNewsProxyThumbnailUrl);
    return { imageUrl: proxyImages[0] || '', doc };
  }

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
    if (resolved && !isGoogleNewsImageUrl(resolved)) return { imageUrl: resolved, doc };
  }

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
    if (!url || isGoogleNewsImageUrl(url) || looksLikeDecorativeImage(url, image)) continue;
    return { imageUrl: url, doc };
  }

  return { imageUrl: '', doc };
}

function enqueueImageEnrichment(article) {
  if (!shouldEnrichImage(article) || imageEnrichQueued.has(article.id)) return;
  if (article.sourceType === 'google') googleImageAttemptedThisSession.add(article.id);
  imageEnrichQueued.add(article.id);
  imageEnrichQueue.push(article);
  pumpImageEnrichmentQueue();
}
