// v0.2.8: bulk-read duplicate-topic lock fix
// -------------------------------------------
// "表示中を既読" uses dbPatchMany(), while v0.2.7 only wrapped
// dbPatchArticle()/dbPatchArticles(). As a result, duplicateTopicRead was not
// persisted for duplicate groups and the oldest representative could be
// restored to unread on the next duplicate normalization pass.

(() => {
  const v028RawDbPatchMany = dbPatchMany;
  const v028RawDbPatchArticles = dbPatchArticles;

  async function v028LockDuplicateTopics(ids = []) {
    const uniqueIds = [...new Set((ids || []).filter(Boolean))];
    if (!uniqueIds.length) return;

    const allArticles = await dbGetAllArticles();
    const targetIds = new Set(uniqueIds);
    const groupIds = new Set(
      allArticles
        .filter(article => targetIds.has(article.id) && article.duplicateGroupId)
        .map(article => article.duplicateGroupId)
    );

    if (!groupIds.size) return;

    const updates = allArticles
      .filter(article => groupIds.has(article.duplicateGroupId))
      .map(article => ({
        id: article.id,
        patch: {
          read: true,
          duplicateAutoRead: false,
          duplicateTopicRead: true
        }
      }));

    if (updates.length) await v028RawDbPatchArticles(updates);
  }

  dbPatchMany = async function(ids, patch) {
    await v028RawDbPatchMany(ids, patch);

    const looksLikeBulkRead = patch?.read === true
      && !Object.prototype.hasOwnProperty.call(patch, 'duplicateGroupId')
      && !Object.prototype.hasOwnProperty.call(patch, 'duplicateRepresentative')
      && !Object.prototype.hasOwnProperty.call(patch, 'duplicateTopicRead');

    if (looksLikeBulkRead) await v028LockDuplicateTopics(ids);
  };
})();
