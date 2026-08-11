// v0.1.32: concurrent feed refresh + visual progress meter
// --------------------------------------------------------
const V032_REFRESH_CONCURRENCY = 6;
let v032ProgressHideTimer = null;

function v032InstallProgressUi() {
  if (document.getElementById('refreshProgress')) return;

  const statusText = document.getElementById('statusText');
  if (!statusText) return;

  const root = document.createElement('div');
  root.id = 'refreshProgress';
  root.className = 'refresh-progress';
  root.hidden = true;
  root.innerHTML = `
    <div class="refresh-progress-head">
      <span id="refreshProgressLabel">フィードを取得しています…</span>
      <strong id="refreshProgressPercent">0%</strong>
    </div>
    <div id="refreshProgressTrack"
         class="refresh-progress-track"
         role="progressbar"
         aria-label="フィード更新の進捗"
         aria-valuemin="0"
         aria-valuemax="100"
         aria-valuenow="0">
      <div id="refreshProgressFill" class="refresh-progress-fill"></div>
    </div>
    <div id="refreshProgressDetail" class="refresh-progress-detail">準備中…</div>`;

  statusText.insertAdjacentElement('afterend', root);
}

function v032ProgressElements() {
  return {
    root: document.getElementById('refreshProgress'),
    label: document.getElementById('refreshProgressLabel'),
    percent: document.getElementById('refreshProgressPercent'),
    track: document.getElementById('refreshProgressTrack'),
    fill: document.getElementById('refreshProgressFill'),
    detail: document.getElementById('refreshProgressDetail')
  };
}

function v032FormatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 2) return '残りわずか';
  if (seconds < 60) return `残り約${Math.ceil(seconds)}秒`;
  return `残り約${Math.ceil(seconds / 60)}分`;
}

function v032ShowProgress() {
  v032InstallProgressUi();
  const ui = v032ProgressElements();
  if (!ui.root) return;

  clearTimeout(v032ProgressHideTimer);
  ui.root.hidden = false;
  ui.root.classList.remove('complete', 'has-errors');
  ui.root.classList.add('running');
  if (ui.fill) ui.fill.style.width = '0%';
  if (ui.percent) ui.percent.textContent = '0%';
  if (ui.track) ui.track.setAttribute('aria-valuenow', '0');
  if (ui.label) ui.label.textContent = `高速更新中（最大${V032_REFRESH_CONCURRENCY}件並列）`;
  if (ui.detail) ui.detail.textContent = '取得を開始しています…';
}

function v032UpdateProgress({ completed, total, success, failed, active, startedAt, phase = 'fetch' }) {
  const ui = v032ProgressElements();
  if (!ui.root) return;

  const safeTotal = Math.max(1, total || 1);
  const pct = phase === 'fetch'
    ? Math.min(100, Math.round((completed / safeTotal) * 100))
    : 100;

  if (ui.fill) ui.fill.style.width = `${pct}%`;
  if (ui.percent) ui.percent.textContent = `${pct}%`;
  if (ui.track) ui.track.setAttribute('aria-valuenow', String(pct));
  ui.root.classList.toggle('has-errors', failed > 0);

  if (phase === 'save') {
    if (ui.label) ui.label.textContent = '記事をまとめて保存中…';
    if (ui.detail) ui.detail.textContent = `取得完了 ${completed}/${total} ・ 成功 ${success} ・ 失敗 ${failed}`;
    return;
  }

  if (phase === 'dedupe') {
    if (ui.label) ui.label.textContent = '重複記事・72時間キャッシュを整理中…';
    if (ui.detail) ui.detail.textContent = `取得完了 ${completed}/${total} ・ 成功 ${success} ・ 失敗 ${failed}`;
    return;
  }

  if (phase === 'complete') {
    ui.root.classList.remove('running');
    ui.root.classList.add('complete');
    if (ui.label) ui.label.textContent = failed ? '更新完了（一部エラーあり）' : '更新完了';
    const elapsed = Math.max(0, (Date.now() - startedAt) / 1000);
    if (ui.detail) {
      ui.detail.textContent = `成功 ${success} ・ 失敗 ${failed} ・ ${elapsed.toFixed(elapsed >= 10 ? 0 : 1)}秒`;
    }
    return;
  }

  if (ui.label) ui.label.textContent = `高速更新中（最大${V032_REFRESH_CONCURRENCY}件並列）`;

  const elapsedSec = Math.max(0.001, (Date.now() - startedAt) / 1000);
  const etaSec = completed > 0
    ? (elapsedSec / completed) * Math.max(0, total - completed)
    : NaN;
  const eta = v032FormatEta(etaSec);

  if (ui.detail) {
    ui.detail.textContent =
      `${completed}/${total} 完了 ・ 成功 ${success} ・ 失敗 ${failed}`
      + (active ? ` ・ 処理中 ${active}` : '')
      + (eta ? ` ・ ${eta}` : '');
  }
}

