// v0.1.17: one-input registration + RSS 1.0/RDF + legacy URL recovery
function detectSourceInput(raw = '') {
  const value = String(raw || '').trim();
  if (!value) return { type: '', value: '' };
  if (/^@?[A-Za-z0-9_]{1,15}$/.test(value) && value.startsWith('@')) {
    return { type: 'x', value: normalizeXHandle(value) };
  }
  if (/^https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\//i.test(value)) {
    return { type: 'x', value: normalizeXHandle(value) };
  }
  if (/^https?:\/\//i.test(value)) return { type: 'rss', value };
  return { type: 'google', value };
}

function feedDocumentTitle(xmlText = '') {
  try {
    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    if (doc.querySelector('parsererror')) return '';
    const channelTitle = doc.querySelector('channel > title')?.textContent?.trim();
    const feedTitle = Array.from(doc.documentElement?.children || [])
      .find(node => node.localName === 'title')?.textContent?.trim();
    return channelTitle || feedTitle || '';
  } catch {
    return '';
  }
}

function looksLikeFeedXml(xmlText = '') {
  try {
    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    if (doc.querySelector('parsererror')) return false;
    const root = (doc.documentElement?.localName || '').toLowerCase();
    return ['rss', 'feed', 'rdf'].includes(root) || Boolean(doc.querySelector('channel > item, entry'));
  } catch {
    return false;
  }
}

function siteDisplayNameFromHtml(html = '', fallbackUrl = '') {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const candidates = [
      doc.querySelector('meta[property="og:site_name"]')?.getAttribute('content'),
      doc.querySelector('meta[name="application-name"]')?.getAttribute('content'),
      doc.querySelector('meta[name="apple-mobile-web-app-title"]')?.getAttribute('content'),
      doc.querySelector('title')?.textContent
    ];
    for (const candidate of candidates) {
      const clean = String(candidate || '').replace(/\s+/g, ' ').trim();
      if (clean) return clean.slice(0, 100);
    }
  } catch { /* noop */ }
  try { return new URL(fallbackUrl).hostname.replace(/^www\./, ''); } catch { return 'WEBフィード'; }
}

function discoverFeedUrlFromHtml(html = '', baseUrl = '') {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const links = Array.from(doc.querySelectorAll('link[rel~="alternate"][href]'));
    const preferred = links.find(link => /(?:application|text)\/(?:rss|atom)\+?xml/i.test(link.getAttribute('type') || ''))
      || links.find(link => /rss|atom/i.test(`${link.getAttribute('type') || ''} ${link.getAttribute('title') || ''} ${link.getAttribute('href') || ''}`));
    return preferred ? resolveHttpUrl(preferred.getAttribute('href'), baseUrl) : '';
  } catch {
    return '';
  }
}

function looksLikeExplicitFeedUrl(value = '') {
  try {
    const url = new URL(value);
    return /(?:^|[\/._-])(rss|feed|atom)(?:[\/._-]|$)|\.(?:xml|rdf|rss|atom)(?:$|[?#])/i.test(url.pathname + url.search);
  } catch { return false; }
}
function unreadableRegisteredFeed(value, categoryId, error) {
  let name = 'WEBフィード';
  try { name = new URL(value).hostname.replace(/^www\./, ''); } catch { /* noop */ }
  return { id: uid(), type: 'rss', name, value, categoryId, feedFailCount: 1, feedHealthStatus: 'error', feedLastError: error?.message || String(error || 'フィードを読み込めませんでした'), feedLastFailureAt: new Date().toISOString(), registrationWarning: true };
}
async function prepareAutoSource(rawValue, categoryId = '') {
  const detected = detectSourceInput(rawValue);
  if (!detected.type) throw new Error('URL・Xアカウント・キーワードを入力してください。');
  if (detected.type === 'google') return { id: uid(), type: 'google', name: detected.value, value: detected.value, categoryId };
  if (detected.type === 'x') {
    if (!detected.value) throw new Error('Xアカウントを判定できませんでした。');
    let name = detected.value;
    try { const xml = await fetchXml(sourceUrl({ type: 'x', value: detected.value })); const title = feedDocumentTitle(xml); if (title) name = title.replace(/\s*\(@?[^)]+\)\s*$/, '').trim() || detected.value; } catch { /* fallback */ }
    return { id: uid(), type: 'x', name, value: detected.value, categoryId };
  }
  const url = detected.value;
  const explicit = looksLikeExplicitFeedUrl(url);
  let directError = null;
  try {
    const meta = await fetchFeedMeta(url);
    if (looksLikeFeedDocument(meta.text)) {
      let name = feedDocumentTitle(meta.text);
      if (!name) { try { name = new URL(url).hostname.replace(/^www\./, ''); } catch { name = 'WEBフィード'; } }
      return { id: uid(), type: 'rss', name, value: url, categoryId, feedFailCount: 0, feedHealthStatus: 'ok', feedLastError: '', feedLastSuccessAt: new Date().toISOString() };
    }
    directError = new Error('RSS / Atom / RDFとして認識できませんでした');
    if (explicit) return unreadableRegisteredFeed(url, categoryId, directError);
  } catch (error) {
    directError = error;
    if (explicit) return unreadableRegisteredFeed(url, categoryId, error);
  }
  let page = null;
  try { page = await fetchHtmlPage(url); } catch (error) { throw directError || error; }
  if (!page) throw new Error('Webサイトを取得できませんでした。');
  const siteName = siteDisplayNameFromHtml(page.html, page.finalUrl || url);
  const discovered = discoverFeedUrlFromHtml(page.html, page.finalUrl || url);
  if (!discovered) throw new Error('このWebサイトからRSS / Atomを見つけられませんでした。');
  try {
    const meta = await fetchFeedMeta(discovered);
    if (!looksLikeFeedDocument(meta.text)) throw new Error('見つかったURLをRSS / Atom / RDFとして読み込めませんでした');
    return { id: uid(), type: 'rss', name: feedDocumentTitle(meta.text) || siteName || 'WEBフィード', value: discovered, categoryId, feedFailCount: 0, feedHealthStatus: 'ok', feedLastError: '', feedLastSuccessAt: new Date().toISOString() };
  } catch (error) {
    const source = unreadableRegisteredFeed(discovered, categoryId, error); source.name = siteName || source.name; return source;
  }
}

function updateAutoSourceDetectionHint() {
  const hint = document.getElementById('sourceDetectHint');
  if (!hint) return;
  const detected = detectSourceInput(elements.sourceValue.value);
  const labels = { rss: 'WEB RSS', x: 'X / Nitter', google: 'Google News キーワード' };
  hint.textContent = detected.type ? `自動判定：${labels[detected.type]}` : '自動判定：入力待ち';
}
