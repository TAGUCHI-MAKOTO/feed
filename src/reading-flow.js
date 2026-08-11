// v0.2.1: automatic reading flow
// --------------------------------
// When the current feed becomes fully read, move to the next unread feed
// in the same folder. When the folder is fully read, move to the next
// folder that still contains unread articles.

let v021AutoAdvanceTimer = null;
let v021AutoAdvanceRunning = false;

function v021UnreadCountForSource(sourceId, allArticles) {
  return allArticles.reduce(
    (count, article) => count + (article.sourceId === sourceId && !article.read ? 1 : 0),
    0
  );
}

function v021CategoryHasUnread(categoryId, sources, allArticles) {
  const sourceIds = new Set(
    sources.filter(source => categoryKey(source) === categoryId).map(source => source.id)
  );
  return allArticles.some(article => !article.read && sourceIds.has(article.sourceId));
}

function v021OrderedCategoryKeys(categories = []) {
  return ['', ...orderedCategories(categories).map(category => category.id)];
}

function v021NextUnreadCategory(currentCategoryId, categories, sources, allArticles) {
  const keys = v021OrderedCategoryKeys(categories);
  if (!keys.length) return null;
  const currentIndex = Math.max(0, keys.indexOf(currentCategoryId));
  const searchOrder = [...keys.slice(currentIndex + 1), ...keys.slice(0, currentIndex)];
  for (const key of searchOrder) {
    if (v021CategoryHasUnread(key, sources, allArticles)) return key;
  }
  return null;
}

function v021NextUnreadSourceInCategory(currentSource, sources, allArticles) {
  const categoryId = categoryKey(currentSource);
  const group = orderedSources(sources.filter(source => categoryKey(source) === categoryId));
  const index = group.findIndex(source => source.id === currentSource.id);
  const candidates = index >= 0
    ? [...group.slice(index + 1), ...group.slice(0, index)]
    : group;
  return candidates.find(source => v021UnreadCountForSource(source.id, allArticles) > 0) || null;
}

async function v021MaybeAutoAdvance() {
  if (v021AutoAdvanceRunning) return;
  if (!currentSourceId && currentCategoryId === null) return;

  v021AutoAdvanceRunning = true;
  try {
    const [allArticles, state] = await Promise.all([dbGetAllArticles(), getState()]);
    const { sources, categories } = state;

    if (currentSourceId) {
      const currentSource = sources.find(source => source.id === currentSourceId);
      if (!currentSource) return;
      if (v021UnreadCountForSource(currentSource.id, allArticles) > 0) return;

      const nextSource = v021NextUnreadSourceInCategory(currentSource, sources, allArticles);
      if (nextSource) {
        v031HardNavigate('source', nextSource.id);
        return;
      }

      const currentCategoryId = categoryKey(currentSource);
      const nextCategory = v021NextUnreadCategory(currentCategoryId, categories, sources, allArticles);
      if (nextCategory !== null) {
        v031HardNavigate('category', nextCategory);
        return;
      }

      showToast('🎉 すべての未読フィードを確認しました！');
      return;
    }

    if (currentCategoryId !== null) {
      if (v021CategoryHasUnread(currentCategoryId, sources, allArticles)) return;
      const nextCategory = v021NextUnreadCategory(currentCategoryId, categories, sources, allArticles);
      if (nextCategory !== null) {
        v031HardNavigate('category', nextCategory);
        return;
      }
      showToast('🎉 すべての未読フィードを確認しました！');
    }
  } finally {
    v021AutoAdvanceRunning = false;
  }
}

function v021ScheduleAutoAdvance(delay = 220) {
  clearTimeout(v021AutoAdvanceTimer);
  v021AutoAdvanceTimer = setTimeout(() => {
    v021AutoAdvanceTimer = null;
    v021MaybeAutoAdvance();
  }, delay);
}

document.addEventListener('click', event => {
  if (event.target.closest('.read-btn, .article-link, .duplicate-link')) {
    v021ScheduleAutoAdvance(320);
  }
}, true);

document.addEventListener('click', async event => {
  const button = event.target.closest('#markAllReadBtn');
  if (!button) return;

  event.preventDefault();
  event.stopImmediatePropagation();

  const allArticles = await dbGetAllArticles();
  const filtered = getFilteredArticles(allArticles);
  const unreadIds = filtered.filter(article => !article.read).map(article => article.id);

  if (!unreadIds.length) {
    v021ScheduleAutoAdvance(80);
    return;
  }

  await dbPatchArticles(
    unreadIds.map(id => ({ id, patch: { read: true, duplicateAutoRead: false } }))
  );

  await render();
  v021ScheduleAutoAdvance(120);
}, true);
