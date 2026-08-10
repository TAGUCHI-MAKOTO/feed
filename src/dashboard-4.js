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

async function moveCategoryBefore(categoryId, beforeCategoryId = '') {
  if (!categoryId || categoryId === beforeCategoryId) return;
  const { categories } = await getState();
  const ordered = orderedCategories(categories);
  const movingIndex = ordered.findIndex(category => category.id === categoryId);
  if (movingIndex < 0) return;
  const [moving] = ordered.splice(movingIndex, 1);
  const targetIndex = beforeCategoryId ? ordered.findIndex(category => category.id === beforeCategoryId) : ordered.length;
  ordered.splice(targetIndex < 0 ? ordered.length : targetIndex, 0, moving);
  await saveCategories(ordered.map((category, index) => ({ ...category, order: index })));
  await refreshCategoryManager();
  await render();
}

async function setViewMode(mode) {
  const { settings } = await getState();
  await saveSettings({ ...settings, viewMode: mode === 'compact' ? 'compact' : 'card' });
  await render();
}

async function setSortMode(mode) {
  const normalized = normalizeSortMode(mode);
  if (currentFilter === 'unread' && normalized !== 'unreadOnly') currentFilter = 'all';
  const { settings } = await getState();
  await saveSettings({ ...settings, sortMode: normalized });
  renderedLimit = PAGE_SIZE;
  await render();
}

function updateSourceFormHelp() {
  const type = elements.sourceType.value;
  if (type === 'rss') {
    elements.sourceValueLabel.textContent = 'RSS URL';
    elements.sourceValue.placeholder = 'https://example.com/feed.xml';
    elements.sourceHint.textContent = 'RSS / Atom URLを入力してください。';
  } else if (type === 'google') {
    elements.sourceValueLabel.textContent = '検索キーワード';
    elements.sourceValue.placeholder = '例：生成AI';
    elements.sourceHint.textContent = 'Google Newsの検索RSSを自動生成します。';
  } else {
    elements.sourceValueLabel.textContent = 'Xアカウント';
    elements.sourceValue.placeholder = '例：OpenAI または @OpenAI';
    elements.sourceHint.textContent = '先頭の @ は自動で除外し、https://nitter.net/アカウント名/rss を生成します。';
  }
}

async function openSourcesDialog() {
  await renderSources();
  elements.sourcesDialog.showModal();
}

async function openSettingsDialog(focusCategories = false) {
  const { settings, categories } = await getState();
  elements.autoRefreshMinutes.value = String(settings.autoRefreshMinutes ?? 30);
  elements.themeMode.value = normalizeThemeMode(settings.themeMode);
  renderCategoryManager(categories);
  elements.settingsDialog.showModal();
  if (focusCategories) setTimeout(() => elements.categoryNameInput.focus(), 30);
}

function showToast(message, isError = false) {
  elements.toast.textContent = message;
  elements.toast.classList.toggle('error', isError);
  elements.toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { elements.toast.hidden = true; }, 4500);
}

async function setupAutoRefresh() {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  const { settings } = await getState();
  const minutes = Number(settings.autoRefreshMinutes || 0);
  if (minutes > 0) autoRefreshTimer = setInterval(refreshAll, minutes * 60000);
}

async function setupCacheCleanup() {
  if (cacheCleanupTimer) clearInterval(cacheCleanupTimer);
  cacheCleanupTimer = setInterval(async () => {
    const result = await cleanupExpiredArticles();
    if (result.deleted) {
      await deduplicateRecentArticles(true);
      await render();
    }
  }, 60 * 60 * 1000);
}

async function normalizeStoredStructure() {
  const state = await getState();
  let { sources, categories } = state;

  // v0.1.4以前からの初回移行：今までの WEB / キーワード / X の見た目を保ったまま、
  // 3つを「編集できる通常カテゴリ」へ変換する。
  if (!state.categoryLayoutInitialized) {
    const defaults = [
      { id: 'category-web', name: 'WEB', order: 0 },
      { id: 'category-keywords', name: 'キーワード', order: 1 },
      { id: 'category-x', name: 'X', order: 2 }
    ];
    const typeToCategory = { rss: 'category-web', google: 'category-keywords', x: 'category-x' };
    const counters = new Map();
    sources = sources.map(source => {
      const categoryId = typeToCategory[source.type] || '';
      const order = counters.get(categoryId) || 0;
      counters.set(categoryId, order + 1);
      return { ...source, categoryId, order };
    });
    categories = defaults;
    await chrome.storage.local.set({
      sources,
      categories,
      categoryLayoutInitialized: true
    });
    return;
  }

  let sourceChanged = false;
  let categoryChanged = false;
  const validCategoryIds = new Set(categories.map(category => category.id));
  const nextCategories = categories.map((category, index) => {
    if (Number.isFinite(Number(category.order))) return category;
    categoryChanged = true;
    return { ...category, order: index };
  });

  const maxOrderByCategory = new Map();
  for (const source of sources) {
    const key = source.categoryId && validCategoryIds.has(source.categoryId) ? source.categoryId : '';
    if (Number.isFinite(Number(source.order))) {
      maxOrderByCategory.set(key, Math.max(maxOrderByCategory.get(key) ?? -1, Number(source.order)));
    }
  }

  const nextSources = sources.map(source => {
    let categoryId = source.categoryId || '';
    if (categoryId && !validCategoryIds.has(categoryId)) categoryId = '';
    let order = Number(source.order);
    const patch = {};
    if (source.categoryId !== categoryId) patch.categoryId = categoryId;
    if (!Number.isFinite(order)) {
      order = (maxOrderByCategory.get(categoryId) ?? -1) + 1;
      maxOrderByCategory.set(categoryId, order);
      patch.order = order;
    }
    if (Object.keys(patch).length) {
      sourceChanged = true;
      return { ...source, ...patch };
    }
    return source;
  });

  if (categoryChanged) await saveCategories(nextCategories);
  if (sourceChanged) await saveSources(nextSources);
}

