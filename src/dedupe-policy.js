// Final duplicate policy
// - Prevent templated earthquake alerts for different events from collapsing into one story.
// - Keep the newest real duplicate as the representative.
// - Preserve manual read state, while undoing automatic duplicate-read state on a newly promoted item.

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

// Guard the fast title-only duplicate pass.
if (typeof titleLooksDuplicate === 'function') {
  const v033BaseTitleLooksDuplicate = titleLooksDuplicate;
  titleLooksDuplicate = function(a, b) {
    if (v033StructuredEventConflict(a, b)) return false;
    return v033BaseTitleLooksDuplicate(a, b);
  };
}

// Guard the content-aware pass as well.
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

    // A prior false-positive group contains multiple distinct structured events.
    // Split by event key. Unstructured members are released from the group.
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
  // Snapshot read/auto-read state after RSS import but before duplicate processing.
  // This lets the final policy distinguish a user-read article from an article
  // that the duplicate engine itself just marked as read.
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
