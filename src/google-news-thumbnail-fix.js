// Google News thumbnail enrichment from the search-results page.
//
// Google News RSS article URLs no longer reliably expose the publisher page to fetch().
// Instead, fetch the Google News search page once per Google source, pair visible result
// cards by title, and copy their actual thumbnail URLs onto the RSS items before saving.

function googleNewsSearchPageUrl(source) {
  const query = String(source?.value || '').trim();
  if (!query) return '';
  return `https://news.google.com/search?q=${encodeURIComponent(query)}&hl=ja&gl=JP&ceid=JP:ja`;
}

function googleTitleVariants(value = '') {
  const raw = stripHtml(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const values = new Set([raw]);

  // Google News RSS commonly appends the publisher with " - Publisher".
  const lastDash = raw.lastIndexOf(' - ');
  if (lastDash > 12 && raw.length - lastDash < 45) values.add(raw.slice(0, lastDash).trim());

  // Some Japanese feeds use a full-width vertical bar or similar source suffix.
  const lastBar = Math.max(raw.lastIndexOf(' | '), raw.lastIndexOf('｜'));
  if (lastBar > 12 && raw.length - lastBar < 45) values.add(raw.slice(0, lastBar).trim());

  return Array.from(values).filter(Boolean);
}

function googleTitleKey(value = '') {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[!！?？。、，,.・:：;；'"“”‘’「」『』【】（）()\[\]［］〈〉《》<>…‥―—–ー\-_|｜/\\]/g, '');
}

function googleCandidateImageUrl(image, baseUrl) {
  if (!image) return '';
  const rawCandidates = [
    candidateFromSrcset(image.getAttribute('srcset') || image.getAttribute('data-srcset') || '', baseUrl),
    image.getAttribute('src'),
    image.getAttribute('data-src'),
    image.getAttribute('data-lazy-src'),
    image.getAttribute('data-original')
  ];

  for (const raw of rawCandidates) {
    const url = resolveHttpUrl(raw, baseUrl);
    if (!url) continue;
    const haystack = `${url} ${image.getAttribute('alt') || ''} ${image.getAttribute('class') || ''}`.toLowerCase();
    if (/logo|favicon|icon|avatar|sprite|emoji|tracking|pixel|spacer/.test(haystack)) continue;
    if (/google\s*news|googleニュース/.test(haystack)) continue;

    const width = Number.parseInt(image.getAttribute('width') || '0', 10);
    const height = Number.parseInt(image.getAttribute('height') || '0', 10);
    if (width && height && (width < 120 || height < 70)) continue;
    return url;
  }
  return '';
}

function googleResultTitleFromCard(card) {
  const selectors = [
    'a.JtKRv',
    'h3 a[href]',
    'h4 a[href]',
    'a[href*="./articles/"]',
    'a[href*="/articles/"]',
    'a[href]'
  ];

  for (const selector of selectors) {
    for (const anchor of Array.from(card.querySelectorAll(selector))) {
      const text = (anchor.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length >= 12) return text;
    }
  }
  return '';
}

function googleResultImageFromCard(card, baseUrl) {
  for (const image of Array.from(card.querySelectorAll('img'))) {
    const url = googleCandidateImageUrl(image, baseUrl);
    if (url) return url;
  }
  return '';
}

function googleAddThumbnailCandidate(index, title, imageUrl) {
  if (!title || !imageUrl) return;
  for (const variant of googleTitleVariants(title)) {
    const key = googleTitleKey(variant);
    if (key.length < 10 || index.has(key)) continue;
    index.set(key, { title: variant, key, imageUrl });
  }
}

function googleNewsSearchThumbnailIndex(html, baseUrl) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const index = new Map();

  // Current Google News search results use <article> cards. Keep selectors broad so
  // modest class-name changes do not break thumbnail matching.
  for (const card of Array.from(doc.querySelectorAll('article'))) {
    const title = googleResultTitleFromCard(card);
    const imageUrl = googleResultImageFromCard(card, baseUrl);
    googleAddThumbnailCandidate(index, title, imageUrl);
  }

  // Fallback for layouts where the result card is not an <article>: find a title link
  // and walk up only a few ancestors until a nearby image appears.
  const anchors = Array.from(doc.querySelectorAll('a[href]'));
  for (const anchor of anchors) {
    const title = (anchor.textContent || '').replace(/\s+/g, ' ').trim();
    if (title.length < 12) continue;

    let node = anchor.parentElement;
    for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
      const imageUrl = googleResultImageFromCard(node, baseUrl);
      if (!imageUrl) continue;
      googleAddThumbnailCandidate(index, title, imageUrl);
      break;
    }
  }

  return index;
}

