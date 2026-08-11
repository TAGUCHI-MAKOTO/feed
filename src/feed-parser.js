async function fetchXml(url) {
  const meta = await fetchFeedMeta(url);
  return meta.text;
}

function resolveHttpUrl(value = '', baseUrl = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const resolved = new URL(raw, baseUrl || undefined);
    if (!['http:', 'https:'].includes(resolved.protocol)) return '';
    return resolved.href;
  } catch {
    return '';
  }
}

function candidateFromSrcset(srcset = '', baseUrl = '') {
  if (!srcset) return '';
  const candidates = srcset.split(',')
    .map(part => part.trim().split(/\s+/)[0])
    .map(value => resolveHttpUrl(value, baseUrl))
    .filter(Boolean);
  return candidates.at(-1) || '';
}

function extractFirstImageFromHtml(html = '', baseUrl = '') {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const image = doc.querySelector('img');
  if (!image) return '';

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

function firstChildText(root, tagNames) {
  for (const name of tagNames) {
    const node = root.getElementsByTagName(name)[0];
    const value = node?.textContent?.trim();
    if (value) return value;
  }
  return '';
}

function imageFromXmlEntry(entry, rawHtml, baseUrl, articleUrl = '') {
  const preferredBase = articleUrl || baseUrl;
  const mediaTags = ['media:content', 'media:thumbnail', 'thumbnail'];

  for (const tag of mediaTags) {
    for (const node of Array.from(entry.getElementsByTagName(tag))) {
      const rawUrl = node.getAttribute('url') || node.getAttribute('href');
      const medium = (node.getAttribute('medium') || '').toLowerCase();
      const type = (node.getAttribute('type') || '').toLowerCase();
      if (medium && medium !== 'image') continue;
      if (type && !type.startsWith('image/')) continue;
      const resolved = resolveHttpUrl(rawUrl, preferredBase);
      if (resolved) return resolved;
    }
  }

  for (const enclosure of Array.from(entry.getElementsByTagName('enclosure'))) {
    const type = (enclosure.getAttribute('type') || '').toLowerCase();
    if (type && !type.startsWith('image/')) continue;
    const resolved = resolveHttpUrl(enclosure.getAttribute('url'), preferredBase);
    if (resolved) return resolved;
  }

  return extractFirstImageFromHtml(rawHtml, preferredBase);
}

function parseFeed(xmlText, source, feedUrl = '') {
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
    (node.localName || '').toLowerCase() === 'item' &&
    node.parentElement === root
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
}

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

