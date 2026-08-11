// v0.1.12: fixed primary navigation + favorite folders + folder reorder + backup
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
        <div class="category-header ${categoryActive ? 'active' : ''}" ${categoryDrag} title="${group.custom ? 'ドラッグしてフォルダを並び替え' : ''}">
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
          ${group.custom ? '<span class="category-drag-handle" title="ドラッグしてフォルダを並び替え">⋮⋮</span>' : '<span class="category-drag-spacer"></span>'}
        </div>
        <div class="category-children" data-category-id="${escapeHtml(group.id)}" ${isCollapsed ? 'hidden' : ''}>${sourceRows}</div>
      </section>`;
  }).join('');

  elements.sourceNav.innerHTML = favoriteFolderHtml + normalFoldersHtml
    + '<div class="drag-hint">▾でフォルダを開閉。フィードはドラッグでフォルダ移動、フォルダ自体もドラッグで好きな順に並び替えできます。</div>';

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

// ------------------------------
// v0.1.12: フォルダ並び替え
// ------------------------------
let v012CategoryDragId = '';

function v012ClearCategoryDragMarkers() {
  $$('.drop-before, .drop-after, .category-moving').forEach(node => {
    node.classList.remove('drop-before', 'drop-after', 'category-moving');
  });
}

function v012DropPosition(header, clientY) {
  const rect = header.getBoundingClientRect();
  return clientY >= rect.top + rect.height / 2 ? 'after' : 'before';
}

async function v012MoveCategoryRelative(categoryId, targetCategoryId = '', position = 'before') {
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

elements.sourceNav.addEventListener('dragstart', event => {
  const category = event.target.closest('.category-header[draggable="true"]');
  if (!category) return;
  const categoryId = category.dataset.categoryId || '';
  if (!categoryId) return;
  event.stopImmediatePropagation();
  v012CategoryDragId = categoryId;
  category.closest('.custom-category')?.classList.add('category-moving');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', `category:${categoryId}`);
}, true);

elements.sourceNav.addEventListener('dragover', event => {
  if (!v012CategoryDragId) return;
  const header = event.target.closest('.category-header[draggable="true"]');
  if (!header || header.dataset.categoryId === v012CategoryDragId) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  event.dataTransfer.dropEffect = 'move';
  $$('.custom-category.drop-before, .custom-category.drop-after').forEach(node => node.classList.remove('drop-before', 'drop-after'));
  const row = header.closest('.custom-category');
  row?.classList.add(v012DropPosition(header, event.clientY) === 'after' ? 'drop-after' : 'drop-before');
}, true);

elements.sourceNav.addEventListener('drop', async event => {
  if (!v012CategoryDragId) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const header = event.target.closest('.category-header[draggable="true"]');
  if (header && header.dataset.categoryId !== v012CategoryDragId) {
    await v012MoveCategoryRelative(v012CategoryDragId, header.dataset.categoryId, v012DropPosition(header, event.clientY));
  } else if (!header) {
    await v012MoveCategoryRelative(v012CategoryDragId, '', 'after');
  }
  v012CategoryDragId = '';
  v012ClearCategoryDragMarkers();
}, true);

elements.sourceNav.addEventListener('dragend', event => {
  if (!v012CategoryDragId) return;
  event.stopImmediatePropagation();
  v012CategoryDragId = '';
  v012ClearCategoryDragMarkers();
}, true);

// ------------------------------
// v0.1.12: インポート / エクスポート
// ------------------------------
const V012_BACKUP_FORMAT = 'myfeed-backup';
const V012_BACKUP_VERSION = 1;

function v012SafeFileTimestamp(date = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

async function v012ExportData() {
  const [state, allArticles] = await Promise.all([getState(), dbGetAllArticles()]);
  const favorites = allArticles.filter(article => article.favorite);
  const payload = {
    format: V012_BACKUP_FORMAT,
    formatVersion: V012_BACKUP_VERSION,
    appVersion: '0.1.12',
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
  link.download = `myfeed-backup-${v012SafeFileTimestamp()}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(`バックアップを書き出しました（フィード ${payload.sources.length}件 / お気に入り ${favorites.length}件）。`);
}

