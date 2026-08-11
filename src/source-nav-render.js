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
          const healthError = source.feedHealthStatus === 'error';
          const healthTitle = feedHealthErrorTitle(source);
          return `
            <button class="nav-item source-item draggable-source ${isActive ? 'active' : ''} ${healthError ? 'has-feed-error' : ''}"
                    draggable="true" data-drag-kind="source" data-source-id="${escapeHtml(source.id)}"
                    data-category-id="${escapeHtml(group.id)}" data-filter="source" title="${escapeHtml(healthError ? healthTitle : source.name)}">
              <span class="source-kind-icon">${sourceIconHtml(source, allArticles)}</span>
              <span class="source-name" title="ダブルクリックで表示名を変更">${escapeHtml(source.name)}</span>
              ${healthError ? `<span class="source-health-warning" title="${escapeHtml(healthTitle)}">!</span>` : ''}
              <b class="${unread === 0 ? 'zero' : ''}">${unread.toLocaleString()}</b>
            </button>`;
        }).join('')
      : '';

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
          ${group.custom ? '<span class="category-drag-handle" draggable="true" title="ドラッグしてカテゴリを並び替え">⋮⋮</span>' : '<span class="category-drag-spacer"></span>'}
        </div>
        <div class="category-children" data-category-id="${escapeHtml(group.id)}" ${isCollapsed ? 'hidden' : ''}>${sourceRows}</div>
      </section>`;
  }).join('');

  elements.sourceNav.innerHTML = favoriteFolderHtml + normalFoldersHtml
    + '<div class="drag-hint">▾でフォルダを開閉。フィードはドラッグでフォルダ移動、フォルダ自体もドラッグで好きな順に並び替えできます。</div>';
  attachSourceFaviconFallbacks(elements.sourceNav);
  discoverMissingSourceIcons(sources, allArticles);

  const effectiveNavFilter = currentFilter === 'all' && elements.sortSelect.value === 'unreadOnly'
    ? 'unread'
    : currentFilter;
  $$('.nav-item[data-filter="all"], .nav-item[data-filter="unread"], .nav-item[data-filter="favorite"]').forEach(item => {
    const active = !currentSourceId && currentCategoryId === null && item.dataset.filter === effectiveNavFilter;
    item.classList.toggle('active', active);
  });
}

function renderCounts(allArticles, sources, categories, collapsedCategories = {}) {
  $('#countAll').textContent = allArticles.length.toLocaleString();
  $('#countUnread').textContent = countUnread(allArticles).toLocaleString();
  $('#countFavorite').textContent = allArticles.filter(a => a.favorite).length.toLocaleString();
  renderSourceNavigation(sources, categories, allArticles, collapsedCategories);
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