function v032FinishProgress(metrics) {
  v032UpdateProgress({ ...metrics, phase: 'complete' });
  const ui = v032ProgressElements();
  clearTimeout(v032ProgressHideTimer);
  v032ProgressHideTimer = setTimeout(() => {
    if (ui.root && !feedRefreshRunning) ui.root.hidden = true;
  }, 2800);
}

async function v032FetchOneSource(source) {
  try {
    const url = sourceUrl(source);
    const meta = await fetchFeedMeta(url);

    if (!looksLikeFeedDocument(meta.text)) {
      throw new Error('RSS / Atom / RDFとして認識できませんでした');
    }

    const parsed = parseFeed(meta.text, source, meta.finalUrl || url);
    const normalized = await normalizeItems(parsed, source);

    return {
      ok: true,
      source,
      articles: normalized,
      sourcePatch: {
        feedFailCount: 0,
        feedHealthStatus: 'ok',
        feedLastError: '',
        feedLastFailureAt: '',
        registrationWarning: false,
        feedLastSuccessAt: new Date().toISOString()
      }
    };
  } catch (error) {
    console.warn('フィード取得エラー:', source.name, error);
    return {
      ok: false,
      source,
      articles: [],
      error,
      sourcePatch: {
        feedFailCount: Number(source.feedFailCount || 0) + 1,
        feedHealthStatus: 'error',
        feedLastError: error?.message || String(error),
        feedLastFailureAt: new Date().toISOString()
      }
    };
  }
}

async function v032RunPool(items, worker, concurrency, onSettled) {
  let nextIndex = 0;
  let active = 0;

  async function runner() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;

      active++;
      let result;
      try {
        result = await worker(items[index], index);
      } finally {
        active--;
      }

      await onSettled(result, index, active);
    }
  }

  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runner()));
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

  const startedAt = Date.now();
  const metrics = {
    completed: 0,
    total: sources.length,
    success: 0,
    failed: 0,
    active: 0,
    startedAt
  };

  v032ShowProgress();
  elements.statusText.textContent =
    `${sources.length}フィードを最大${V032_REFRESH_CONCURRENCY}件ずつ並列取得しています…`;

  const allNewArticles = [];
  const sourcePatches = new Map();

  try {
    await v032RunPool(
      sources,
      v032FetchOneSource,
      V032_REFRESH_CONCURRENCY,
      async (result, _index, active) => {
        metrics.completed++;
        metrics.active = active;

        if (result?.ok) {
          metrics.success++;
          if (result.articles?.length) allNewArticles.push(...result.articles);
        } else {
          metrics.failed++;
        }

        if (result?.source?.id && result?.sourcePatch) {
          sourcePatches.set(result.source.id, result.sourcePatch);
        }

        v032UpdateProgress(metrics);
      }
    );

    // Feed health state: one chrome.storage.local write for the whole refresh.
    if (sourcePatches.size) {
      const nextSources = sources.map(source => {
        const patch = sourcePatches.get(source.id);
        return patch ? { ...source, ...patch } : source;
      });
      await saveSources(nextSources);
    }

    // Articles: one IndexedDB transaction for all fetched feeds.
    v032UpdateProgress({ ...metrics, phase: 'save' });
    elements.statusText.textContent =
      `${allNewArticles.length.toLocaleString()}件の記事をまとめて保存しています…`;
    if (allNewArticles.length) await dbPutArticles(allNewArticles);

    v032UpdateProgress({ ...metrics, phase: 'dedupe' });
    elements.statusText.textContent = '重複記事と72時間キャッシュを整理しています…';

    const cleanup = await cleanupExpiredArticles();
    const dedupe = await deduplicateRecentArticles(true);

    const elapsedSec = (Date.now() - startedAt) / 1000;
    const dedupeText = dedupe.groups ? ` ・ 重複 ${dedupe.groups}話題` : '';
    const cleanupText = cleanup.deleted ? ` ・ 72時間超 ${cleanup.deleted}件削除` : '';

    elements.statusText.textContent =
      `最終更新 ${new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`
      + ` ・ ${elapsedSec.toFixed(elapsedSec >= 10 ? 0 : 1)}秒`
      + ` ・ 成功 ${metrics.success} / 失敗 ${metrics.failed}`
      + dedupeText + cleanupText;

    await render();
    if (elements.sourcesDialog?.open) await renderSources();

    v032FinishProgress(metrics);

    if (metrics.failed) {
      showToast(
        `取得完了：${allNewArticles.length.toLocaleString()}件 / ${metrics.failed}件のフィードで読込エラー。`
        + ` ${elapsedSec.toFixed(elapsedSec >= 10 ? 0 : 1)}秒で完了しました。`,
        true
      );
    } else {
      showToast(
        `取得完了：${allNewArticles.length.toLocaleString()}件を確認。`
        + ` ${elapsedSec.toFixed(elapsedSec >= 10 ? 0 : 1)}秒で完了しました。`
      );
    }
  } finally {
    feedRefreshRunning = false;
    elements.refreshBtn.disabled = false;
    elements.refreshBtn.textContent = '↻ 更新';
  }
};

v032InstallProgressUi();