async function bootstrapDemoIfEmpty() {
  const { sources, demoSeeded } = await getState();
  if (demoSeeded) return;
  if (!sources.length) {
    await saveSources([{ id: uid(), type: 'google', name: '生成AI', value: '生成AI', categoryId: '', order: 0 }]);
  }
  await chrome.storage.local.set({ demoSeeded: true });
}

elements.navList.addEventListener('click', async (event) => {
  const collapseButton = event.target.closest('[data-collapse-category]');
  if (collapseButton) {
    event.preventDefault();
    event.stopPropagation();
    await toggleCategoryCollapsed(collapseButton.dataset.collapseCategory ?? '');
    return;
  }

  const button = event.target.closest('[data-filter]');
  if (!button) return;

  const filter = button.dataset.filter || 'all';
  currentSourceId = filter === 'source' ? (button.dataset.sourceId || '') : '';
  currentCategoryId = filter === 'category' ? (button.dataset.categoryId ?? '') : null;

  if (filter === 'unread') {
    currentFilter = 'unread';
    renderedLimit = PAGE_SIZE;
    await setSortMode('unreadOnly');
    return;
  }

  currentFilter = ['all', 'favorite', 'rss', 'google', 'x'].includes(filter) ? filter : 'all';
  if (filter === 'all' && ['unreadOnly', 'readOnly'].includes(elements.sortSelect.value)) {
    await setSortMode('all');
    return;
  }

  renderedLimit = PAGE_SIZE;
  await render();
});

let dragPayload = null;

elements.sourceNav.addEventListener('dragstart', event => {
  const source = event.target.closest('.draggable-source');
  const category = event.target.closest('.category-header[draggable="true"]');
  if (source) {
    dragPayload = { kind: 'source', id: source.dataset.sourceId };
    source.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', `source:${source.dataset.sourceId}`);
    return;
  }
  if (category) {
    dragPayload = { kind: 'category', id: category.dataset.categoryId };
    category.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', `category:${category.dataset.categoryId}`);
  }
});

elements.sourceNav.addEventListener('dragover', event => {
  if (!dragPayload) return;
  const sourceTarget = event.target.closest('.draggable-source');
  const categoryTarget = event.target.closest('.custom-category');
  if (dragPayload.kind === 'source' && (sourceTarget || categoryTarget)) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    sourceTarget?.classList.add('drag-over');
    categoryTarget?.classList.add('drag-over');
  } else if (dragPayload.kind === 'category') {
    const header = event.target.closest('.category-header[draggable="true"]');
    if (header && header.dataset.categoryId !== dragPayload.id) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      header.closest('.custom-category')?.classList.add('drag-over');
    }
  }
});

elements.sourceNav.addEventListener('dragleave', event => {
  const sourceTarget = event.target.closest('.draggable-source');
  const categoryTarget = event.target.closest('.custom-category');
  sourceTarget?.classList.remove('drag-over');
  if (categoryTarget && !categoryTarget.contains(event.relatedTarget)) categoryTarget.classList.remove('drag-over');
});

elements.sourceNav.addEventListener('drop', async event => {
  if (!dragPayload) return;
  event.preventDefault();
  const sourceTarget = event.target.closest('.draggable-source');
  const categoryTarget = event.target.closest('.custom-category');

  if (dragPayload.kind === 'source' && categoryTarget) {
    const categoryId = categoryTarget.dataset.categoryId || '';
    const beforeSourceId = sourceTarget?.dataset.sourceId || '';
    if (beforeSourceId !== dragPayload.id) await moveSourceToCategory(dragPayload.id, categoryId, beforeSourceId);
  } else if (dragPayload.kind === 'category') {
    const header = event.target.closest('.category-header[draggable="true"]');
    if (header) await moveCategoryBefore(dragPayload.id, header.dataset.categoryId);
  }
});

elements.sourceNav.addEventListener('dragend', () => {
  dragPayload = null;
  $$('.dragging, .drag-over').forEach(node => node.classList.remove('dragging', 'drag-over'));
});

