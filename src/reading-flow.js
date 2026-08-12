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

// Wait for the actual read-state write when existing handlers use this helper.
const v021BaseSetStoryReadState = setStoryReadState;
setStoryReadState = async function(id, read) {
  const result = await v021BaseSetStoryReadState(id, read);
  if (read) v021ScheduleAutoAdvance(80);
  return result;
};

// Covers dynamically inserted image links that write directly to IndexedDB.
document.addEventListener('click', event => {
  if (event.target.closest('.read-btn, .article-link, .duplicate-link')) {
    v021ScheduleAutoAdvance(420);
  }
}, true);

// Own the bulk-read behavior so it participates in the same flow.
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

// v0.3.3: final duplicate policy
// --------------------------------
// This runs last, after the fast and content-aware duplicate passes.
// It protects structured earthquake alerts from false grouping and guarantees
// that a newly imported/latest real duplicate is not auto-read by dedupe.

function v033ArticleTime(article) {
  const published = new Date(article?.publishedAt || '').getTime();
  if (Number.isFinite(published)) return published;
  const fetched = new Date(article?.fetchedAt || '').getTime();
  return Number.isFinite(fetched) ? fetched : 0;
}

function v033StructuredEventKey(article) {
  const text = String(article?.title || '').normalize('NFKC');
  if (!/(?:地震が発生|最大震度|震源)/.test(text)) return '';

  const dateTime = text.match(/(\d{1,2})日\s*(\d{1,2})時\s*(\d{1,2})分(?:頃)?/);
  const coords = text.match(/\(\s*N\s*([+-]?\d+(?:\.\d+)?)\s*\/\s*E\s*([+-]?\d+(?:\.\d+)?)\s*\)/i);
  if (!dateTime || !coords) return '';

  const [, day, hour, minute] = dateTime;
  const [, lat, lon] = coords;
  return `quake:${Number(day)}:${Number(hour)}:${Number(minute)}:${Number(lat)}:${Number(lon)}`;
}

function v033StructuredEventConflict(a, b) {
  const aKey = v033StructuredEventKey(a);
  const bKey = v033StructuredEventKey(b);
  return Boolean(aKey && bKey && aKey !== bKey);
}

// Guard the fast title-only duplicate pass on the next refresh.
if (typeof titleLooksDuplicate === 'function') {
  const v033BaseTitleLooksDuplicate = titleLooksDuplicate;
  titleLooksDuplicate = function(a, b) {
    if (v033StructuredEventConflict(a, b)) return false;
    return v033BaseTitleLooksDuplicate(a, b);
  };
}

// Guard the content-aware duplicate pass too.
if (typeof v021StrongContentDuplicate === 'function') {
  const v033BaseStrongContentDuplicate = v021StrongContentDuplicate;
  v021StrongContentDuplicate = function(a, b, titleScore, descriptionScore) {
    if (v033StructuredEventConflict(a, b)) return false;
    return v033BaseStrongContentDuplicate(a, b, titleScore, descriptionScore);
  };
}

if (typeof v021BodyCandidate === 'function') {
  const v033BaseBodyCandidate = v021BodyCandidate;
  v021BodyCandidate = function(a, b, titleScore, descriptionScore, timeDiff) {
    if (v033StructuredEventConflict(a, b)) return false;
    return v033BaseBodyCandidate(a, b, titleScore, descriptionScore, timeDiff);
  };
}

function v033NewestArticle(members) {
  return [...members].sort((a, b) => {
    const timeDiff = v033ArticleTime(b) - v033ArticleTime(a);
    if (timeDiff) return timeDiff;
    const fetchedA = new Date(a?.fetchedAt || 0).getTime();
    const fetchedB = new Date(b?.fetchedAt || 0).getTime();
    const fetchedDiff = (Number.isFinite(fetchedB) ? fetchedB : 0) - (Number.isFinite(fetchedA) ? fetchedA : 0);
    if (fetchedDiff) return fetchedDiff;
    return String(a?.id || '').localeCompare(String(b?.id || ''));
  })[0] || null;
}

