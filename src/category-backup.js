function renderCategoryOptions(categories, selected = '') {
  const options = ['<option value="">未分類</option>', ...orderedCategories(categories).map(category =>
    `<option value="${escapeHtml(category.id)}" ${category.id === selected ? 'selected' : ''}>${escapeHtml(category.name)}</option>`
  )];
  elements.sourceCategory.innerHTML = options.join('');
}

function normalizeSourceManagerSearch(value = '') {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .trim();
}

function ensureSourceManagerSearchUi() {
  let search = document.getElementById('sourceManagerSearch');
  if (search) return search;

  const categoryLabel = elements.sourceCategory?.closest('label');
  if (!categoryLabel) return null;

  const row = document.createElement('div');
  row.className = 'source-register-bottom-row wide';
  categoryLabel.parentElement.insertBefore(row, categoryLabel);
  row.appendChild(categoryLabel);
  categoryLabel.classList.remove('wide');

  const searchLabel = document.createElement('label');
  searchLabel.className = 'source-manager-search-label';
  searchLabel.innerHTML = `
    <span>登録済みフィードを検索</span>
    <div class="source-manager-search-box">
      <span class="source-manager-search-icon" aria-hidden="true">🔍</span>
      <input id="sourceManagerSearch" type="search" autocomplete="off"
             placeholder="名前 / URL / @アカウント / カテゴリ" />
      <button id="sourceManagerSearchClear" class="source-manager-search-clear" type="button"
              aria-label="検索をクリア" title="検索をクリア" hidden>×</button>
    </div>
    <small>削除したいフィードをすぐ絞り込めます。</small>`;
  row.appendChild(searchLabel);

  search = searchLabel.querySelector('#sourceManagerSearch');
  const clearButton = searchLabel.querySelector('#sourceManagerSearchClear');

  search.addEventListener('input', () => renderSources());
  search.addEventListener('keydown', event => {
    if (event.key === 'Enter') event.preventDefault();
  });
  clearButton.addEventListener('click', () => {
    search.value = '';
    search.focus();
    renderSources();
  });

  elements.sourcesDialog?.addEventListener('close', () => {
    search.value = '';
    clearButton.hidden = true;
  });

  return search;
}

function sourceMatchesManagerSearch(source, categoryName, query) {
  const normalizedQuery = normalizeSourceManagerSearch(query);
  if (!normalizedQuery) return true;
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  const handle = source.type === 'x' ? normalizeXHandle(source.value || '') : '';
  const haystack = normalizeSourceManagerSearch([
    source.name,
    source.value,
    source.type,
    typeLabel(source.type),
    categoryName,
    handle,
    handle ? `@${handle}` : ''
  ].filter(Boolean).join(' '));
  return tokens.every(token => haystack.includes(token));
}

async function renderSources() {
  const searchInput = ensureSourceManagerSearchUi();
  const clearButton = document.getElementById('sourceManagerSearchClear');
  const { sources, categories } = await getState();
  renderCategoryOptions(categories, elements.sourceCategory.value || '');
  const categoryMap = new Map(categories.map(category => [category.id, category.name]));
  const searchTerm = searchInput?.value || '';
  const filteredSources = orderedSources(sources).filter(source =>
    sourceMatchesManagerSearch(source, categoryMap.get(categoryKey(source)) || '未分類', searchTerm)
  );

  if (clearButton) clearButton.hidden = !normalizeSourceManagerSearch(searchTerm);
  elements.sourceCount.textContent = normalizeSourceManagerSearch(searchTerm)
    ? `${filteredSources.length} / ${sources.length}件`
    : `${sources.length}件`;

  if (!sources.length) {
    elements.sourceList.innerHTML = '<small>まだ登録されていません。</small>';
    return;
  }
  if (!filteredSources.length) {
    elements.sourceList.innerHTML = '<div class="source-manager-no-results">該当するフィードはありません。</div>';
    return;
  }

  elements.sourceList.innerHTML = filteredSources.map(source => {
    const healthError = source.feedHealthStatus === 'error';
    const healthTitle = feedHealthErrorTitle(source);
    return `<div class="source-row ${healthError ? 'has-feed-error' : ''}" data-id="${source.id}">
      <div class="source-type source-manager-icon">${sourceIconHtml(source, [])}</div>
      <div class="source-row-main"><strong>${escapeHtml(source.name)}<span class="source-category-label">${escapeHtml(categoryMap.get(categoryKey(source)) || '未分類')}</span></strong><small>${escapeHtml(source.value)}</small>${healthError ? `<div class="source-health-message" title="${escapeHtml(healthTitle)}"><span>!</span> 読込エラー</div>` : ''}</div>
      <button class="source-delete" type="button">削除</button></div>`;
  }).join('');
  attachSourceFaviconFallbacks(elements.sourceList);
  $$('.source-delete').forEach(button => button.addEventListener('click', async () => {
    const id = button.closest('.source-row').dataset.id;
    const { sources } = await getState();
    await saveSources(sources.filter(source => source.id !== id));
    if (currentSourceId === id) { currentSourceId = ''; currentFilter = 'all'; }
    await renderSources(); await render(); showToast('フィードを削除しました。');
  }));
}

