// v0.1.22: RSS 1.0 / RDF parser support only
// --------------------------------------------
// Automatic feed repair / URL rewriting was removed in v0.1.22.

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
