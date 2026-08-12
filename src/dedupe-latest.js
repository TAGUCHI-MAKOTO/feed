// Prefer the newest article as the visible/unread representative of a duplicate cluster.
// When a newer duplicate arrives, promote it and keep it unread while older duplicates become read.

function duplicateArticleTime(article) {
  const published = new Date(article?.publishedAt || '').getTime();
  if (Number.isFinite(published)) return published;
  const fetched = new Date(article?.fetchedAt || '').getTime();
  return Number.isFinite(fetched) ? fetched : 0;
}

function chooseClusterRepresentative(cluster) {
  return [...cluster].sort((a, b) => {
    const timeDiff = duplicateArticleTime(b) - duplicateArticleTime(a);
    if (timeDiff) return timeDiff;

    const fetchedA = new Date(a.fetchedAt || 0).getTime();
    const fetchedB = new Date(b.fetchedAt || 0).getTime();
    const fetchedDiff = (Number.isFinite(fetchedB) ? fetchedB : 0) - (Number.isFinite(fetchedA) ? fetchedA : 0);
    if (fetchedDiff) return fetchedDiff;

    const scoreDiff = representativeScore(b) - representativeScore(a);
    if (scoreDiff) return scoreDiff;
    return String(a.id || '').localeCompare(String(b.id || ''));
  })[0];
}

async function deduplicateRecentArticles(force = false) {
  const allArticles = await dbGetAllArticles();
  if (allArticles.length < 2) return { groups: 0, autoRead: 0, skipped: true };

  const newestFetchedAt = allArticles.reduce((latest, article) => {
    const value = article.fetchedAt || '';
    return value > latest ? value : latest;
  }, '');
  const { dedupeMeta } = await getState();
  if (!force && dedupeMeta?.version === DEDUPE_VERSION && dedupeMeta?.lastFetchedAt === newestFetchedAt) {
    return { groups: 0, autoRead: 0, skipped: true };
  }

  const recentCutoff = Date.now() - DEDUPE_WINDOW_MS;
  const recent = allArticles.filter(article => new Date(article.publishedAt).getTime() >= recentCutoff);
  const clusters = findDuplicateClusters(recent);
  const clusteredIds = new Set();
  const updates = [];
  let autoRead = 0;

  for (const cluster of clusters) {
    cluster.forEach(article => clusteredIds.add(article.id));

    const representative = chooseClusterRepresentative(cluster);
    const existingRepresentatives = cluster.filter(article => article.duplicateRepresentative);
    const previousRepresentative = [...existingRepresentatives]
      .sort((a, b) => duplicateArticleTime(b) - duplicateArticleTime(a))[0] || null;

    // A genuinely newer article joining an existing group is a new update to the story.
    // Keep that newest article unread even if the old representative had already been read.
    const promotedNewerArticle = Boolean(
      previousRepresentative
      && previousRepresentative.id !== representative.id
      && duplicateArticleTime(representative) > duplicateArticleTime(previousRepresentative)
    );

    const groupUnread = promotedNewerArticle
      ? true
      : existingRepresentatives.length
        ? existingRepresentatives.some(article => !article.read)
        : cluster.some(article => !article.read && !article.duplicateAutoRead);

    // Preserve the existing group id when a newer representative is promoted.
    const existingGroupId = cluster.find(article => article.duplicateGroupId)?.duplicateGroupId || '';
    const groupId = existingGroupId || `dup-${representative.id}`;

    for (const article of cluster) {
      const isRepresentative = article.id === representative.id;
      const nextRead = isRepresentative ? !groupUnread : true;
      const nextAutoRead = !isRepresentative && groupUnread && (!article.read || article.duplicateAutoRead);
      if (!isRepresentative && !article.read && nextRead) autoRead++;

      updates.push({
        id: article.id,
        patch: {
          duplicateGroupId: groupId,
          duplicateRepresentative: isRepresentative,
          duplicateAutoRead: nextAutoRead,
          read: nextRead
        }
      });
    }
  }

  for (const article of recent) {
    if (!article.duplicateGroupId || clusteredIds.has(article.id)) continue;
    updates.push({
      id: article.id,
      patch: {
        duplicateGroupId: '',
        duplicateRepresentative: false,
        read: article.duplicateAutoRead ? false : article.read,
        duplicateAutoRead: false
      }
    });
  }

  await dbPatchArticles(updates);
  await chrome.storage.local.set({
    dedupeMeta: { version: DEDUPE_VERSION, lastFetchedAt: newestFetchedAt }
  });
  return { groups: clusters.length, autoRead, skipped: false };
}
