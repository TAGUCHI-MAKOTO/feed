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
  elements.sourceValueLabel.textContent = 'URL / Xアカウント / キーワード';
  elements.sourceValue.placeholder = 'https://example.com / https://x.com/OpenAI / @OpenAI / 生成AI';
  elements.sourceHint.textContent = 'URLならWEB RSS、@またはXのURLならX、それ以外はGoogle Newsキーワードとして自動判定します。';
  updateAutoSourceDetectionHint();
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

  const favoriteFolderButton = event.target.closest('[data-filter="favorite-category"]');
  if (favoriteFolderButton) {
    event.preventDefault();
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

  const button = event.target.closest('[data-filter]');
  if (!button) return;

  currentFavoriteCategoryId = null;
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

function clearDragMarkers() {
  $$('.dragging, .drag-over, .drop-before, .drop-after, .category-moving').forEach(node => {
    node.classList.remove('dragging', 'drag-over', 'drop-before', 'drop-after', 'category-moving');
  });
}

function categoryDropPosition(header, clientY) {
  const rect = header.getBoundingClientRect();
  return clientY >= rect.top + rect.height / 2 ? 'after' : 'before';
}

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
    const categoryRow = category.closest('.custom-category');
    const categoryId = categoryRow?.dataset.categoryId || '';
    if (!categoryId) return;
    dragPayload = { kind: 'category', id: categoryId };
    category.classList.add('dragging');
    categoryRow?.classList.add('category-moving');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', `category:${categoryId}`);
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
    return;
  }

  if (dragPayload.kind === 'category') {
    const header = event.target.closest('.category-header[draggable="true"]');
    const targetRow = header?.closest('.custom-category');
    const targetCategoryId = targetRow?.dataset.categoryId || '';
    if (!header || !targetCategoryId || targetCategoryId === dragPayload.id) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    $$('.custom-category.drop-before, .custom-category.drop-after').forEach(node => node.classList.remove('drop-before', 'drop-after'));
    targetRow?.classList.add(categoryDropPosition(header, event.clientY) === 'after' ? 'drop-after' : 'drop-before');
  }
});

elements.sourceNav.addEventListener('dragleave', event => {
  const sourceTarget = event.target.closest('.draggable-source');
  const categoryTarget = event.target.closest('.custom-category');
  sourceTarget?.classList.remove('drag-over');
  if (categoryTarget && !categoryTarget.contains(event.relatedTarget)) {
    categoryTarget.classList.remove('drag-over', 'drop-before', 'drop-after');
  }
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
    const targetRow = header?.closest('.custom-category');
    const targetCategoryId = targetRow?.dataset.categoryId || '';
    if (header && targetCategoryId && targetCategoryId !== dragPayload.id) {
      await moveCategoryRelative(dragPayload.id, targetCategoryId, categoryDropPosition(header, event.clientY));
    } else if (!header) {
      await moveCategoryRelative(dragPayload.id, '', 'after');
    }
  }
  clearDragMarkers();
});

elements.sourceNav.addEventListener('dragend', () => {
  dragPayload = null;
  clearDragMarkers();
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
