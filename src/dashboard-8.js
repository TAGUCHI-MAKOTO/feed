// v0.1.17: RSS 1.0 / RDF support + legacy feed URL recovery
// -----------------------------------------------------------

// http:// の古いRSS URLで失敗した場合は https:// を自動再試行する。
fetchXml = async function(url) {
  async function fetchOnce(targetUrl) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(targetUrl, {
        cache: 'no-store',
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'Accept': 'application/rss+xml, application/atom+xml, application/rdf+xml, application/xml, text/xml, */*' }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  }

  try {
    return await fetchOnce(url);
  } catch (firstError) {
    if (/^http:\/\//i.test(url)) {
      try {
        return await fetchOnce(url.replace(/^http:\/\//i, 'https://'));
      } catch { /* original error below */ }
    }
    throw firstError;
  }
};

// RSS 2.0 / RSS 1.0(RDF) / Atom を同じ関数で解析する。
parseFeed = function(xmlText, source, feedUrl = '') {
  const xml = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (xml.querySelector('parsererror')) throw new Error('RSS/XMLを解析できませんでした');

  const toItem = item => {
    const link = firstChildText(item, ['link']);
    const rawDescription = firstChildText(item, ['content:encoded', 'description']);
    const rdfAbout = item.getAttributeNS?.('http://www.w3.org/1999/02/22-rdf-syntax-ns#', 'about')
      || item.getAttribute('rdf:about')
      || '';
    return {
      title: firstChildText(item, ['title']) || '(無題)',
      url: resolveHttpUrl(link, feedUrl) || link || rdfAbout,
      description: rawDescription,
      imageUrl: imageFromXmlEntry(item, rawDescription, feedUrl, link || rdfAbout),
      publishedAt: firstChildText(item, ['pubDate', 'dc:date', 'date']),
      guid: firstChildText(item, ['guid']) || rdfAbout || link
    };
  };

  const rssItems = Array.from(xml.querySelectorAll('channel > item'));
  if (rssItems.length) return rssItems.map(toItem);

  const root = xml.documentElement;
  if ((root?.localName || '').toLowerCase() === 'rdf') {
    const rdfItems = Array.from(root.children || []).filter(node => (node.localName || '').toLowerCase() === 'item');
    if (rdfItems.length) return rdfItems.map(toItem);
  }

  const looseRdfItems = Array.from(xml.getElementsByTagName('*')).filter(node =>
    (node.localName || '').toLowerCase() === 'item' && node.parentElement === root
  );
  if (looseRdfItems.length) return looseRdfItems.map(toItem);

  const atomEntries = Array.from(xml.querySelectorAll('feed > entry'));
  return atomEntries.map(entry => {
    const alternate = entry.querySelector('link[rel="alternate"]') || entry.querySelector('link[href]');
    const link = alternate?.getAttribute('href') || '';
    const rawDescription = firstChildText(entry, ['content', 'summary']);
    return {
      title: firstChildText(entry, ['title']) || '(無題)',
      url: resolveHttpUrl(link, feedUrl) || link,
      description: rawDescription,
      imageUrl: imageFromXmlEntry(entry, rawDescription, feedUrl, link),
      publishedAt: firstChildText(entry, ['published', 'updated']),
      guid: firstChildText(entry, ['id'])
    };
  });
};

// v0.1.16 の自動登録を補強。古いRSS URLが死んでいたらサイトトップから現行Feedを再探索する。
const v017BasePrepareSource = v016PrepareSource;
v016PrepareSource = async function(rawValue, categoryId = '') {
  try {
    const source = await v017BasePrepareSource(rawValue, categoryId);
    if (source?.type === 'rss') {
      try {
        const xml = await fetchXml(source.value);
        const parsed = parseFeed(xml, { ...source, id: source.id || 'preview' }, source.value);
        if (!parsed.length) throw new Error('RSSは取得できましたが、記事形式を判定できませんでした。');
      } catch (error) {
        throw error;
      }
    }
    return source;
  } catch (originalError) {
    const detected = v016DetectSourceInput(rawValue);
    if (detected.type !== 'rss') throw originalError;

    let origin = '';
    try { origin = new URL(detected.value).origin + '/'; } catch { throw originalError; }

    let page = null;
    try { page = await fetchHtmlPage(origin); } catch { throw originalError; }
    if (!page) throw originalError;

    const siteName = v016SiteNameFromHtml(page.html, page.finalUrl || origin);
    const feedUrl = v016DiscoverFeedUrl(page.html, page.finalUrl || origin);
    if (!feedUrl) throw originalError;

    const xml = await fetchXml(feedUrl);
    if (!v016LooksLikeFeed(xml)) throw originalError;
    const preview = { id: 'preview', type: 'rss', name: siteName, value: feedUrl, categoryId };
    const parsed = parseFeed(xml, preview, feedUrl);
    if (!parsed.length) throw originalError;

    return {
      id: uid(),
      type: 'rss',
      name: v016FeedTitle(xml) || siteName || 'WEBフィード',
      value: feedUrl,
      categoryId
    };
  }
};