function v033ShouldRestoreUnread(beforeArticle) {
  if (!beforeArticle) return false;
  return beforeArticle.read === false || beforeArticle.duplicateAutoRead === true;
}

function v033NormalizeDuplicateGroup(members, beforeById, updates, preferredGroupId = '') {
  if (!members.length) return;
  const representative = v033NewestArticle(members);
  if (!representative) return;

  const groupId = preferredGroupId
    || members.find(article => article.duplicateGroupId)?.duplicateGroupId
    || `dup-${representative.id}`;

  for (const article of members) {
    const isRepresentative = article.id === representative.id;
    const before = beforeById.get(article.id);

    if (isRepresentative) {
      const restoreUnread = v033ShouldRestoreUnread(before);
      updates.push({
        id: article.id,
        patch: {
          duplicateGroupId: groupId,
          duplicateRepresentative: true,
          duplicateAutoRead: false,
          read: restoreUnread ? false : article.read
        }
      });
      continue;
    }

    const wasUnread = before ? before.read === false : article.read === false;
    updates.push({
      id: article.id,
      patch: {
        duplicateGroupId: groupId,
        duplicateRepresentative: false,
        duplicateAutoRead: Boolean(wasUnread || before?.duplicateAutoRead || article.duplicateAutoRead),
        read: true
      }
    });
  }
}

async function v033ApplyFinalDuplicatePolicy(beforeById) {
  const allArticles = await dbGetAllArticles();
  const groups = new Map();

  for (const article of allArticles) {
    if (!article.duplicateGroupId) continue;
    if (!groups.has(article.duplicateGroupId)) groups.set(article.duplicateGroupId, []);
    groups.get(article.duplicateGroupId).push(article);
  }

  const updates = [];
  let splitGroups = 0;
  let normalizedGroups = 0;

  for (const [groupId, members] of groups) {
    if (members.length < 2) continue;

    const structuredKeys = new Set(members.map(v033StructuredEventKey).filter(Boolean));
    if (structuredKeys.size <= 1) {
      v033NormalizeDuplicateGroup(members, beforeById, updates, groupId);
      normalizedGroups++;
      continue;
    }

    // Existing false-positive group: split different earthquake events apart.
    splitGroups++;
    const overallNewest = v033NewestArticle(members);
    const partitions = new Map();

    for (const article of members) {
      const key = v033StructuredEventKey(article);
      const partitionKey = key || `single:${article.id}`;
      if (!partitions.has(partitionKey)) partitions.set(partitionKey, []);
      partitions.get(partitionKey).push(article);
    }

    for (const [partitionKey, partition] of partitions) {
      if (!partitionKey.startsWith('single:') && partition.length > 1) {
        v033NormalizeDuplicateGroup(partition, beforeById, updates, `${groupId}:${partitionKey}`);
        normalizedGroups++;
        continue;
      }

      const article = partition[0];
      const before = beforeById.get(article.id);
      const restoreLatestUnread = article.id === overallNewest?.id && v033ShouldRestoreUnread(before);
      updates.push({
        id: article.id,
        patch: {
          duplicateGroupId: '',
          duplicateRepresentative: false,
          duplicateAutoRead: false,
          read: restoreLatestUnread ? false : article.read
        }
      });
    }
  }

  if (updates.length) await dbPatchArticles(updates);
  return { splitGroups, normalizedGroups, patched: updates.length };
}

const v033BaseDeduplicateRecentArticles = deduplicateRecentArticles;
deduplicateRecentArticles = async function(force = false) {
  // Snapshot after import, before duplicate processing. New articles are unread here.
  // A manually read article remains read; a dedupe-auto-read article can be restored.
  const beforeArticles = await dbGetAllArticles();
  const beforeById = new Map(beforeArticles.map(article => [article.id, article]));

  const result = await v033BaseDeduplicateRecentArticles(force);
  const policy = await v033ApplyFinalDuplicatePolicy(beforeById);

  return {
    ...result,
    finalPolicyApplied: true,
    policySplitGroups: policy.splitGroups,
    policyNormalizedGroups: policy.normalizedGroups,
    policyPatched: policy.patched
  };
};
