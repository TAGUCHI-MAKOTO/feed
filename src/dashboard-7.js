// v0.1.15: direct website favicon discovery + cleaner empty folders
// ---------------------------------------------------------------
const V015_SOURCE_ICON_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
let v015SourceIconDiscoveryRunning = false;
let v015SourceIconDiscoveryPending = false;

// v0.1.14 used /favicon.ico guessing. For WEB RSS, only use an icon that was
// discovered from the website HTML. Google News / X keep their known icons.
v014SourceFaviconUrl = function(source, allArticles = []) {
  if (!source) return '';
  if (source.type === 'google') return 'https://news.google.com/favicon.ico';
  if (source.type === 'x') return 'https://x.com/favicon.ico';
  return source.siteIconUrl || '';
};

function v015ExtractFeedSiteUrl(xmlText, feedUrl = '') {
  try {
    const xml = new DOMParser().parseFromString(xmlText, 'application/xml');
    if (xml.querySelector('parsererror')) return '';

    const rssLink = xml.querySelector('channel > link')?.textContent?.trim();
    const resolvedRss = resolveHttpUrl(rssLink, feedUrl);
    if (resolvedRss) return resolvedRss;

    const atomLink = xml.querySelector('feed > link[rel="alternate"]') || xml.querySelector('feed > link[href]');
    const resolvedAtom = resolveHttpUrl(atomLink?.getAttribute('href') || '', feedUrl);
    if (resolvedAtom) return resolvedAtom;
  } catch {
    // fall through
  }
  return '';
}

function v015SiteIconScore(node) {
  const rel = (node.getAttribute('rel') || '').toLowerCase();
  const sizes = (node.getAttribute('sizes') || '').toLowerCase();
  const type = (node.getAttribute('type') || '').toLowerCase();
  let score = 0;

  if (rel.split(/\s+/).includes('icon')) score += 100;
  if (rel.includes('apple-touch-icon')) score += 70;
  if (rel.includes('mask-icon')) score += 20;
  if (sizes === 'any') score += 40;

  const match = sizes.match(/(\d+)x(\d+)/);
  if (match) score += Math.min(60, Math.max(Number(match[1]), Number(match[2])) / 4);
  if (type.includes('svg')) score += 15;
  if (type.includes('png')) score += 10;
  return score;
}

function v015ExtractDeclaredSiteIcon(html, baseUrl) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const nodes = Array.from(doc.querySelectorAll(
    'link[rel~="icon"][href], link[rel*="apple-touch-icon"][href], link[rel="mask-icon"][href]'
  ));

  const candidates = nodes
    .map(node => ({
      url: resolveHttpUrl(node.getAttribute('href') || '', baseUrl),
      score: v015SiteIconScore(node)
    }))
    .filter(item => item.url)
    .sort((a, b) => b.score - a.score);

  return candidates[0]?.url || '';
}

function v015FallbackSitePageUrl(source, allArticles = []) {
  const article = allArticles
    .filter(item => item.sourceId === source.id && item.url)
    .sort((a, b) => new Date(b.publishedAt || 0).getTime() - new Date(a.publishedAt || 0).getTime())
    .find(item => {
      try {
        const host = new URL(item.url).hostname.toLowerCase();
        return host
          && !/(^|\.)(youtube\.com|youtu\.be|x\.com|twitter\.com|news\.google\.com)$/.test(host)
          && !host.includes('nitter.');
      } catch {
        return false;
      }
    });

  if (article?.url) return article.url;
  try {
    return new URL(source.value).origin + '/';
  } catch {
    return '';
  }
}

