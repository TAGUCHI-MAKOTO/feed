// v0.1.31: YouTube validation + unread-first sorting + Copilot page isolation
// ------------------------------------------------------------------------

// Restore a source/category view from a real URL before dashboard-4 bootstraps.
(function v031RestoreStartupView() {
  try {
    const params = new URLSearchParams(location.search);
    const view = params.get('view') || '';
    if (view === 'source') {
      currentFilter = 'all';
      currentSourceId = params.get('source') || '';
      currentCategoryId = null;
      currentFavoriteCategoryId = null;
    } else if (view === 'category') {
      currentFilter = 'all';
      currentSourceId = '';
      const raw = params.get('category');
      currentCategoryId = raw === '__uncategorized__' ? '' : (raw || null);
      currentFavoriteCategoryId = null;
    }
  } catch (error) {
    console.debug('URLから表示状態を復元できませんでした:', error);
  }
})();

// -------------------------------------------------
// v0.1.29: strict YouTube ID + transient retry
// -------------------------------------------------
const V029_YOUTUBE_CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;

function v029IsValidYouTubeChannelId(value = '') {
  return V029_YOUTUBE_CHANNEL_ID_RE.test(String(value || '').trim());
}

function v029YouTubeFeedChannelId(value = '') {
  try {
    const url = new URL(String(value || '').trim());
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (!['youtube.com', 'm.youtube.com'].includes(host)) return '';
    if (url.pathname !== '/feeds/videos.xml') return '';
    return url.searchParams.get('channel_id') || '';
  } catch {
    return '';
  }
}

function v029IsYouTubeFeedUrl(value = '') {
  return Boolean(v029YouTubeFeedChannelId(value));
}

function v029Sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const v029BaseFetchFeedMeta = fetchFeedMeta;
fetchFeedMeta = async function(url) {
  if (!v029IsYouTubeFeedUrl(url)) return v029BaseFetchFeedMeta(url);

  const waits = [0, 650, 1500];
  let lastError = null;
  for (let attempt = 0; attempt < waits.length; attempt++) {
    if (waits[attempt]) await v029Sleep(waits[attempt]);
    try {
      return await v029BaseFetchFeedMeta(url);
    } catch (error) {
      lastError = error;
      const status = Number(error?.status || 0);
      const transient = [429, 500, 502, 503, 504].includes(status)
        || error?.name === 'AbortError'
        || status === 0;
      if (!transient || attempt === waits.length - 1) throw error;
      console.debug(`YouTubeフィード再試行 ${attempt + 1}/${waits.length - 1}:`, url, error);
    }
  }
  throw lastError || new Error('YouTubeフィードを取得できませんでした');
};

v024IsYouTubeChannelUrl = function(rawValue = '') {
  try {
    const url = new URL(String(rawValue || '').trim());
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (!['youtube.com', 'm.youtube.com'].includes(host)) return false;
    const path = decodeURIComponent(url.pathname || '');
    return /^\/@[^/]+\/?$/i.test(path)
      || /^\/channel\/UC[A-Za-z0-9_-]{22}\/?$/i.test(path)
      || /^\/(?:user|c)\/[^/]+\/?$/i.test(path);
  } catch {
    return false;
  }
};

v024DirectYouTubeChannelId = function(urlValue = '') {
  try {
    const path = new URL(urlValue).pathname;
    const match = path.match(/^\/channel\/(UC[A-Za-z0-9_-]{22})(?:\/|$)/i);
    return match?.[1] || '';
  } catch {
    return '';
  }
};

