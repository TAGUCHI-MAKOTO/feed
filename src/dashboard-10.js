// v0.1.20: stronger feed discovery + repair from first failure
// --------------------------------------------------------------
const FEED_REPAIR_ENGINE_VERSION = 2;

const v020RepairMigrationPromise = (async () => {
  const state = await chrome.storage.local.get({
    feedRepairEngineVersion: 0,
    sources: []
  });
  if (Number(state.feedRepairEngineVersion || 0) >= FEED_REPAIR_ENGINE_VERSION) return;

  const nextSources = (state.sources || []).map(source => {
    if (source.type !== 'rss') return source;
    return {
      ...source,
      feedLastRepairAttemptAt: '',
      feedRepairEngineVersion: FEED_REPAIR_ENGINE_VERSION
    };
  });

  await chrome.storage.local.set({
    sources: nextSources,
    feedRepairEngineVersion: FEED_REPAIR_ENGINE_VERSION
  });
})();

// WEB/RSS feeds: try repair immediately after the first failed fetch.
shouldAttemptFeedRepair = function(source, error, failCount) {
  if (!source || source.type !== 'rss') return false;

  const lastAttempt = new Date(source.feedLastRepairAttemptAt || 0).getTime();
  if (Number.isFinite(lastAttempt) && lastAttempt > 0 && Date.now() - lastAttempt < FEED_AUTO_REPAIR_RETRY_MS) {
    return false;
  }

  return Number(failCount || 0) >= 1;
};

// Broader discovery for media sites that do not advertise their feed in <head>.
discoverFeedCandidates = function(html = '', baseUrl = '') {
  const candidates = [];
  const add = (value, score = 0) => {
    const url = resolveHttpUrl(value, baseUrl);
    if (!url) return;
    candidates.push({ url, score });
  };

  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');

    // 1) Site-declared RSS / Atom is strongest.
    for (const link of Array.from(doc.querySelectorAll('link[rel~="alternate"][href]'))) {
      const type = (link.getAttribute('type') || '').toLowerCase();
      const title = (link.getAttribute('title') || '').toLowerCase();
      const href = link.getAttribute('href') || '';
      let score = 0;
      if (/application\/rss\+xml/.test(type)) score += 200;
      else if (/application\/atom\+xml/.test(type)) score += 195;
      else if (/rdf|rss|atom|xml/.test(type)) score += 160;
      if (/rss|atom|feed/.test(`${title} ${href}`)) score += 40;
      if (score) add(href, score);
    }

    // 2) Visible links whose label or URL mentions RSS/feed/atom.
    for (const anchor of Array.from(doc.querySelectorAll('a[href]'))) {
      const label = `${anchor.textContent || ''} ${anchor.getAttribute('title') || ''} ${anchor.getAttribute('href') || ''}`.toLowerCase();
      if (!/(rss|atom|feed)/i.test(label)) continue;
      add(anchor.getAttribute('href'), 120);
    }
  } catch {
    // Conventional path search below still works.
  }

  // 3) Common CMS / Japanese media feed paths.
  try {
    const origin = new URL(baseUrl).origin;
    const paths = [
      '/list/feed/rss',
      '/list/feed/rss/',
      '/list/feed/atom',
      '/list/feed',
      '/feed',
      '/feed/',
      '/feed.xml',
      '/rss',
      '/rss/',
      '/rss.xml',
      '/rss/index.xml',
      '/rss/index.rdf',
      '/rss/all.rdf',
      '/feed/index.rdf',
      '/index.rdf',
      '/index.xml',
      '/atom.xml',
      '/feeds/posts/default?alt=rss'
    ];
    paths.forEach((path, index) => add(origin + path, 90 - index));
  } catch { /* noop */ }

  const best = new Map();
  for (const item of candidates) {
    const key = item.url.replace(/#.*$/, '');
    if (!best.has(key) || best.get(key).score < item.score) best.set(key, item);
  }

  return [...best.values()]
    .sort((a, b) => b.score - a.score)
    .map(item => item.url);
};

// Registration uses the same stronger repair engine if the pasted URL is dead.
const v020BasePrepareSource = v016PrepareSource;
v016PrepareSource = async function(rawValue, categoryId = '') {
  await v020RepairMigrationPromise;

  try {
    return await v020BasePrepareSource(rawValue, categoryId);
  } catch (originalError) {
    const detected = v016DetectSourceInput(rawValue);
    if (detected.type !== 'rss') throw originalError;

    let fallbackName = 'WEBフィード';
    try { fallbackName = new URL(detected.value).hostname.replace(/^www\./, ''); } catch { /* noop */ }

    const preview = {
      id: 'preview',
      type: 'rss',
      name: fallbackName,
      value: detected.value,
      categoryId,
      feedRepairEngineVersion: FEED_REPAIR_ENGINE_VERSION
    };

    let repaired = null;
    try {
      repaired = await tryRepairRegisteredFeed(preview);
    } catch {
      throw originalError;
    }
    if (!repaired?.newUrl) throw originalError;

    let name = fallbackName;
    try {
      const meta = await fetchFeedMeta(repaired.newUrl);
      name = v016FeedTitle(meta.text) || name;
    } catch { /* keep fallback */ }

    return {
      id: uid(),
      type: 'rss',
      name,
      value: repaired.newUrl,
      categoryId,
      siteUrl: repaired.patch?.siteUrl || '',
      siteIconUrl: '',
      siteIconCheckedAt: '',
      feedFailCount: 0,
      feedHealthStatus: 'ok',
      feedRepairEngineVersion: FEED_REPAIR_ENGINE_VERSION
    };
  }
};

// Make sure the one-time cooldown reset finishes before the first refresh.
const v020BaseRefreshAll = refreshAll;
refreshAll = async function(...args) {
  await v020RepairMigrationPromise;
  return v020BaseRefreshAll(...args);
};