function v012ValidateBackup(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('JSON形式が正しくありません。');
  if (payload.format !== V012_BACKUP_FORMAT) throw new Error('MyFeedのバックアップファイルではありません。');
  if (Number(payload.formatVersion) > V012_BACKUP_VERSION) throw new Error('このMyFeedより新しい形式のバックアップです。');
  if (!Array.isArray(payload.sources) || !Array.isArray(payload.categories)) throw new Error('フィードまたはフォルダ情報が不足しています。');
  if (payload.favorites != null && !Array.isArray(payload.favorites)) throw new Error('お気に入り情報が正しくありません。');
  return payload;
}

async function v012ImportData(file) {
  const payload = v012ValidateBackup(JSON.parse(await file.text()));
  const favorites = (payload.favorites || [])
    .filter(article => article && article.id)
    .map(article => ({ ...article, favorite: true }));
  const message = [
    'このバックアップをインポートしますか？', '',
    `登録フィード：${payload.sources.length}件`,
    `フォルダ：${payload.categories.length}件`,
    `お気に入り：${favorites.length}件`, '',
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
  renderCategoryOptions(payload.categories);
  await setupAutoRefresh();
  await renderSources();
  await render();
  showToast(`インポートしました（フィード ${payload.sources.length}件 / お気に入り ${favorites.length}件）。`);
}

function v012InstallTransferUi() {
  const settingsForm = elements.settingsForm;
  const dangerZone = settingsForm?.querySelector('.danger-zone');
  if (!settingsForm || !dangerZone || settingsForm.querySelector('#exportDataBtn')) return;

  const section = document.createElement('section');
  section.className = 'transfer-settings';
  section.innerHTML = `
    <div class="setting-section-head">
      <div>
        <strong>インポート・エクスポート</strong>
        <small>登録フィード、フォルダ構成、設定、⭐お気に入り記事をJSONでバックアップできます。</small>
      </div>
    </div>
    <div class="transfer-actions">
      <button id="exportDataBtn" type="button" class="secondary-btn">⇩ エクスポート</button>
      <button id="importDataBtn" type="button" class="ghost-btn">⇧ インポート</button>
      <input id="importDataInput" type="file" accept="application/json,.json" hidden />
    </div>
    <small class="transfer-note">インポートすると現在のフィード構成・設定を置き換え、通常記事キャッシュをクリアします。バックアップ内のお気に入り記事は復元します。</small>`;
  dangerZone.before(section);

  const exportBtn = section.querySelector('#exportDataBtn');
  const importBtn = section.querySelector('#importDataBtn');
  const input = section.querySelector('#importDataInput');
  exportBtn.addEventListener('click', v012ExportData);
  importBtn.addEventListener('click', () => {
    input.value = '';
    input.click();
  });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      await v012ImportData(file);
      if (elements.settingsDialog.open) elements.settingsDialog.close();
    } catch (error) {
      console.error(error);
      showToast(`インポートできませんでした：${error.message}`, true);
    } finally {
      input.value = '';
    }
  });
}

function v012InstallStyles() {
  if (document.querySelector('#v012Styles')) return;
  const style = document.createElement('style');
  style.id = 'v012Styles';
  style.textContent = `
    .category-header[draggable="true"], .category-drag-handle { cursor: grab; }
    .category-header[draggable="true"]:active, .category-drag-handle:active { cursor: grabbing; }
    .custom-category.drop-before { box-shadow: inset 0 3px 0 var(--accent); }
    .custom-category.drop-after { box-shadow: inset 0 -3px 0 var(--accent); }
    .custom-category.category-moving { opacity: .48; }
    .category-drag-handle { user-select: none; touch-action: none; }
    .transfer-settings { margin-top: 18px; padding: 15px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel-2); }
    .transfer-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
    .transfer-note { display: block; margin-top: 10px; line-height: 1.55; }
  `;
  document.head.appendChild(style);
}

v012InstallStyles();
v012InstallTransferUi();