v024ExtractYouTubeChannelId = function(html = '', pageUrl = '') {
  const direct = v024DirectYouTubeChannelId(pageUrl);
  if (direct) return direct;

  const patterns = [
    /feeds\/videos\.xml\?channel_id=(UC[A-Za-z0-9_-]{22})(?:[^A-Za-z0-9_-]|$)/i,
    /["']externalId["']\s*:\s*["'](UC[A-Za-z0-9_-]{22})["']/i,
    /itemprop=["']channelId["'][^>]*content=["'](UC[A-Za-z0-9_-]{22})["']/i,
    /content=["'](UC[A-Za-z0-9_-]{22})["'][^>]*itemprop=["']channelId["']/i,
    /["']channelId["']\s*:\s*["'](UC[A-Za-z0-9_-]{22})["']/i,
    /["']browseId["']\s*:\s*["'](UC[A-Za-z0-9_-]{22})["']/i,
    /\/channel\/(UC[A-Za-z0-9_-]{22})(?:[/?"'\\]|$)/i
  ];

  for (const pattern of patterns) {
    const match = String(html || '').match(pattern);
    if (match?.[1] && v029IsValidYouTubeChannelId(match[1])) return match[1];
  }
  return '';
};

v024PrepareYouTubeSource = async function(rawValue, categoryId = '') {
  const channelUrl = String(rawValue || '').trim();
  let channelId = v024DirectYouTubeChannelId(channelUrl);
  let pageTitle = '';

  if (!channelId) {
    let page = null;
    try {
      page = await fetchHtmlPage(channelUrl);
    } catch (error) {
      throw new Error(`YouTubeチャンネルページを取得できませんでした：${error.message || error}`);
    }
    if (!page) throw new Error('YouTubeチャンネルページを取得できませんでした。');
    channelId = v024ExtractYouTubeChannelId(page.html, page.finalUrl || channelUrl);
    pageTitle = v024YouTubePageTitle(page.html);
  }

  if (!v029IsValidYouTubeChannelId(channelId)) {
    throw new Error(
      `YouTubeのチャンネルIDを正しく取得できませんでした`
      + (channelId ? `（${channelId.length}文字。24文字必要）` : '')
      + '。チャンネルURLを確認してください。'
    );
  }

  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
  let meta = null;
  try {
    meta = await fetchFeedMeta(feedUrl);
  } catch (error) {
    throw new Error(`YouTubeフィードを取得できませんでした：${error.message || error}`);
  }
  if (!looksLikeFeedDocument(meta.text)) throw new Error('YouTubeフィードをAtomとして認識できませんでした。');

  return {
    id: uid(),
    type: 'rss',
    name: v016FeedTitle(meta.text) || pageTitle || 'YouTube',
    value: feedUrl,
    categoryId,
    siteUrl: channelUrl,
    youtubeChannelId: channelId,
    youtubeChannelUrl: channelUrl,
    feedFailCount: 0,
    feedHealthStatus: 'ok',
    feedLastError: '',
    feedLastFailureAt: '',
    registrationWarning: false,
    feedLastSuccessAt: new Date().toISOString()
  };
};

const v029BasePrepareSource = v016PrepareSource;
v016PrepareSource = async function(rawValue, categoryId = '') {
  const input = String(rawValue || '').trim();
  const youtubeFeedId = v029YouTubeFeedChannelId(input);
  if (youtubeFeedId && !v029IsValidYouTubeChannelId(youtubeFeedId)) {
    throw new Error(
      `YouTubeチャンネルIDが不正です（${youtubeFeedId.length}文字）。`
      + '24文字のチャンネルID、またはYouTubeのチャンネルURLを貼り付けてください。'
    );
  }
  return v029BasePrepareSource(rawValue, categoryId);
};

async function v029RepairStoredYouTubeIds() {
  try {
    const { sources } = await getState();
    let changed = false;
    const next = [];

    for (const source of sources) {
      const currentId = v029YouTubeFeedChannelId(source.value);
      if (!currentId || v029IsValidYouTubeChannelId(currentId)) {
        next.push(source);
        continue;
      }

      if (source.youtubeChannelUrl && v024IsYouTubeChannelUrl(source.youtubeChannelUrl)) {
        try {
          const repaired = await v024PrepareYouTubeSource(source.youtubeChannelUrl, source.categoryId || '');
          next.push({
            ...source,
            ...repaired,
            id: source.id,
            name: source.name || repaired.name,
            order: source.order,
            categoryId: source.categoryId || ''
          });
          changed = true;
          continue;
        } catch (error) {
          console.debug('YouTube旧IDの再取得に失敗:', source.name, error);
        }
      }

      next.push({
        ...source,
        feedHealthStatus: 'error',
        feedLastError: `YouTubeチャンネルIDが不正です（${currentId.length}文字 / 24文字必要）。チャンネルURLから登録し直してください。`,
        feedLastFailureAt: new Date().toISOString()
      });
      changed = true;
    }

    if (changed) {
      await saveSources(next);
      await render();
      if (elements.sourcesDialog?.open) await renderSources();
    }
  } catch (error) {
    console.debug('YouTube ID整合処理をスキップ:', error);
  }
}

// -------------------------------------------------
// v0.1.30: unread-first display sorting
// -------------------------------------------------
const v030BaseGetFilteredArticles = getFilteredArticles;
getFilteredArticles = function(allArticles) {
  const sorted = v030BaseGetFilteredArticles(allArticles);
  const mode = elements.sortSelect.value || 'newest';
  if (mode === 'unreadOnly' || mode === 'readOnly') return sorted;
  return [
    ...sorted.filter(article => !article.read),
    ...sorted.filter(article => article.read)
  ];
};

function v030UnreadCountBySource(sources, allArticles) {
  const map = new Map(sources.map(source => [source.id, 0]));
  for (const article of allArticles) {
    if (!article.read && map.has(article.sourceId)) {
      map.set(article.sourceId, (map.get(article.sourceId) || 0) + 1);
    }
  }
  return map;
}

function v030DisplayOrderedSources(sources, allArticles) {
  const unreadBySource = v030UnreadCountBySource(sources, allArticles);
  return [...sources].sort((a, b) => {
    const aUnread = (unreadBySource.get(a.id) || 0) > 0;
    const bUnread = (unreadBySource.get(b.id) || 0) > 0;
    if (aUnread !== bUnread) return aUnread ? -1 : 1;
    const orderDiff = (Number(a.order) || 0) - (Number(b.order) || 0);
    return orderDiff || String(a.name || '').localeCompare(String(b.name || ''), 'ja');
  });
}

function v030DisplayOrderedCategories(categories, sources, allArticles) {
  const unreadBySource = v030UnreadCountBySource(sources, allArticles);
  const sourceIdsByCategory = new Map();
  for (const source of sources) {
    const key = categoryKey(source);
    if (!sourceIdsByCategory.has(key)) sourceIdsByCategory.set(key, []);
    sourceIdsByCategory.get(key).push(source.id);
  }
  const hasUnread = categoryId =>
    (sourceIdsByCategory.get(categoryId) || []).some(sourceId => (unreadBySource.get(sourceId) || 0) > 0);

  return [...categories].sort((a, b) => {
    const aUnread = hasUnread(a.id);
    const bUnread = hasUnread(b.id);
    if (aUnread !== bUnread) return aUnread ? -1 : 1;
    const orderDiff = (Number(a.order) || 0) - (Number(b.order) || 0);
    return orderDiff || String(a.name || '').localeCompare(String(b.name || ''), 'ja');
  });
}

const v030BaseRenderSourceNavigation = renderSourceNavigation;
renderSourceNavigation = function(sources, categories, allArticles, collapsedCategories = {}) {
  const sortedCategories = v030DisplayOrderedCategories(categories, sources, allArticles)
    .map((category, index) => ({ ...category, order: index }));

  const displaySources = [];
  const categoryIds = [...sortedCategories.map(category => category.id), ''];
  for (const categoryId of categoryIds) {
    const group = sources.filter(source => categoryKey(source) === categoryId);
    v030DisplayOrderedSources(group, allArticles).forEach((source, index) => {
      displaySources.push({ ...source, order: index });
    });
  }

  v030BaseRenderSourceNavigation(displaySources, sortedCategories, allArticles, collapsedCategories);
};

// Duplicate details must contain only articles from the CURRENT view.
const v030BaseBuildStoryCards = buildStoryCards;
buildStoryCards = function(filteredArticles, allArticles) {
  return v030BaseBuildStoryCards(filteredArticles, filteredArticles);
};

function v030EnsurePageContextNode() {
  let node = document.getElementById('myfeedPageContext');
  if (node) return node;
  node = document.createElement('div');
  node.id = 'myfeedPageContext';
  node.className = 'sr-only myfeed-page-context';
  node.setAttribute('role', 'status');
  document.querySelector('main')?.prepend(node);
  return node;
}

async function v030UpdateSemanticPageContext() {
  try {
    const { sources, categories } = await getState();
    const viewTitle = currentViewTitle(sources, categories);
    document.title = `${viewTitle} | MyFeed`;
    document.querySelector('main')?.setAttribute('aria-label', `${viewTitle} - MyFeed`);
    elements.feedList?.setAttribute('aria-label', `${viewTitle}の記事一覧`);

    const context = v030EnsurePageContextNode();
    if (currentSourceId) {
      const source = sources.find(item => item.id === currentSourceId);
      context.textContent = source
        ? `現在表示中のフィードは「${source.name}」です。記事一覧はこのフィードの表示条件に限定されています。`
        : `現在表示中は「${viewTitle}」です。`;
    } else if (currentCategoryId !== null) {
      context.textContent = `現在表示中のフォルダは「${viewTitle}」です。記事一覧はこのフォルダの表示条件に限定されています。`;
    } else {
      context.textContent = `現在表示中は「${viewTitle}」です。`;
    }
  } catch (error) {
    console.debug('ページ文脈更新をスキップ:', error);
  }
}

const v030BaseRender = render;
render = async function(...args) {
  const result = await v030BaseRender(...args);
  await v030UpdateSemanticPageContext();
  return result;
};

// -------------------------------------------------
// v0.1.31: real URL navigation for Copilot context
// -------------------------------------------------
let v031PendingSourceNavigation = null;

function v031BuildViewUrl(kind, value = '') {
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('view', kind);
  if (kind === 'source') url.searchParams.set('source', value);
  if (kind === 'category') url.searchParams.set('category', value === '' ? '__uncategorized__' : value);
  url.searchParams.set('ctx', String(Date.now()));
  return url.href;
}

function v031HardNavigate(kind, value = '') {
  const nextUrl = v031BuildViewUrl(kind, value);
  if (nextUrl === location.href) location.reload();
  else location.replace(nextUrl);
}

document.addEventListener('click', event => {
  if (event.defaultPrevented) return;
  if (event.target.closest('[data-collapse-category]')) return;

  const sourceButton = event.target.closest('[data-filter="source"][data-source-id]');
  if (sourceButton) {
    event.preventDefault();
    event.stopImmediatePropagation();
    clearTimeout(v031PendingSourceNavigation);
    const sourceId = sourceButton.dataset.sourceId || '';
    v031PendingSourceNavigation = setTimeout(() => {
      v031PendingSourceNavigation = null;
      v031HardNavigate('source', sourceId);
    }, 230);
    return;
  }

  const categoryButton = event.target.closest('[data-filter="category"][data-category-id]');
  if (categoryButton) {
    event.preventDefault();
    event.stopImmediatePropagation();
    clearTimeout(v031PendingSourceNavigation);
    v031PendingSourceNavigation = null;
    v031HardNavigate('category', categoryButton.dataset.categoryId ?? '');
  }
}, true);

document.addEventListener('dblclick', event => {
  if (!event.target.closest('.source-item[data-source-id] .source-name')) return;
  clearTimeout(v031PendingSourceNavigation);
  v031PendingSourceNavigation = null;
}, true);

try {
  const params = new URLSearchParams(location.search);
  document.documentElement.dataset.myfeedContext = params.get('ctx') || '';
  document.documentElement.dataset.myfeedView = params.get('view') || 'all';
} catch { /* noop */ }

window.addEventListener('load', () => {
  setTimeout(v029RepairStoredYouTubeIds, 500);
  setTimeout(v030UpdateSemanticPageContext, 350);
}, { once: true });