function renderCategoryManager(categories) {
  const ordered = orderedCategories(categories);
  if (!ordered.length) {
    elements.categoryManagerList.innerHTML = '<div class="category-manager-empty">まだカテゴリがありません。左カラムでは「未分類」に表示されます。</div>';
    return;
  }
  elements.categoryManagerList.innerHTML = ordered.map(category => `
    <div class="category-manager-row" data-category-id="${escapeHtml(category.id)}">
      <span class="folder">📁</span>
      <strong>${escapeHtml(category.name)}</strong>
      <button type="button" class="category-rename">名前変更</button>
      <button type="button" class="category-delete">削除</button>
    </div>
  `).join('');
}

async function refreshCategoryManager() {
  const { categories } = await getState();
  renderCategoryManager(categories);
  renderCategoryOptions(categories, elements.sourceCategory.value || '');
}

async function addCategory(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return false;
  const { categories } = await getState();
  if (categories.some(category => category.name.toLowerCase() === trimmed.toLowerCase())) {
    showToast('同じ名前のカテゴリがあります。', true);
    return false;
  }
  const ordered = orderedCategories(categories);
  ordered.push({ id: uid(), name: trimmed, order: ordered.length });
  await saveCategories(ordered);
  await refreshCategoryManager();
  await render();
  showToast(`カテゴリ「${trimmed}」を追加しました。`);
  return true;
}

async function renameCategory(id) {
  const { categories } = await getState();
  const category = categories.find(item => item.id === id);
  if (!category) return;
  const next = prompt('カテゴリ名を入力してください。', category.name);
  if (next === null) return;
  const trimmed = next.trim();
  if (!trimmed) return;
  if (categories.some(item => item.id !== id && item.name.toLowerCase() === trimmed.toLowerCase())) {
    showToast('同じ名前のカテゴリがあります。', true);
    return;
  }
  await saveCategories(categories.map(item => item.id === id ? { ...item, name: trimmed } : item));
  await refreshCategoryManager();
  await render();
}

async function deleteCategory(id) {
  const { categories, sources } = await getState();
  const category = categories.find(item => item.id === id);
  if (!category) return;
  if (!confirm(`カテゴリ「${category.name}」を削除しますか？\n中のフィードは「未分類」へ移動します。`)) return;
  const nextCategories = orderedCategories(categories.filter(item => item.id !== id)).map((item, index) => ({ ...item, order: index }));
  const nextSources = sources.map(source => categoryKey(source) === id ? { ...source, categoryId: '' } : source);
  await Promise.all([saveCategories(nextCategories), saveSources(nextSources)]);
  if (currentCategoryId === id) currentCategoryId = null;
  await refreshCategoryManager();
  await renderSources();
  await render();
}

async function moveSourceToCategory(sourceId, categoryId, beforeSourceId = '') {
  const { sources } = await getState();
  const moving = sources.find(source => source.id === sourceId);
  if (!moving) return;

  const targetSources = orderedSources(sources.filter(source => source.id !== sourceId && categoryKey(source) === categoryId));
  const insertAt = beforeSourceId ? Math.max(0, targetSources.findIndex(source => source.id === beforeSourceId)) : targetSources.length;
  targetSources.splice(insertAt < 0 ? targetSources.length : insertAt, 0, { ...moving, categoryId });

  const targetMap = new Map(targetSources.map((source, index) => [source.id, { ...source, order: index }]));
  const oldCategory = categoryKey(moving);
  const oldGroup = orderedSources(sources.filter(source => source.id !== sourceId && categoryKey(source) === oldCategory));
  const oldMap = new Map(oldGroup.map((source, index) => [source.id, { ...source, order: index }]));

  const nextSources = sources.map(source => {
    if (targetMap.has(source.id)) return targetMap.get(source.id);
    if (oldCategory !== categoryId && oldMap.has(source.id)) return oldMap.get(source.id);
    return source;
  });
  if (!nextSources.some(source => source.id === sourceId)) nextSources.push(targetMap.get(sourceId));
  await saveSources(nextSources);
  await renderSources();
  await render();
}

