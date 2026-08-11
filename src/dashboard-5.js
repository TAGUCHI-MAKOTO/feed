// v0.1.11: fixed primary navigation + favorite folders
let currentFavoriteCategoryId = null;

function getFilteredArticles(allArticles) {
  const term = elements.searchInput.value.trim().toLowerCase();
  const mode = elements.sortSelect.value || 'newest';

  const filtered = allArticles
    .filter(a => {
      if (currentFavoriteCategoryId !== null) {
        if (!a.favorite) return false;
        const source = currentRenderSources.find(item => item.id === a.sourceId);
        return source && categoryKey(source) === currentFavoriteCategoryId;
      }
      if (currentSourceId) return a.sourceId === currentSourceId;
      if (currentCategoryId !== null) {
        const source = currentRenderSources.find(item => item.id === a.sourceId);
        return source && categoryKey(source) === currentCategoryId;
      }
      if (currentFilter === 'favorite') return a.favorite;
      if (['rss', 'google', 'x'].includes(currentFilter)) return a.sourceType === currentFilter;
      return true;
    })
    .filter(a => currentFilter !== 'unread' || !a.read)
    .filter(a => mode !== 'unreadOnly' || !a.read)
    .filter(a => mode !== 'readOnly' || a.read)
    .filter(a => !term || `${a.title} ${a.description} ${a.sourceName}`.toLowerCase().includes(term));

  return sortArticles(filtered);
}

function renderSourceNavigation(sources, categories, allArticles, collapsedCategories = {}) {
  const categoryList = orderedCategories(categories);
  const groups = [
    ...categoryList.map(category => ({ id: category.id, name: category.name, custom: true })),
    { id: '', name: '未分類', custom: false }
  ];

  const favoriteArticles = allArticles.filter(article => article.favorite);
  const favoriteFolderHtml = currentFilter === 'favorite'
    ? (() => {
        const rows = groups.map(group => {
          const sourceIds = new Set(sources.filter(source => categoryKey(source) === group.id).map(source => source.id));
          const count = favoriteArticles.filter(article => sourceIds.has(article.sourceId)).length;
          if (!count) return '';
          const active = currentFavoriteCategoryId === group.id;
          return `
            <button class="favorite-folder-item ${active ? 'active' : ''}"
                    type="button" data-filter="favorite-category"
                    data-favorite-category-id="${escapeHtml(group.id)}"
                    title="${escapeHtml(group.name)}のお気に入り">
              <span class="favorite-folder-icon">📁</span>
              <span class="favorite-folder-name">${escapeHtml(group.name)}</span>
              <b>${count.toLocaleString()}</b>
            </button>`;
        }).join('');

        return `
          <section class="favorite-folder-panel">
            <div class="favorite-folder-head">
              <span>⭐</span>
              <strong>お気に入りフォルダ</strong>
              <span>${favoriteArticles.length.toLocaleString()}件</span>
            </div>
            <button class="favorite-folder-item ${currentFavoriteCategoryId === null ? 'active' : ''}"
                    type="button" data-filter="favorite-category" data-favorite-category-all="true">
              <span class="favorite-folder-icon">★</span>
              <span class="favorite-folder-name">すべてのお気に入り</span>
              <b>${favoriteArticles.length.toLocaleString()}</b>
            </button>
            ${rows || '<div class="favorite-folder-empty">お気に入り記事のあるカテゴリはまだありません。</div>'}
          </section>
          <div class="favorite-folder-divider"></div>`;
      })()
    : '';

  const normalFoldersHtml = groups.map(group => {
    const groupSources = orderedSources(sources.filter(source => categoryKey(source) === group.id));
    const sourceIds = new Set(groupSources.map(source => source.id));
    const groupUnread = countUnread(allArticles.filter(article => sourceIds.has(article.sourceId)));
    const categoryActive = !currentSourceId && currentFavoriteCategoryId === null && currentCategoryId === group.id;
    const categoryDrag = group.custom ? 'draggable="true" data-drag-kind="category"' : '';
    const isCollapsed = Boolean(collapsedCategories[group.id]);

    const sourceRows = groupSources.length
      ? groupSources.map(source => {
          const unread = countUnread(allArticles.filter(article => article.sourceId === source.id));
          const isActive = currentSourceId === source.id;
          return `
            <button class="nav-item source-item draggable-source ${isActive ? 'active' : ''}"
                    draggable="true" data-drag-kind="source" data-source-id="${escapeHtml(source.id)}"
                    data-category-id="${escapeHtml(group.id)}" data-filter="source" title="${escapeHtml(source.name)}">
              <span class="source-kind-icon">${typeIcon(source.type)}</span>
              <span class="source-name">${escapeHtml(source.name)}</span>
              <b class="${unread === 0 ? 'zero' : ''}">${unread.toLocaleString()}</b>
            </button>`;
        }).join('')
      : '<div class="source-empty">ここへドラッグできます</div>';

    return `
      <section class="custom-category ${isCollapsed ? 'collapsed' : ''}" data-category-id="${escapeHtml(group.id)}">
        <div class="category-header ${categoryActive ? 'active' : ''}" ${categoryDrag}>
          <button class="category-collapse-btn" type="button"
                  data-collapse-category="${escapeHtml(group.id)}"
                  aria-expanded="${String(!isCollapsed)}"
                  aria-label="${escapeHtml(group.name)}を${isCollapsed ? '開く' : '閉じる'}">
            <span class="category-chevron">${isCollapsed ? '▸' : '▾'}</span>
          </button>
          <button class="category-select-btn" type="button"
                  data-filter="category" data-category-id="${escapeHtml(group.id)}"
                  title="${escapeHtml(group.name)}の記事を表示">
            <span class="category-folder">${isCollapsed ? '📁' : '📂'}</span>
            <span class="category-name">${escapeHtml(group.name)}</span>
            <b class="${groupUnread === 0 ? 'zero' : ''}">${groupUnread.toLocaleString()}</b>
          </button>
          ${group.custom ? '<span class="category-drag-handle" title="ドラッグしてカテゴリを並び替え">⋮⋮</span>' : '<span class="category-drag-spacer"></span>'}
        </div>
        <div class="category-children" data-category-id="${escapeHtml(group.id)}" ${isCollapsed ? 'hidden' : ''}>${sourceRows}</div>
      </section>`;
  }).join('');

  elements.sourceNav.innerHTML = favoriteFolderHtml + normalFoldersHtml
    + '<div class="drag-hint">▾でフォルダを開閉。フィードはドラッグでカテゴリ移動、カテゴリは⋮⋮付近をドラッグで並び替えできます。</div>';

  const effectiveNavFilter = currentFilter === 'all' && elements.sortSelect.value === 'unreadOnly'
    ? 'unread'
    : currentFilter;
  $$('.nav-item[data-filter="all"], .nav-item[data-filter="unread"], .nav-item[data-filter="favorite"]').forEach(item => {
    const active = !currentSourceId && currentCategoryId === null && item.dataset.filter === effectiveNavFilter;
    item.classList.toggle('active', active);
  });
}

