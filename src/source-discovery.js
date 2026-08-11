async function renameSourceDisplayName(sourceId) {
  const { sources } = await getState();
  const source = sources.find(item => item.id === sourceId);
  if (!source) return;
  const next = prompt('フィードの表示名を変更', source.name || '');
  if (next === null) return;
  const name = next.trim();
  if (!name || name === source.name) return;
  await saveSources(sources.map(item => item.id === sourceId ? { ...item, name } : item));
  const articles = await dbGetAllArticles();
  const ids = articles.filter(article => article.sourceId === sourceId).map(article => article.id);
  await dbPatchMany(ids, { sourceName: name });
  await renderSources();
  await render();
  showToast(`表示名を「${name}」に変更しました。`);
}

elements.sourceNav.addEventListener('dblclick', async event => {
  const row = event.target.closest('.source-item[data-source-id]');
  if (!row || !event.target.closest('.source-name')) return;
  event.preventDefault();
  event.stopPropagation();
  await renameSourceDisplayName(row.dataset.sourceId);
});

elements.sourceValue.addEventListener('input', updateAutoSourceDetectionHint);

elements.sourceType.addEventListener('change', updateSourceFormHelp);
elements.sourceForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const rawValue = elements.sourceValue.value.trim();
  if (!rawValue) return;

  const saveButton = $('#saveSourceBtn');
  const originalLabel = saveButton.textContent;
  saveButton.disabled = true;
  saveButton.textContent = '確認中…';

  try {
    const source = await prepareAutoSource(rawValue, elements.sourceCategory.value || '');
    elements.sourceType.value = source.type;
    elements.sourceName.value = source.name;

    const { sources } = await getState();
    const duplicate = sources.some(item => item.type === source.type && String(item.value).trim().toLowerCase() === String(source.value).trim().toLowerCase());
    if (duplicate) throw new Error('同じフィードはすでに登録されています。');

    const sameCategory = sources.filter(item => categoryKey(item) === source.categoryId);
    source.order = sameCategory.length;
    await saveSources([...sources, source]);
    elements.sourceValue.value = '';
    elements.sourceName.value = '';
    updateAutoSourceDetectionHint();
    await renderSources();
    await render();
    if (source.feedHealthStatus === 'error') showToast(`${source.name} を登録しましたが、現在フィードを読み込めません。左カラムに「!」を表示しています。`, true);
    else showToast(`${source.name} を登録しました。`);
  } catch (error) {
    console.error(error);
    showToast(`登録できませんでした：${error.message}`, true);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = originalLabel;
  }
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

elements.exportDataBtn.addEventListener('click', exportMyFeedData);
elements.importDataBtn.addEventListener('click', () => {
  elements.importDataInput.value = '';
  elements.importDataInput.click();
});
elements.importDataInput.addEventListener('change', async () => {
  const file = elements.importDataInput.files?.[0];
  if (!file) return;
  try {
    await importMyFeedData(file);
    if (elements.settingsDialog.open) elements.settingsDialog.close();
  } catch (error) {
    console.error(error);
    showToast(`インポートできませんでした：${error.message}`, true);
  } finally {
    elements.importDataInput.value = '';
  }
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

const SIDEBAR_WIDTH_DEFAULT = 290;
const SIDEBAR_WIDTH_MIN = 230;
const SIDEBAR_WIDTH_MAX = 460;
let sidebarResizeActive = false;

function clampSidebarWidth(value) {
  const width = Number(value) || SIDEBAR_WIDTH_DEFAULT;
  return Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, width));
}

function applySidebarWidth(value) {
  const width = clampSidebarWidth(value);
  document.documentElement.style.setProperty('--sidebar-width', `${width}px`);
  return width;
}

async function persistSidebarWidth(width) {
  const { settings } = await getState();
  await saveSettings({ ...settings, sidebarWidth: clampSidebarWidth(width) });
}

function initSidebarResizer(settings = {}) {
  const sidebar = document.querySelector('.sidebar');
  const resizer = document.getElementById('sidebarResizer');
  if (!sidebar || !resizer) return;

  let currentWidth = applySidebarWidth(settings.sidebarWidth ?? SIDEBAR_WIDTH_DEFAULT);
  if (resizer.dataset.resizeBound === 'true') return;
  resizer.dataset.resizeBound = 'true';
  let pointerId = null;

  const finish = async () => {
    if (!sidebarResizeActive) return;
    sidebarResizeActive = false;
    document.body.classList.remove('sidebar-resizing');
    try { if (pointerId !== null) resizer.releasePointerCapture(pointerId); } catch { /* noop */ }
    pointerId = null;
    await persistSidebarWidth(currentWidth);
  };

  resizer.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    pointerId = event.pointerId;
    sidebarResizeActive = true;
    document.body.classList.add('sidebar-resizing');
    resizer.setPointerCapture(pointerId);
  });

  resizer.addEventListener('pointermove', event => {
    if (!sidebarResizeActive || event.pointerId !== pointerId) return;
    currentWidth = applySidebarWidth(event.clientX);
  });

  resizer.addEventListener('pointerup', finish);
  resizer.addEventListener('pointercancel', finish);
  resizer.addEventListener('dblclick', async () => {
    currentWidth = applySidebarWidth(SIDEBAR_WIDTH_DEFAULT);
    await persistSidebarWidth(currentWidth);
    showToast('左カラム幅を標準に戻しました。');
  });
}

(async function init() {
  updateSourceFormHelp();
  updateAutoSourceDetectionHint();
  await bootstrapDemoIfEmpty();
  await normalizeStoredStructure();
  const initialState = await getState();
  const { settings, sources, categories } = initialState;
  applyTheme(settings.themeMode);
  initSidebarResizer(settings);

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
