// v0.1.22: feed health tracking only (automatic repair disabled)
// ---------------------------------------------------------------
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
    return { text: await response.text(), requestedUrl: url, finalUrl: response.url || url, redirected: Boolean(response.redirected) };
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
    return Array.from(doc.getElementsByTagName('*')).some(node => ['item', 'entry'].includes((node.localName || '').toLowerCase()));
  } catch { return false; }
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
  const failedAt = source.feedLastFailureAt ? new Date(source.feedLastFailureAt).toLocaleString('ja-JP') : '';
  return failedAt ? `読込エラー：${message}（${failedAt}）` : `読込エラー：${message}`;
}

const V032_REFRESH_CONCURRENCY = 6;
let v032ProgressHideTimer = null;

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
      ui.detail.textContent =
        `成功 ${success} ・ 失敗 ${failed} ・ ${elapsed.toFixed(elapsed >= 10 ? 0 : 1)}秒`;
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

async function refreshAll() {
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

    // Save all feed-health changes in ONE chrome.storage.local write.
    if (sourcePatches.size) {
      const nextSources = sources.map(source => {
        const patch = sourcePatches.get(source.id);
        return patch ? { ...source, ...patch } : source;
      });
      await saveSources(nextSources);
    }

    // Save all fetched articles in ONE IndexedDB transaction.
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
}

function sortArticles(articles) {
  const mode = elements.sortSelect.value || 'newest';
  return articles.sort((a, b) => {
    const aTime = new Date(a.publishedAt).getTime();
    const bTime = new Date(b.publishedAt).getTime();
    if (mode === 'oldest') return aTime - bTime;
    return bTime - aTime;
  });
}

function getFilteredArticles(allArticles) {
  const term = elements.searchInput.value.trim().toLowerCase();
  const mode = elements.sortSelect.value || 'newest';

  const filtered = allArticles
    .filter(a => {
      if (currentFavoriteCategoryId !== null) {
        if (!a.favorite) return false;
        const source = currentRenderSources.find(item => item.id === a.sourceId);
        return source && categoryKey(source) === currentFavoriteCategoryId;
      }
      if (currentSourceId) return a.sourceId === currentSourceId;
      if (currentCategoryId !== null) {
        const source = currentRenderSources.find(item => item.id === a.sourceId);
        return source && categoryKey(source) === currentCategoryId;
      }
      if (currentFilter === 'favorite') return a.favorite;
      if (['rss', 'google', 'x'].includes(currentFilter)) return a.sourceType === currentFilter;
      return true;
    })
    .filter(a => currentFilter !== 'unread' || !a.read)
    .filter(a => mode !== 'unreadOnly' || !a.read)
    .filter(a => mode !== 'readOnly' || a.read)
    .filter(a => !term || `${a.title} ${a.description} ${a.sourceName}`.toLowerCase().includes(term));

  return sortArticles(filtered);
}

function formatRelativeDate(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return 'たった今';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}時間前`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}日前`;
  return new Date(iso).toLocaleDateString('ja-JP');
}

function countUnread(articles) {
  return articles.reduce((count, article) => count + (article.read ? 0 : 1), 0);
}


function sourceFaviconUrl(source, allArticles = []) {
  if (!source) return '';
  if (source.type === 'google') return 'https://news.google.com/favicon.ico';
  if (source.type === 'x') return 'https://x.com/favicon.ico';
  // WEBはv0.1.15でサイトHTMLから直接見つけたアイコンだけを使う。
  return source.siteIconUrl || '';
}

function sourceIconHtml(source, allArticles = []) {
  const favicon = sourceFaviconUrl(source, allArticles);
  const fallback = typeIcon(source.type);
  if (!favicon) return `<span class="source-fallback-icon">${fallback}</span>`;
  return `<span class="source-icon-wrap">
    <img class="source-favicon" src="${escapeHtml(favicon)}" alt="" loading="lazy" decoding="async" />
    <span class="source-fallback-icon">${fallback}</span>
  </span>`;
}

function attachSourceFaviconFallbacks(root = document) {
  root.querySelectorAll('.source-favicon').forEach(image => {
    if (image.dataset.fallbackBound === 'true') return;
    image.dataset.fallbackBound = 'true';
    image.addEventListener('load', () => image.closest('.source-icon-wrap')?.classList.add('loaded'), { once: true });
    image.addEventListener('error', () => image.closest('.source-icon-wrap')?.classList.add('failed'), { once: true });
    if (image.complete) {
      if (image.naturalWidth > 0) image.closest('.source-icon-wrap')?.classList.add('loaded');
      else image.closest('.source-icon-wrap')?.classList.add('failed');
    }
  });
}

