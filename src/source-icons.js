// v0.1.15: WEBサイトがHTMLで指定しているfaviconを直接取得する。
const SOURCE_ICON_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
let sourceIconDiscoveryRunning = false;
let sourceIconDiscoveryPending = false;

function extractFeedSiteUrl(xmlText, feedUrl = '') {
  try {
    const xml = new DOMParser().parseFromString(xmlText, 'application/xml');
    if (xml.querySelector('parsererror')) return '';
    const rssLink = xml.querySelector('channel > link')?.textContent?.trim();
    const resolvedRss = resolveHttpUrl(rssLink, feedUrl);
    if (resolvedRss) return resolvedRss;
    const atomLink = xml.querySelector('feed > link[rel="alternate"]') || xml.querySelector('feed > link[href]');
    const resolvedAtom = resolveHttpUrl(atomLink?.getAttribute('href') || '', feedUrl);
    if (resolvedAtom) return resolvedAtom;
  } catch { /* fallback below */ }
  return '';
}

function siteIconScore(node) {
  const rel = (node.getAttribute('rel') || '').toLowerCase();
  const sizes = (node.getAttribute('sizes') || '').toLowerCase();
  let score = 0;
  if (rel.split(/\s+/).includes('icon')) score += 100;
  if (rel.includes('apple-touch-icon')) score += 70;
  if (rel.includes('mask-icon')) score += 20;
  if (sizes === 'any') score += 40;
  const match = sizes.match(/(\d+)x(\d+)/);
  if (match) score += Math.min(60, Math.max(Number(match[1]), Number(match[2])) / 4);
  const type = (node.getAttribute('type') || '').toLowerCase();
  if (type.includes('svg')) score += 15;
  if (type.includes('png')) score += 10;
  return score;
}

function extractDeclaredSiteIcon(html, baseUrl) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const nodes = Array.from(doc.querySelectorAll(
    'link[rel~="icon"][href], link[rel*="apple-touch-icon"][href], link[rel="mask-icon"][href]'
  ));
  const candidates = nodes
    .map(node => ({ url: resolveHttpUrl(node.getAttribute('href') || '', baseUrl), score: siteIconScore(node) }))
    .filter(item => item.url)
    .sort((a, b) => b.score - a.score);
  return candidates[0]?.url || '';
}

function fallbackSitePageUrl(source, allArticles = []) {
  const article = allArticles
    .filter(item => item.sourceId === source.id && item.url)
    .sort((a, b) => new Date(b.publishedAt || 0).getTime() - new Date(a.publishedAt || 0).getTime())
    .find(item => {
      try {
        const host = new URL(item.url).hostname.toLowerCase();
        return host && !/(^|\.)(youtube\.com|youtu\.be|x\.com|twitter\.com|news\.google\.com)$/.test(host) && !host.includes('nitter.');
      } catch { return false; }
    });
  if (article?.url) return article.url;
  try { return new URL(source.value).origin + '/'; } catch { return ''; }
}

async function discoverDirectSiteIcon(source, allArticles = []) {
  if (!source || source.type !== 'rss') return null;
  let siteUrl = source.siteUrl || '';
  if (!siteUrl) {
    try {
      const feedUrl = sourceUrl(source);
      const xmlText = await fetchXml(feedUrl);
      siteUrl = extractFeedSiteUrl(xmlText, feedUrl);
    } catch (error) {
      console.debug('フィード元サイトURLの取得をスキップ:', source.name, error);
    }
  }
  if (!siteUrl) siteUrl = fallbackSitePageUrl(source, allArticles);
  if (!siteUrl) return { siteUrl: '', siteIconUrl: '', siteIconCheckedAt: new Date().toISOString() };

  let page = null;
  try { page = await fetchHtmlPage(siteUrl); }
  catch (error) { console.debug('サイトアイコン取得をスキップ:', source.name, error); }

  const finalUrl = page?.finalUrl || siteUrl;
  let siteIconUrl = page ? extractDeclaredSiteIcon(page.html, finalUrl) : '';
  if (!siteIconUrl) {
    try { siteIconUrl = `${new URL(finalUrl).origin}/favicon.ico`; } catch { siteIconUrl = ''; }
  }
  return { siteUrl: finalUrl, siteIconUrl, siteIconCheckedAt: new Date().toISOString() };
}

async function patchSourceIconMetadata(sourceId, patch) {
  const { sources } = await getState();
  const next = sources.map(source => source.id === sourceId ? { ...source, ...patch } : source);
  await saveSources(next);
  const updated = next.find(source => source.id === sourceId);
  if (!updated) return;
  document.querySelectorAll(`.source-item[data-source-id="${CSS.escape(sourceId)}"] .source-kind-icon`).forEach(holder => {
    holder.innerHTML = sourceIconHtml(updated, []);
    attachSourceFaviconFallbacks(holder);
  });
  document.querySelectorAll(`.source-row[data-id="${CSS.escape(sourceId)}"] .source-type`).forEach(holder => {
    holder.innerHTML = sourceIconHtml(updated, []);
    holder.classList.add('source-manager-icon');
    attachSourceFaviconFallbacks(holder);
  });
}

function shouldDiscoverSourceIcon(source) {
  if (!source || source.type !== 'rss') return false;
  if (source.siteIconUrl) return false;
  if (!source.siteIconCheckedAt) return true;
  const checked = new Date(source.siteIconCheckedAt).getTime();
  return !Number.isFinite(checked) || Date.now() - checked > SOURCE_ICON_RETRY_MS;
}

async function discoverMissingSourceIcons(sources, allArticles = []) {
  if (sourceIconDiscoveryRunning) { sourceIconDiscoveryPending = true; return; }
  const targets = sources.filter(shouldDiscoverSourceIcon);
  if (!targets.length) return;
  sourceIconDiscoveryRunning = true;
  try {
    for (const source of targets) {
      const patch = await discoverDirectSiteIcon(source, allArticles);
      if (patch) await patchSourceIconMetadata(source.id, patch);
    }
  } finally {
    sourceIconDiscoveryRunning = false;
    if (sourceIconDiscoveryPending) {
      sourceIconDiscoveryPending = false;
      const [state, articles] = await Promise.all([getState(), dbGetAllArticles()]);
      discoverMissingSourceIcons(state.sources, articles);
    }
  }
}