function currentViewTitle(sources, categories) {
  if (currentFavoriteCategoryId !== null) {
    const name = currentFavoriteCategoryId === ''
      ? '未分類'
      : (categories.find(category => category.id === currentFavoriteCategoryId)?.name || 'カテゴリ');
    return `お気に入り / ${name}`;
  }
  if (currentSourceId) {
    return sources.find(source => source.id === currentSourceId)?.name || 'フィード';
  }
  if (currentCategoryId !== null) {
    if (currentCategoryId === '') return '未分類';
    return categories.find(category => category.id === currentCategoryId)?.name || 'カテゴリ';
  }
  if (elements.sortSelect.value === 'unreadOnly') return '未読';
  if (elements.sortSelect.value === 'readOnly') return '既読';
  const titles = {
    all: 'すべての記事',
    unread: '未読',
    favorite: 'お気に入り',
    rss: 'WEB',
    google: 'キーワード',
    x: 'X / Nitter'
  };
  return titles[currentFilter] || '記事';
}

// dashboard-4.js の通常ナビ処理より先に、お気に入りフォルダ操作だけを処理する。
elements.navList.addEventListener('click', async event => {
  const favoriteFolderButton = event.target.closest('[data-filter="favorite-category"]');
  if (favoriteFolderButton) {
    event.preventDefault();
    event.stopPropagation();
    currentFilter = 'favorite';
    currentSourceId = '';
    currentCategoryId = null;
    currentFavoriteCategoryId = favoriteFolderButton.dataset.favoriteCategoryAll === 'true'
      ? null
      : (favoriteFolderButton.dataset.favoriteCategoryId ?? '');
    renderedLimit = PAGE_SIZE;
    await render();
    return;
  }

  // 通常ナビへ移る場合はお気に入り内フォルダ絞り込みを解除する。
  if (event.target.closest('[data-filter]')) currentFavoriteCategoryId = null;
}, true);