function googleTitleMatchScore(articleKey, candidateKey) {
  if (!articleKey || !candidateKey) return 0;
  if (articleKey === candidateKey) return 1;
  const shorter = articleKey.length <= candidateKey.length ? articleKey : candidateKey;
  const longer = articleKey.length > candidateKey.length ? articleKey : candidateKey;
  if (shorter.length >= 14 && longer.includes(shorter)) return shorter.length / longer.length;

  // Dice coefficient on character bigrams; conservative threshold is applied below.
  if (articleKey.length < 12 || candidateKey.length < 12) return 0;
  const a = new Map();
  for (let i = 0; i < articleKey.length - 1; i++) {
    const gram = articleKey.slice(i, i + 2);
    a.set(gram, (a.get(gram) || 0) + 1);
  }
  let overlap = 0;
  let bCount = 0;
  for (let i = 0; i < candidateKey.length - 1; i++) {
    const gram = candidateKey.slice(i, i + 2);
    bCount++;
    const remaining = a.get(gram) || 0;
    if (remaining > 0) {
      overlap++;
      a.set(gram, remaining - 1);
    }
  }
  return (2 * overlap) / Math.max(1, (articleKey.length - 1) + bCount);
}

function googleThumbnailForItem(item, index) {
  const variants = googleTitleVariants(item?.title || '');

  for (const variant of variants) {
    const key = googleTitleKey(variant);
    const exact = index.get(key);
    if (exact) return exact.imageUrl;
  }

  let best = null;
  for (const variant of variants) {
    const articleKey = googleTitleKey(variant);
    for (const candidate of index.values()) {
      const score = googleTitleMatchScore(articleKey, candidate.key);
      if (!best || score > best.score) best = { score, imageUrl: candidate.imageUrl };
    }
  }
  return best && best.score >= 0.86 ? best.imageUrl : '';
}

async function enrichGoogleNewsItemsFromSearch(items, source) {
  // Always discard images embedded in Google News RSS itself. Those frequently resolve
  // to the same Google News branding placeholder for every article.
  for (const item of items) item.imageUrl = '';

  const searchUrl = googleNewsSearchPageUrl(source);
  if (!searchUrl || !items.length) return items;

  try {
    const page = await fetchHtmlPage(searchUrl);
    if (!page?.html) return items;
    const index = googleNewsSearchThumbnailIndex(page.html, page.finalUrl || searchUrl);
    if (!index.size) {
      console.debug('Google News search thumbnail: no result cards found', source?.name || source?.value || '');
      return items;
    }

    let matched = 0;
    for (const item of items) {
      const imageUrl = googleThumbnailForItem(item, index);
      if (!imageUrl) continue;
      item.imageUrl = imageUrl;
      matched++;
    }
    console.debug(`Google News search thumbnail: ${matched}/${items.length} matched`, source?.name || source?.value || '');
  } catch (error) {
    console.debug('Google News search thumbnail enrichment failed', source?.name || source?.value || '', error);
  }
  return items;
}

// Override the refresh worker so Google News sources get one bulk thumbnail lookup before
// normalization/storage. Non-Google sources retain the normal path unchanged.
async function v032FetchOneSource(source) {
  try {
    const url = sourceUrl(source);
    const meta = await fetchFeedMeta(url);

    if (!looksLikeFeedDocument(meta.text)) {
      throw new Error('RSS / Atom / RDFとして認識できませんでした');
    }

    const parsed = parseFeed(meta.text, source, meta.finalUrl || url);
    if (source.type === 'google') await enrichGoogleNewsItemsFromSearch(parsed, source);
    const normalized = await normalizeItems(parsed, source);

    return {
      ok: true,
      source,
      articles: normalized,
      sourcePatch: {
        feedFailCount: 0,
        feedHealthStatus: 'ok',
        feedLastError: '',
        feedLastFailureAt: '',
        registrationWarning: false,
        feedLastSuccessAt: new Date().toISOString()
      }
    };
  } catch (error) {
    console.warn('フィード取得エラー:', source.name, error);
    return {
      ok: false,
      source,
      articles: [],
      error,
      sourcePatch: {
        feedFailCount: Number(source.feedFailCount || 0) + 1,
        feedHealthStatus: 'error',
        feedLastError: error?.message || String(error),
        feedLastFailureAt: new Date().toISOString()
      }
    };
  }
}

// Accept only the thumbnail selected above for Google News. This function intentionally
// replaces the previous workaround that tried to follow each Google News article URL.
async function normalizeItems(items, source) {
  const result = [];
  for (const item of items) {
    const title = stripHtml(item.title || '(無題)');
    const url = item.url || '';
    const basis = item.guid || url || `${source.id}|${title}|${item.publishedAt}`;
    result.push({
      id: await hashText(basis),
      sourceId: source.id,
      sourceName: source.name,
      sourceType: source.type,
      title,
      description: stripHtml(item.description || '').slice(0, 500),
      imageUrl: resolveHttpUrl(item.imageUrl || '', url || sourceUrl(source)),
      imageCheckedAt: source.type === 'google' ? new Date().toISOString() : '',
      url,
      publishedAt: normalizeDate(item.publishedAt),
      fetchedAt: new Date().toISOString(),
      read: false,
      favorite: false
    });
  }
  return result;
}

// Google News thumbnails are now handled in bulk during refresh. Do not run the old
// per-article redirect/image fallback for Google sources; it is both slower and unreliable.
const googleNewsOriginalShouldEnrichImage = shouldEnrichImage;
shouldEnrichImage = function(article) {
  if (article?.sourceType === 'google') return false;
  return googleNewsOriginalShouldEnrichImage(article);
};
