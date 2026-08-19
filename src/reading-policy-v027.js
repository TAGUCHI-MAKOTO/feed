// v0.2.7: oldest-first duplicate reading policy + show all remaining articles
// ---------------------------------------------------------------------------
// Duplicate detection itself is unchanged. This file only defines how a
// duplicate group behaves after detection:
//   1) the oldest published article is the representative/unread item;
//   2) newer duplicates are auto-read;
//   3) once the topic is read, every future member of that group stays read;
//   4) manually returning the topic to unread clears that topic-read state.

(() => {
  const v027RawDbPatchArticles = dbPatchArticles;
  const v027RawDbPatchArticle = dbPatchArticle;

  function v027ArticleTime(article) {
    const published = new Date(article?.publishedAt || '').getTime();
    if (Number.isFinite(published) && published > 0) return published;
    const fetched = new Date(article?.fetchedAt || '').getTime();
    return Number.isFinite(fetched) ? fetched : 0;
  }

  function v027OldestArticle(members = []) {
    return [...members].sort((a, b) => {
      const timeDiff = v027ArticleTime(a) - v027ArticleTime(b);
      if (timeDiff) return timeDiff;

      const fetchedA = new Date(a?.fetchedAt || 0).getTime();
      const fetchedB = new Date(b?.fetchedAt || 0).getTime();
      const fetchedDiff = (Number.isFinite(fetchedA) ? fetchedA : 0) - (Number.isFinite(fetchedB) ? fetchedB : 0);
      if (fetchedDiff) return fetchedDiff;
      return String(a?.id || '').localeCompare(String(b?.id || ''));
    })[0] || null;
  }

  function v027TopicAlreadyRead(members = []) {
    if (members.some(article => article.duplicateTopicRead === true)) return true;

    // Migration from older builds:
    // - all read + no duplicateAutoRead = the user actually finished the topic;
    // - duplicateAutoRead still present = dedupe may have hidden the representative,
    //   so restore the oldest article as unread once rather than risk missing it.
    const allRead = members.length > 0 && members.every(article => article.read === true);
    const hasAutoRead = members.some(article => article.duplicateAutoRead === true);
    return allRead && !hasAutoRead;
  }

  async function v027MarkTopicsReadForIds(ids = []) {
    const uniqueIds = [...new Set(ids.filter(Boolean))];
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

    if (updates.length) await v027RawDbPatchArticles(updates);
  }

  async function v027NormalizeDuplicateGroups() {
    const allArticles = await dbGetAllArticles();
    const groups = new Map();

    for (const article of allArticles) {
      if (!article.duplicateGroupId) continue;
      if (!groups.has(article.duplicateGroupId)) groups.set(article.duplicateGroupId, []);
      groups.get(article.duplicateGroupId).push(article);
    }

    const updates = [];
    let unreadTopics = 0;
    let readTopics = 0;

    for (const [groupId, members] of groups) {
      if (members.length < 2) continue;
      const representative = v027OldestArticle(members);
      if (!representative) continue;

      const topicRead = v027TopicAlreadyRead(members);
      if (topicRead) readTopics++;
      else unreadTopics++;

      for (const article of members) {
        const isRepresentative = article.id === representative.id;
        updates.push({
          id: article.id,
          patch: topicRead
            ? {
                duplicateGroupId: groupId,
                duplicateRepresentative: isRepresentative,
                duplicateAutoRead: false,
                duplicateTopicRead: true,
                read: true
              }
            : {
                duplicateGroupId: groupId,
                duplicateRepresentative: isRepresentative,
                duplicateAutoRead: !isRepresentative,
                duplicateTopicRead: false,
                read: !isRepresentative
              }
        });
      }
    }

    if (updates.length) await v027RawDbPatchArticles(updates);
    return { groups: groups.size, unreadTopics, readTopics, patched: updates.length };
  }

  // Make the fast and content-aware passes choose the oldest item too. The final
  // normalizer below still runs after every dedupe pass as a safety net.
  if (typeof chooseClusterRepresentative === 'function') {
    chooseClusterRepresentative = function(cluster) {
      return v027OldestArticle(cluster);
    };
  }

  // Direct one-article writes (for example a lazily inserted image link) should
  // also mark the whole duplicate topic as read.
  dbPatchArticle = async function(id, patch) {
    await v027RawDbPatchArticle(id, patch);
    const looksLikeManualRead = patch?.read === true
      && !Object.prototype.hasOwnProperty.call(patch, 'duplicateGroupId')
      && !Object.prototype.hasOwnProperty.call(patch, 'duplicateRepresentative')
      && !Object.prototype.hasOwnProperty.call(patch, 'duplicateTopicRead');
    if (looksLikeManualRead) await v027MarkTopicsReadForIds([id]);
  };

  // The existing bulk "表示中を既読" handler writes through dbPatchArticles.
  // Detect those plain read writes and persist topic-read state for the group.
  dbPatchArticles = async function(updates) {
    await v027RawDbPatchArticles(updates);
    const manualReadIds = (updates || [])
      .filter(update => {
        const patch = update?.patch || {};
        return patch.read === true
          && !Object.prototype.hasOwnProperty.call(patch, 'duplicateGroupId')
          && !Object.prototype.hasOwnProperty.call(patch, 'duplicateRepresentative')
          && !Object.prototype.hasOwnProperty.call(patch, 'duplicateTopicRead');
      })
      .map(update => update.id);
    if (manualReadIds.length) await v027MarkTopicsReadForIds(manualReadIds);
  };

  // Reading a duplicate topic locks that topic to read. Returning it to unread
  // explicitly clears the lock and restores the oldest member as the only unread.
  const v027BaseSetStoryReadState = setStoryReadState;
  setStoryReadState = async function(id, read) {
    const allArticles = await dbGetAllArticles();
    const target = allArticles.find(article => article.id === id);
    if (!target?.duplicateGroupId) return v027BaseSetStoryReadState(id, read);

    const members = allArticles.filter(article => article.duplicateGroupId === target.duplicateGroupId);
    if (members.length < 2) return v027BaseSetStoryReadState(id, read);

    if (read) {
      await v027RawDbPatchArticles(members.map(article => ({
        id: article.id,
        patch: {
          read: true,
          duplicateAutoRead: false,
          duplicateTopicRead: true
        }
      })));
      if (typeof v021ScheduleAutoAdvance === 'function') v021ScheduleAutoAdvance(80);
      return;
    }

    const representative = v027OldestArticle(members);
    await v027RawDbPatchArticles(members.map(article => ({
      id: article.id,
      patch: {
        read: article.id !== representative.id,
        duplicateRepresentative: article.id === representative.id,
        duplicateAutoRead: article.id !== representative.id,
        duplicateTopicRead: false
      }
    })));
  };

  // Always normalize after every duplicate pass. This runs after the existing
  // earthquake/structured-event safety policy in reading-flow.js.
  const v027BaseDeduplicateRecentArticles = deduplicateRecentArticles;
  deduplicateRecentArticles = async function(force = false) {
    const result = await v027BaseDeduplicateRecentArticles(force);
    const policy = await v027NormalizeDuplicateGroups();
    return {
      ...result,
      oldestRepresentativePolicy: true,
      topicReadGroups: policy.readTopics,
      topicUnreadGroups: policy.unreadTopics,
      topicPolicyPatched: policy.patched
    };
  };

  function v027DecorateUi() {
    if (elements?.loadMoreBtn) {
      elements.loadMoreBtn.textContent = '残りをすべて表示';
      elements.loadMoreBtn.setAttribute('aria-label', '残っている記事をすべて表示');
    }

    document.querySelectorAll('.article-card.has-duplicates').forEach(card => {
      const representativeStatus = card.querySelector('.duplicate-status.representative');
      if (representativeStatus) representativeStatus.textContent = card.classList.contains('read') ? '既読' : '未読';

      const summary = card.querySelector('.duplicate-summary small');
      if (summary) {
        summary.textContent = card.classList.contains('read')
          ? 'この話題は確認済みです。後から追加された重複記事も既読にします'
          : '最初の記事を未読代表にし、後から追加された重複記事は自動で既読にしています';
      }
    });
  }

  const v027BaseRender = render;
  render = async function() {
    const result = await v027BaseRender();
    v027DecorateUi();
    return result;
  };

  // Replace the old +50 behavior. Capture phase ensures this wins over the
  // pre-existing bubble listener in app-events.js.
  if (elements?.loadMoreBtn) {
    elements.loadMoreBtn.addEventListener('click', async event => {
      event.preventDefault();
      event.stopImmediatePropagation();
      renderedLimit = Number.MAX_SAFE_INTEGER;
      await render();
    }, true);
  }

  // One-time migration/repair on startup. Ambiguous legacy groups that were fully
  // auto-read are restored with their oldest representative unread, preventing misses.
  setTimeout(async () => {
    try {
      await v027NormalizeDuplicateGroups();
      await render();
    } catch (error) {
      console.warn('v0.2.7 重複既読ポリシーの初期化をスキップ:', error);
      v027DecorateUi();
    }
  }, 0);
})();