elements.searchInput.addEventListener('input', () => { renderedLimit = PAGE_SIZE; render(); });
elements.sortSelect.addEventListener('change', () => setSortMode(elements.sortSelect.value));
elements.refreshBtn.addEventListener('click', refreshAll);
elements.loadMoreBtn.addEventListener('click', () => { renderedLimit += PAGE_SIZE; render(); });
elements.viewCardBtn.addEventListener('click', () => setViewMode('card'));
elements.viewCompactBtn.addEventListener('click', () => setViewMode('compact'));

$('#openSourcesBtn').addEventListener('click', openSourcesDialog);
$('#openCategoriesBtn').addEventListener('click', () => openSettingsDialog(true));
$('#emptyAddBtn').addEventListener('click', openSourcesDialog);
$('#openSettingsBtn').addEventListener('click', () => openSettingsDialog(false));

$('#closeSourcesBtn').addEventListener('click', () => elements.sourcesDialog.close());
$('#cancelSourcesBtn').addEventListener('click', () => elements.sourcesDialog.close());
$('#closeSettingsBtn').addEventListener('click', () => elements.settingsDialog.close());
$('#cancelSettingsBtn').addEventListener('click', () => elements.settingsDialog.close());

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (elements.sourcesDialog.open) {
    event.preventDefault();
    elements.sourcesDialog.close();
    return;
  }
  if (elements.settingsDialog.open) {
    event.preventDefault();
    elements.settingsDialog.close();
  }
});

elements.sourceType.addEventListener('change', updateSourceFormHelp);
elements.sourceForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const source = {
    id: uid(),
    type: elements.sourceType.value,
    name: elements.sourceName.value.trim(),
    value: elements.sourceValue.value.trim(),
    categoryId: elements.sourceCategory.value || ''
  };

  if (source.type === 'x') source.value = normalizeXHandle(source.value);
  if (!source.name || !source.value) return;

  const { sources } = await getState();
  const sameCategory = sources.filter(item => categoryKey(item) === source.categoryId);
  source.order = sameCategory.length;
  await saveSources([...sources, source]);
  elements.sourceName.value = '';
  elements.sourceValue.value = '';
  await renderSources();
  await render();
  showToast('フィードを登録しました。');
});

elements.addCategoryBtn.addEventListener('click', async () => {
  if (await addCategory(elements.categoryNameInput.value)) elements.categoryNameInput.value = '';
});

elements.categoryNameInput.addEventListener('keydown', async (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  if (await addCategory(elements.categoryNameInput.value)) elements.categoryNameInput.value = '';
});

elements.categoryManagerList.addEventListener('click', async (event) => {
  const row = event.target.closest('.category-manager-row');
  if (!row) return;
  if (event.target.closest('.category-rename')) await renameCategory(row.dataset.categoryId);
  if (event.target.closest('.category-delete')) await deleteCategory(row.dataset.categoryId);
});

elements.settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const { settings } = await getState();
  const themeMode = normalizeThemeMode(elements.themeMode.value);
  await saveSettings({
    ...settings,
    autoRefreshMinutes: Number(elements.autoRefreshMinutes.value),
    themeMode
  });
  applyTheme(themeMode);
  elements.settingsDialog.close();
  await setupAutoRefresh();
  showToast('設定を保存しました。');
});

elements.clearArticlesBtn.addEventListener('click', async () => {
  if (!confirm('保存済みの記事をすべて削除しますか？')) return;
  await dbClearArticles();
  await render();
  showToast('記事キャッシュを削除しました。');
});

elements.markAllReadBtn.addEventListener('click', async () => {
  const all = await dbGetAllArticles();
  const filtered = getFilteredArticles(all);
  await dbPatchMany(filtered.map(article => article.id), { read: true, duplicateAutoRead: false });
  await render();
  showToast(`${filtered.length}件を既読にしました。`);
});

(async function init() {
  updateSourceFormHelp();
  await bootstrapDemoIfEmpty();
  await normalizeStoredStructure();
  const initialState = await getState();
  const { settings, sources, categories } = initialState;
  applyTheme(settings.themeMode);

  const normalizedSort = normalizeSortMode(settings.sortMode);
  if (normalizedSort !== settings.sortMode) {
    await saveSettings({ ...settings, sortMode: normalizedSort });
  }
  elements.sortSelect.value = normalizedSort;

  renderCategoryOptions(categories);
  await setupAutoRefresh();
  await setupCacheCleanup();
  const cleanup = await cleanupExpiredArticles();
  const dedupe = await deduplicateRecentArticles(false);
  await render();

  const dedupeText = dedupe.groups ? ` ・ ${dedupe.groups}話題を重複整理` : '';
  const cleanupText = cleanup.deleted ? ` ・ 72時間超 ${cleanup.deleted}件削除` : '';
  elements.statusText.textContent = `登録フィード ${sources.length}件 ・ カテゴリ ${categories.length}件${dedupeText}${cleanupText} ・ 「更新」で最新記事を取得`;
})();
