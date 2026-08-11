// v0.1.30: unread-first auto sorting + strict current-view DOM scope
const v030BaseSortArticles = sortArticles;
sortArticles = function(articles) {
  const mode = elements.sortSelect.value || 'newest';
  return [...articles].sort((a, b) => {
    if (Boolean(a.read) !== Boolean(b.read)) return a.read ? 1 : -1;

    const aTime = new Date(a.publishedAt || a.fetchedAt || 0).getTime() || 0;
    const bTime = new Date(b.publishedAt || b.fetchedAt || 0).getTime() || 0;
    if (mode === 'oldest') return aTime - bTime;
    return bTime - aTime;
  });
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
  node.setAttribute('aria-live', 'polite');
  document.querySelector('main')?.prepend(node);
  return node;
}

async function v030UpdateSemanticPageContext() {
  try {
    const { sources, categories } = await getState();
    const viewTitle = currentViewTitle(sources, categories);
    document.title = `${viewTitle} | MyFeed`;

    const main = document.querySelector('main');
    main?.setAttribute('aria-label', `${viewTitle} - MyFeed`);
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

    document.querySelectorAll('.source-item[data-source-id]').forEach(row => {
      if (row.dataset.sourceId === currentSourceId) row.setAttribute('aria-current', 'page');
      else row.removeAttribute('aria-current');
    });
    document.querySelectorAll('.category-select-btn[data-category-id]').forEach(row => {
      if (currentCategoryId !== null && row.dataset.categoryId === currentCategoryId) row.setAttribute('aria-current', 'page');
      else row.removeAttribute('aria-current');
    });
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

window.addEventListener('load', () => {
  setTimeout(v030UpdateSemanticPageContext, 350);
}, { once: true });

let v031PendingSourceNavigation = null;

function v031BuildViewUrl(kind, value = '') {
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('view', kind);

  if (kind === 'source') url.searchParams.set('source', value);
  if (kind === 'category') {
    url.searchParams.set('category', value === '' ? '__uncategorized__' : value);
  }

  url.searchParams.set('ctx', String(Date.now()));
  return url.href;
}

function v031HardNavigate(kind, value = '') {
  const nextUrl = v031BuildViewUrl(kind, value);
  if (nextUrl === location.href) {
    location.reload();
    return;
  }
  location.replace(nextUrl);
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

function v031NormalizeDocumentIdentity() {
  try {
    const params = new URLSearchParams(location.search);
    const ctx = params.get('ctx') || '';
    if (ctx) document.documentElement.dataset.myfeedContext = ctx;
    document.documentElement.dataset.myfeedView = params.get('view') || 'all';
  } catch { /* noop */ }
}

v031NormalizeDocumentIdentity();