async function moveCategoryRelative(categoryId, targetCategoryId = '', position = 'before') {
  if (!categoryId) return;
  const { categories } = await getState();
  const ordered = orderedCategories(categories);
  const movingIndex = ordered.findIndex(category => category.id === categoryId);
  if (movingIndex < 0) return;
  const [moving] = ordered.splice(movingIndex, 1);

  if (!targetCategoryId) {
    ordered.push(moving);
  } else {
    let targetIndex = ordered.findIndex(category => category.id === targetCategoryId);
    if (targetIndex < 0) ordered.push(moving);
    else {
      if (position === 'after') targetIndex += 1;
      ordered.splice(targetIndex, 0, moving);
    }
  }

  await saveCategories(ordered.map((category, index) => ({ ...category, order: index })));
  await refreshCategoryManager();
  await render();
}

function safeFileTimestamp(date = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

async function exportMyFeedData() {
  const [state, allArticles] = await Promise.all([getState(), dbGetAllArticles()]);
  const favorites = allArticles.filter(article => article.favorite);
  const payload = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_VERSION,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    sources: state.sources || [],
    categories: state.categories || [],
    collapsedCategories: state.collapsedCategories || {},
    settings: state.settings || {},
    favorites
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `myfeed-backup-${safeFileTimestamp()}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(`バックアップを書き出しました（フィード ${payload.sources.length}件 / お気に入り ${favorites.length}件）。`);
}

function validateBackupPayload(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('JSON形式が正しくありません。');
  if (payload.format !== BACKUP_FORMAT) throw new Error('MyFeedのバックアップファイルではありません。');
  if (Number(payload.formatVersion) > BACKUP_VERSION) throw new Error('このMyFeedより新しい形式のバックアップです。');
  if (!Array.isArray(payload.sources) || !Array.isArray(payload.categories)) throw new Error('フィードまたはフォルダ情報が不足しています。');
  if (payload.favorites != null && !Array.isArray(payload.favorites)) throw new Error('お気に入り情報が正しくありません。');
  return payload;
}

async function importMyFeedData(file) {
  const text = await file.text();
  const payload = validateBackupPayload(JSON.parse(text));
  const favorites = (payload.favorites || []).filter(article => article && article.id).map(article => ({ ...article, favorite: true }));
  const message = [
    'このバックアップをインポートしますか？',
    '',
    `登録フィード：${payload.sources.length}件`,
    `フォルダ：${payload.categories.length}件`,
    `お気に入り：${favorites.length}件`,
    '',
    '現在の登録フィード・フォルダ・設定は置き換わり、通常の記事キャッシュはクリアされます。'
  ].join('\n');
  if (!confirm(message)) return;

  const defaults = { autoRefreshMinutes: 30, viewMode: 'card', sortMode: 'newest', themeMode: 'system' };
  const settings = { ...defaults, ...(payload.settings || {}) };
  await dbClearArticles();
  if (favorites.length) await dbPutArticles(favorites);
  await chrome.storage.local.set({
    sources: payload.sources,
    categories: payload.categories,
    collapsedCategories: payload.collapsedCategories || {},
    settings,
    categoryLayoutInitialized: true,
    dedupeMeta: { version: 0, lastFetchedAt: '' },
    demoSeeded: true
  });

  currentFilter = 'all';
  currentSourceId = '';
  currentCategoryId = null;
  currentFavoriteCategoryId = null;
  renderedLimit = PAGE_SIZE;
  applyTheme(settings.themeMode);
  initSidebarResizer(settings);
  renderCategoryOptions(payload.categories);
  await setupAutoRefresh();
  await renderSources();
  await render();
  showToast(`インポートしました（フィード ${payload.sources.length}件 / お気に入り ${favorites.length}件）。`);
}
