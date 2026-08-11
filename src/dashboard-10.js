// v0.1.22: feed health UI + no-repair registration
// ------------------------------------------------

if (!document.getElementById('v022HealthStyles')) {
  const link = document.createElement('link');
  link.id = 'v022HealthStyles';
  link.rel = 'stylesheet';
  link.href = 'style-v022.css';
  document.head.appendChild(link);
}

function v022LooksLikeExplicitFeedUrl(value = '') {
  try {
    const url = new URL(value);
    return /(?:^|[\/._-])(rss|feed|atom)(?:[\/._-]|$)|\.(?:xml|rdf|rss|atom)(?:$|[?#])/i.test(url.pathname + url.search);
  } catch {
    return false;
  }
}

function v022UnreadableRegisteredFeed(value, categoryId, error) {
  let name = 'WEBフィード';
  try { name = new URL(value).hostname.replace(/^www\./, ''); } catch { /* noop */ }
  return {
    id: uid(),
    type: 'rss',
    name,
    value,
    categoryId,
    feedFailCount: 1,
    feedHealthStatus: 'error',
    feedLastError: error?.message || String(error || 'フィードを読み込めませんでした'),
    feedLastFailureAt: new Date().toISOString(),
    registrationWarning: true
  };
}

// Keep one-input automatic type detection, but do not repair or rewrite feed URLs.
v016PrepareSource = async function(rawValue, categoryId = '') {
  const detected = v016DetectSourceInput(rawValue);
  if (!detected.type) throw new Error('URL・Xアカウント・キーワードを入力してください。');

  if (detected.type === 'google') {
    return { id: uid(), type: 'google', name: detected.value, value: detected.value, categoryId };
  }

  if (detected.type === 'x') {
    if (!detected.value) throw new Error('Xアカウントを判定できませんでした。');
    let name = detected.value;
    try {
      const xml = await fetchXml(sourceUrl({ type: 'x', value: detected.value }));
      const title = v016FeedTitle(xml);
      if (title) name = title.replace(/\s*\(@?[^)]+\)\s*$/, '').trim() || detected.value;
    } catch { /* handle fallback */ }
    return { id: uid(), type: 'x', name, value: detected.value, categoryId };
  }

  const url = detected.value;
  const explicitFeedUrl = v022LooksLikeExplicitFeedUrl(url);
  let directError = null;

  try {
    const meta = await fetchFeedMeta(url);
    if (looksLikeFeedDocument(meta.text)) {
      let name = v016FeedTitle(meta.text);
      if (!name) {
        try { name = new URL(url).hostname.replace(/^www\./, ''); } catch { name = 'WEBフィード'; }
      }
      return {
        id: uid(), type: 'rss', name, value: url, categoryId,
        feedFailCount: 0, feedHealthStatus: 'ok', feedLastError: '',
        feedLastSuccessAt: new Date().toISOString()
      };
    }

    directError = new Error('RSS / Atom / RDFとして認識できませんでした');
    if (explicitFeedUrl) return v022UnreadableRegisteredFeed(url, categoryId, directError);
  } catch (error) {
    directError = error;
    if (explicitFeedUrl) return v022UnreadableRegisteredFeed(url, categoryId, error);
  }

  // Normal website URL: retain automatic RSS/Atom discovery.
  let page = null;
  try { page = await fetchHtmlPage(url); } catch (error) { throw directError || error; }
  if (!page) throw new Error('Webサイトを取得できませんでした。');

  const siteName = v016SiteNameFromHtml(page.html, page.finalUrl || url);
  const discovered = v016DiscoverFeedUrl(page.html, page.finalUrl || url);
  if (!discovered) throw new Error('このWebサイトからRSS / Atomを見つけられませんでした。');

  try {
    const meta = await fetchFeedMeta(discovered);
    if (!looksLikeFeedDocument(meta.text)) {
      throw new Error('見つかったURLをRSS / Atom / RDFとして読み込めませんでした');
    }
    return {
      id: uid(), type: 'rss', name: v016FeedTitle(meta.text) || siteName || 'WEBフィード',
      value: discovered, categoryId,
      feedFailCount: 0, feedHealthStatus: 'ok', feedLastError: '',
      feedLastSuccessAt: new Date().toISOString()
    };
  } catch (error) {
    const source = v022UnreadableRegisteredFeed(discovered, categoryId, error);
    source.name = siteName || source.name;
    return source;
  }
};

function v022DecorateSourceNavigation(sources) {
  document.querySelectorAll('.source-item[data-source-id]').forEach(row => {
    const source = sources.find(item => item.id === row.dataset.sourceId);
    if (!source) return;

    row.querySelector('.source-health-warning')?.remove();
    row.classList.toggle('has-feed-error', source.feedHealthStatus === 'error');
    if (source.feedHealthStatus !== 'error') return;

    const title = feedHealthErrorTitle(source);
    row.title = title;
    const badge = document.createElement('span');
    badge.className = 'source-health-warning';
    badge.textContent = '!';
    badge.title = title;
    badge.setAttribute('aria-label', title);
    row.querySelector('b')?.before(badge);
  });
}

const v022BaseRenderSourceNavigation = renderSourceNavigation;
renderSourceNavigation = function(sources, categories, allArticles, collapsedCategories = {}) {
  v022BaseRenderSourceNavigation(sources, categories, allArticles, collapsedCategories);
  v022DecorateSourceNavigation(sources);
};

const v022BaseRenderSources = renderSources;
renderSources = async function(...args) {
  await v022BaseRenderSources(...args);
  const { sources } = await getState();

  document.querySelectorAll('.source-row[data-id]').forEach(row => {
    const source = sources.find(item => item.id === row.dataset.id);
    if (!source) return;

    row.classList.toggle('has-feed-error', source.feedHealthStatus === 'error');
    row.querySelector('.source-health-message')?.remove();
    if (source.feedHealthStatus !== 'error') return;

    const title = feedHealthErrorTitle(source);
    const message = document.createElement('div');
    message.className = 'source-health-message';
    message.title = title;
    message.innerHTML = '<span>!</span> 読込エラー';
    row.querySelector('div:nth-child(2)')?.appendChild(message);
  });
};

// v0.1.23: stale feed-error reconciliation
// ----------------------------------------
function v023Timestamp(value) {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function v023LatestArticleFetch(sourceId, allArticles = []) {
  let latest = 0;
  for (const article of allArticles) {
    if (article.sourceId !== sourceId) continue;
    latest = Math.max(latest, v023Timestamp(article.fetchedAt));
  }
  return latest;
}

function v023HasActiveFeedError(source, allArticles = []) {
  if (!source || source.feedHealthStatus !== 'error') return false;

  const failureAt = v023Timestamp(source.feedLastFailureAt);
  const successAt = Math.max(
    v023Timestamp(source.feedLastSuccessAt),
    v023LatestArticleFetch(source.id, allArticles)
  );

  if (successAt > 0 && (failureAt === 0 || successAt >= failureAt)) return false;
  return true;
}

async function v023ReconcileStoredFeedHealth() {
  try {
    const [{ sources }, allArticles] = await Promise.all([getState(), dbGetAllArticles()]);
    let changed = false;
    const nextSources = sources.map(source => {
      if (!source || source.feedHealthStatus !== 'error') return source;
      if (v023HasActiveFeedError(source, allArticles)) return source;

      changed = true;
      const articleSuccessAt = v023LatestArticleFetch(source.id, allArticles);
      const knownSuccessAt = Math.max(v023Timestamp(source.feedLastSuccessAt), articleSuccessAt);
      return {
        ...source,
        feedFailCount: 0,
        feedHealthStatus: 'ok',
        feedLastError: '',
        feedLastFailureAt: '',
        registrationWarning: false,
        feedLastSuccessAt: knownSuccessAt ? new Date(knownSuccessAt).toISOString() : source.feedLastSuccessAt
      };
    });
    if (changed) await saveSources(nextSources);
  } catch (error) {
    console.debug('フィード状態の整合をスキップ:', error);
  }
}

const v023BaseRenderSourceNavigation = renderSourceNavigation;
renderSourceNavigation = function(sources, categories, allArticles, collapsedCategories = {}) {
  v023BaseRenderSourceNavigation(sources, categories, allArticles, collapsedCategories);

  document.querySelectorAll('.source-item[data-source-id]').forEach(row => {
    const source = sources.find(item => item.id === row.dataset.sourceId);
    if (!source || v023HasActiveFeedError(source, allArticles)) return;

    row.classList.remove('has-feed-error');
    row.querySelector('.source-health-warning')?.remove();
    row.title = source.name || '';
  });
};

const v023BaseRenderSources = renderSources;
renderSources = async function(...args) {
  await v023BaseRenderSources(...args);
  const [{ sources }, allArticles] = await Promise.all([getState(), dbGetAllArticles()]);

  document.querySelectorAll('.source-row[data-id]').forEach(row => {
    const source = sources.find(item => item.id === row.dataset.id);
    if (!source || v023HasActiveFeedError(source, allArticles)) return;

    row.classList.remove('has-feed-error');
    row.querySelector('.source-health-message')?.remove();
  });
};

const v023BaseRefreshAll = refreshAll;
refreshAll = async function(...args) {
  await v023BaseRefreshAll(...args);
  await v023ReconcileStoredFeedHealth();
  await render();
};

v023ReconcileStoredFeedHealth().then(() => {
  render().catch(error => console.debug('フィード状態整合後の再描画をスキップ:', error));
});
