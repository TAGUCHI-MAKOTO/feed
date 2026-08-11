// v0.1.22: feed health tracking only
// -----------------------------------
let feedRefreshRunning = false;

async function fetchFeedMeta(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'Accept': 'application/rss+xml, application/atom+xml, application/rdf+xml, application/xml, text/xml, */*' }
    });
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return {
      text: await response.text(),
      requestedUrl: url,
      finalUrl: response.url || url,
      redirected: Boolean(response.redirected)
    };
  } finally {
    clearTimeout(timer);
  }
}

function looksLikeFeedDocument(xmlText = '') {
  try {
    const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    if (doc.querySelector('parsererror')) return false;
    const root = (doc.documentElement?.localName || '').toLowerCase();
    if (['rss', 'feed', 'rdf'].includes(root)) return true;
    return Array.from(doc.getElementsByTagName('*')).some(node =>
      ['item', 'entry'].includes((node.localName || '').toLowerCase())
    );
  } catch {
    return false;
  }
}

async function patchFeedSource(sourceId, patch) {
  const { sources } = await getState();
  let updated = null;
  const next = sources.map(source => {
    if (source.id !== sourceId) return source;
    updated = { ...source, ...patch };
    return updated;
  });
  if (updated) await saveSources(next);
  return updated;
}

function feedHealthErrorTitle(source) {
  if (!source || source.feedHealthStatus !== 'error') return '';
  const message = source.feedLastError || 'フィードを読み込めませんでした';
  const failedAt = source.feedLastFailureAt
    ? new Date(source.feedLastFailureAt).toLocaleString('ja-JP')
    : '';
  return failedAt ? `読込エラー：${message}（${failedAt}）` : `読込エラー：${message}`;
}

refreshAll = async function() {
  if (feedRefreshRunning) {
    showToast('フィード更新はすでに実行中です。');
    return;
  }

  const { sources } = await getState();
  if (!sources.length) {
    showToast('先にフィードを登録してください。');
    return;
  }

  feedRefreshRunning = true;
  elements.refreshBtn.disabled = true;
  elements.refreshBtn.textContent = '更新中…';
  elements.statusText.textContent = `${sources.length}フィードを確認しています…`;

  let success = 0;
  let failed = 0;
  let received = 0;

  try {
    for (let i = 0; i < sources.length; i++) {
      const source = sources[i];
      elements.statusText.textContent = `${i + 1}/${sources.length}  ${source.name} を取得中…`;

      try {
        const url = sourceUrl(source);
        const meta = await fetchFeedMeta(url);
        if (!looksLikeFeedDocument(meta.text)) {
          throw new Error('RSS / Atom / RDFとして認識できませんでした');
        }

        const parsed = parseFeed(meta.text, source, meta.finalUrl || url);
        const normalized = await normalizeItems(parsed, source);
        await dbPutArticles(normalized);
        received += normalized.length;
        success++;

        await patchFeedSource(source.id, {
          feedFailCount: 0,
          feedHealthStatus: 'ok',
          feedLastError: '',
          feedLastSuccessAt: new Date().toISOString()
        });
      } catch (error) {
        failed++;
        await patchFeedSource(source.id, {
          feedFailCount: Number(source.feedFailCount || 0) + 1,
          feedHealthStatus: 'error',
          feedLastError: error.message || String(error),
          feedLastFailureAt: new Date().toISOString()
        });
        console.warn('フィード取得エラー:', source.name, error);
      }
    }

    const cleanup = await cleanupExpiredArticles();
    const dedupe = await deduplicateRecentArticles(true);
    const dedupeText = dedupe.groups ? ` ・ 重複 ${dedupe.groups}話題` : '';
    const cleanupText = cleanup.deleted ? ` ・ 72時間超 ${cleanup.deleted}件削除` : '';
    elements.statusText.textContent =
      `最終更新 ${new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} ・ 成功 ${success} / 失敗 ${failed}${dedupeText}${cleanupText}`;

    await render();
    if (elements.sourcesDialog?.open) await renderSources();

    if (failed) {
      showToast(`取得完了：${received}件 / ${failed}件のフィードで読込エラー。左カラムの「!」で確認できます。`, true);
    } else {
      showToast(`取得完了：${received}件を確認。重複 ${dedupe.groups}話題・${dedupe.autoRead}件を自動既読。72時間超 ${cleanup.deleted}件を整理しました。`);
    }
  } finally {
    feedRefreshRunning = false;
    elements.refreshBtn.disabled = false;
    elements.refreshBtn.textContent = '↻ 更新';
  }
};