async function v015DiscoverDirectSiteIcon(source, allArticles = []) {
  if (!source || source.type !== 'rss') return null;

  let siteUrl = source.siteUrl || '';
  if (!siteUrl) {
    try {
      const feedUrl = sourceUrl(source);
      const xmlText = await fetchXml(feedUrl);
      siteUrl = v015ExtractFeedSiteUrl(xmlText, feedUrl);
    } catch (error) {
      console.debug('フィード元サイトURLの取得をスキップ:', source.name, error);
    }
  }

  if (!siteUrl) siteUrl = v015FallbackSitePageUrl(source, allArticles);
  if (!siteUrl) {
    return { siteUrl: '', siteIconUrl: '', siteIconCheckedAt: new Date().toISOString() };
  }

  let page = null;
  try {
    page = await fetchHtmlPage(siteUrl);
  } catch (error) {
    console.debug('サイトアイコン取得をスキップ:', source.name, error);
  }

  const finalUrl = page?.finalUrl || siteUrl;
  let siteIconUrl = page ? v015ExtractDeclaredSiteIcon(page.html, finalUrl) : '';

  // Only if the website HTML does not declare an icon, use the conventional path.
  if (!siteIconUrl) {
    try {
      siteIconUrl = `${new URL(finalUrl).origin}/favicon.ico`;
    } catch {
      siteIconUrl = '';
    }
  }

  return {
    siteUrl: finalUrl,
    siteIconUrl,
    siteIconCheckedAt: new Date().toISOString()
  };
}

async function v015PatchSourceIconMetadata(sourceId, patch) {
  const { sources } = await getState();
  const nextSources = sources.map(source => source.id === sourceId ? { ...source, ...patch } : source);
  await saveSources(nextSources);

  const updated = nextSources.find(source => source.id === sourceId);
  if (!updated) return;

  document.querySelectorAll(`.source-item[data-source-id="${CSS.escape(sourceId)}"] .source-kind-icon`).forEach(holder => {
    holder.innerHTML = v014FeedIconMarkup(updated, []);
    v014BindFaviconFallbacks(holder);
  });

  document.querySelectorAll(`.source-row[data-id="${CSS.escape(sourceId)}"] .source-type`).forEach(holder => {
    holder.innerHTML = v014FeedIconMarkup(updated, []);
    holder.classList.add('source-manager-icon');
    v014BindFaviconFallbacks(holder);
  });
}

function v015ShouldDiscoverSourceIcon(source) {
  if (!source || source.type !== 'rss') return false;
  if (source.siteIconUrl) return false;
  if (!source.siteIconCheckedAt) return true;

  const checked = new Date(source.siteIconCheckedAt).getTime();
  return !Number.isFinite(checked) || Date.now() - checked > V015_SOURCE_ICON_RETRY_MS;
}

async function v015DiscoverMissingSourceIcons(sources, allArticles = []) {
  if (v015SourceIconDiscoveryRunning) {
    v015SourceIconDiscoveryPending = true;
    return;
  }

  const targets = sources.filter(v015ShouldDiscoverSourceIcon);
  if (!targets.length) return;

  v015SourceIconDiscoveryRunning = true;
  try {
    // Sequential on purpose: don't hit many websites at once when hundreds of feeds exist.
    for (const source of targets) {
      const patch = await v015DiscoverDirectSiteIcon(source, allArticles);
      if (patch) await v015PatchSourceIconMetadata(source.id, patch);
    }
  } finally {
    v015SourceIconDiscoveryRunning = false;
    if (v015SourceIconDiscoveryPending) {
      v015SourceIconDiscoveryPending = false;
      const [state, articles] = await Promise.all([getState(), dbGetAllArticles()]);
      v015DiscoverMissingSourceIcons(state.sources, articles);
    }
  }
}

// v0.1.14 already wraps renderSourceNavigation. Add the final cleanup/discovery layer.
const v015BaseRenderSourceNavigation = renderSourceNavigation;
renderSourceNavigation = function(sources, categories, allArticles, collapsedCategories = {}) {
  v015BaseRenderSourceNavigation(sources, categories, allArticles, collapsedCategories);

  // Empty folders remain valid drop targets via .custom-category; explanatory text is unnecessary.
  elements.sourceNav.querySelectorAll('.source-empty').forEach(node => node.remove());
  v015DiscoverMissingSourceIcons(sources, allArticles);
};
