// v0.1.23: stale feed-error reconciliation
function v023Timestamp(value) {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function v023LatestArticleFetch(sourceId, allArticles = []) {
  let latest = 0;
  for (const article of allArticles) {
    if (article.sourceId !== sourceId) continue;
    latest = Math.max(latest, v023Timestamp(article.fetchedAt));
  }
  return latest;
}

function v023HasActiveFeedError(source, allArticles = []) {
  if (!source || source.feedHealthStatus !== 'error') return false;

  const failureAt = v023Timestamp(source.feedLastFailureAt);
  const successAt = Math.max(
    v023Timestamp(source.feedLastSuccessAt),
    v023LatestArticleFetch(source.id, allArticles)
  );

  if (successAt > 0 && (failureAt === 0 || successAt >= failureAt)) return false;
  return true;
}

async function v023ReconcileStoredFeedHealth() {
  try {
    const [{ sources }, allArticles] = await Promise.all([getState(), dbGetAllArticles()]);
    let changed = false;
    const nextSources = sources.map(source => {
      if (!source || source.feedHealthStatus !== 'error') return source;
      if (v023HasActiveFeedError(source, allArticles)) return source;

      changed = true;
      const articleSuccessAt = v023LatestArticleFetch(source.id, allArticles);
      const knownSuccessAt = Math.max(v023Timestamp(source.feedLastSuccessAt), articleSuccessAt);
      return {
        ...source,
        feedFailCount: 0,
        feedHealthStatus: 'ok',
        feedLastError: '',
        feedLastFailureAt: '',
        registrationWarning: false,
        feedLastSuccessAt: knownSuccessAt ? new Date(knownSuccessAt).toISOString() : source.feedLastSuccessAt
      };
    });
    if (changed) await saveSources(nextSources);
  } catch (error) {
    console.debug('フィード状態の整合をスキップ:', error);
  }
}

const v023BaseRenderSourceNavigation = renderSourceNavigation;
renderSourceNavigation = function(sources, categories, allArticles, collapsedCategories = {}) {
  v023BaseRenderSourceNavigation(sources, categories, allArticles, collapsedCategories);

  document.querySelectorAll('.source-item[data-source-id]').forEach(row => {
    const source = sources.find(item => item.id === row.dataset.sourceId);
    if (!source) return;
    const activeError = v023HasActiveFeedError(source, allArticles);
    if (activeError) return;

    row.classList.remove('has-feed-error');
    row.querySelector('.source-health-warning')?.remove();
    row.title = source.name || '';
  });
};

const v023BaseRenderSources = renderSources;
renderSources = async function(...args) {
  await v023BaseRenderSources(...args);
  const [{ sources }, allArticles] = await Promise.all([getState(), dbGetAllArticles()]);

  document.querySelectorAll('.source-row[data-id]').forEach(row => {
    const source = sources.find(item => item.id === row.dataset.id);
    if (!source) return;
    const activeError = v023HasActiveFeedError(source, allArticles);
    if (activeError) return;

    row.classList.remove('has-feed-error');
    row.querySelector('.source-health-message')?.remove();
  });
};

v023ReconcileStoredFeedHealth().then(() => {
  render().catch(error => console.debug('フィード状態整合後の再描画をスキップ:', error));
});
