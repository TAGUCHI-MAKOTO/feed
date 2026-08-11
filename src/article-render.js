function updateEmptyState(allArticles, filtered) {
  const title = elements.emptyState.querySelector('h3');
  const text = elements.emptyState.querySelector('p');
  const addButton = elements.emptyState.querySelector('#emptyAddBtn');
  const unreadOnly = currentFilter === 'unread' || elements.sortSelect.value === 'unreadOnly';
  const readOnly = elements.sortSelect.value === 'readOnly';

  if (!allArticles.length) {
    title.textContent = 'まだ記事がありません';
    text.textContent = 'RSS、Google Newsのキーワード、Xアカウントを登録できます。';
    addButton.hidden = false;
    return;
  }

  title.textContent = unreadOnly && !currentSourceId ? '未読記事はありません 🎉'
    : readOnly && !currentSourceId ? '既読記事はありません'
    : '該当する記事はありません';
  text.textContent = unreadOnly && !currentSourceId
    ? 'すべて確認済みです。「すべて」または「新しい順」に切り替えると既読記事も表示できます。'
    : readOnly && !currentSourceId
      ? 'まだ既読にした記事がありません。'
      : '検索条件・フィード・表示方法を変えてみてください。';
  addButton.hidden = true;
}

async function render() {
  const [allArticles, state] = await Promise.all([dbGetAllArticles(), getState()]);
  const { sources, categories, settings, collapsedCategories } = state;
  currentRenderSources = sources;

  if (currentSourceId && !sources.some(source => source.id === currentSourceId)) {
    currentSourceId = '';
    currentFilter = 'all';
  }
  if (currentCategoryId !== null && currentCategoryId !== '' && !categories.some(category => category.id === currentCategoryId)) {
    currentCategoryId = null;
    currentFilter = 'all';
  }

  const sortMode = normalizeSortMode(settings.sortMode);
  if (elements.sortSelect.value !== sortMode) elements.sortSelect.value = sortMode;

  renderCounts(allArticles, sources, categories, collapsedCategories);
  const filtered = getFilteredArticles(allArticles);
  const stories = buildStoryCards(filtered, allArticles);
  elements.articleCount.textContent = stories.length === filtered.length
    ? `${filtered.length.toLocaleString()}件`
    : `${stories.length.toLocaleString()}話題 / ${filtered.length.toLocaleString()}記事`;

  const viewMode = settings.viewMode === 'compact' ? 'compact' : 'card';
  elements.feedList.classList.toggle('compact', viewMode === 'compact');
  elements.viewCardBtn.classList.toggle('active', viewMode === 'card');
  elements.viewCompactBtn.classList.toggle('active', viewMode === 'compact');
  elements.viewCardBtn.setAttribute('aria-pressed', String(viewMode === 'card'));
  elements.viewCompactBtn.setAttribute('aria-pressed', String(viewMode === 'compact'));
  elements.viewTitle.textContent = currentViewTitle(sources, categories);

  if (!filtered.length) {
    if (imageObserver) imageObserver.disconnect();
    elements.feedList.hidden = true;
    elements.loadMoreWrap.hidden = true;
    elements.emptyState.hidden = false;
    updateEmptyState(allArticles, filtered);
    return;
  }

  elements.emptyState.hidden = true;
  elements.feedList.hidden = false;
  const visible = stories.slice(0, renderedLimit);
  renderedArticleMap = new Map(visible.map(article => [article.id, article]));

  elements.feedList.innerHTML = visible.map(article => {
    const articleUrl = article.url ? escapeHtml(article.url) : '';
    const imageUrl = article.imageUrl ? escapeHtml(article.imageUrl) : '';
    const duplicateMembers = (article._duplicateMembers || []).filter(member => member.id !== article.id);
    const duplicateHtml = duplicateMembers.length ? `
      <div class="duplicate-block">
        <button class="duplicate-toggle" type="button" aria-expanded="false">
          <span class="duplicate-toggle-main">
            <span class="duplicate-icon">🔗</span>
            <span class="duplicate-summary">
              <strong>同じ話題が ${duplicateMembers.length + 1}件あります</strong>
              <small>未読記事1件だけを残し、同じ話題の重複記事は自動で既読にしています</small>
            </span>
          </span>
          <span class="duplicate-toggle-side">
            <span class="duplicate-count">${duplicateMembers.length + 1}</span>
            <span class="duplicate-chevron">▾</span>
          </span>
        </button>
        <div class="duplicate-list" hidden>
          <div class="duplicate-list-head">
            <strong>同じ話題の元記事</strong>
            <span>クリックすると各記事を開けます</span>
          </div>
          ${[article, ...duplicateMembers]
            .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
            .map(member => {
              const memberUrl = member.url ? escapeHtml(member.url) : '';
              const isRepresentative = member.id === article.id;
              return `<div class="duplicate-row ${isRepresentative ? 'representative' : ''}">
                <span class="duplicate-status ${isRepresentative ? 'representative' : 'duplicate'}">${isRepresentative ? '未読' : '既読'}</span>
                <span class="duplicate-source">${typeIcon(member.sourceType)} ${escapeHtml(member.sourceName)}</span>
                <span class="duplicate-title">${memberUrl ? `<a class="duplicate-link" data-article-id="${escapeHtml(member.id)}" href="${memberUrl}" target="_blank" rel="noreferrer">${escapeHtml(member.title)} <span aria-hidden="true">↗</span></a>` : escapeHtml(member.title)}</span>
                <span class="duplicate-time">${formatRelativeDate(member.publishedAt)}</span>
              </div>`;
            }).join('')}
        </div>
      </div>` : '';
    return `
      <article class="article-card ${article.read ? 'read' : ''} ${duplicateMembers.length ? 'has-duplicates' : ''}" data-id="${article.id}">
        <div class="unread-dot"></div>
        <div class="article-content ${imageUrl ? 'has-image' : ''}">
          ${imageUrl ? `
            <a class="article-thumb article-link" href="${articleUrl || imageUrl}" target="_blank" rel="noreferrer" tabindex="-1" aria-label="${escapeHtml(article.title)}">
              <img src="${imageUrl}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />
            </a>` : ''}
          <div class="article-main">
            <div class="article-meta">
              <span class="type-badge">${typeLabel(article.sourceType)}</span>
              <span>${escapeHtml(article.sourceName)}</span>
              <span>•</span>
              <span title="${new Date(article.publishedAt).toLocaleString('ja-JP')}">${formatRelativeDate(article.publishedAt)}</span>
              ${duplicateMembers.length ? `<span class="duplicate-badge">🔗 同じ話題 ${duplicateMembers.length + 1}件</span>` : ''}
            </div>
            <h3 class="article-title">
              ${articleUrl ? `<a class="article-link" href="${articleUrl}" target="_blank" rel="noreferrer">${escapeHtml(article.title)}</a>` : escapeHtml(article.title)}
            </h3>
            ${article.description ? `<p class="article-desc">${escapeHtml(article.description)}</p>` : ''}
            ${duplicateHtml}
          </div>
        </div>
        <div class="article-actions">
          <button class="icon-action favorite-btn ${article.favorite ? 'active' : ''}" title="お気に入り">⭐</button>
          <button class="icon-action read-btn" title="${article.read ? '未読に戻す' : '既読にする'}">${article.read ? '↩' : '✓'}</button>
        </div>
      </article>`;
  }).join('');

  elements.loadMoreWrap.hidden = visible.length >= stories.length;
  attachArticleEvents();
  setupLazyImageEnrichment(visible, viewMode);
}

