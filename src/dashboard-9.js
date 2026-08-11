// v0.1.18: registered-feed health tracking + automatic repair
// -----------------------------------------------------------
const FEED_AUTO_REPAIR_FAILURE_THRESHOLD = 3;
const FEED_AUTO_REPAIR_RETRY_MS = 60 * 60 * 1000;
let feedRefreshRunning = false;

function feedErrorStatus(error) {
  const status = Number(error?.status || 0);
  return Number.isFinite(status) ? status : 0;
}

async function fetchFeedMeta(url) {
  async function fetchOnce(targetUrl) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(targetUrl, {
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
        requestedUrl: targetUrl,
        finalUrl: response.url || targetUrl,
        redirected: Boolean(response.redirected),
        upgradedFromHttp: false
      };
    } finally {
      clearTimeout(timer);
    }
  }

  try {
    return await fetchOnce(url);
  } catch (firstError) {
    if (/^http:\/\//i.test(url)) {
      const httpsUrl = url.replace(/^http:\/\//i, 'https://');
      try {
        const result = await fetchOnce(httpsUrl);
        result.upgradedFromHttp = true;
        result.originalUrl = url;
        return result;
      } catch {
        // Fall through to the original error so the health log reflects
        // the URL the user actually registered.
      }
    }
    throw firstError;
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

async function probePermanentRedirect(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'Accept': 'application/rss+xml, application/atom+xml, application/rdf+xml, application/xml, text/xml, */*' }
    });
    if (![301, 308].includes(response.status)) return '';
    const location = response.headers.get('location') || '';
    return resolveHttpUrl(location, url);
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

function discoverFeedCandidates(html = '', baseUrl = '') {
  const candidates = [];
  const add = (value, score = 0) => {
    const url = resolveHttpUrl(value, baseUrl);
    if (!url) return;
    candidates.push({ url, score });
  };

  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    for (const link of Array.from(doc.querySelectorAll('link[rel~="alternate"][href]'))) {
      const type = (link.getAttribute('type') || '').toLowerCase();
      const title = (link.getAttribute('title') || '').toLowerCase();
      const href = link.getAttribute('href') || '';
      let score = 0;
      if (/application\/rss\+xml/.test(type)) score += 120;
      else if (/application\/atom\+xml/.test(type)) score += 115;
      else if (/rdf|rss|atom|xml/.test(type)) score += 80;
      if (/rss|atom|feed/.test(`${title} ${href}`)) score += 40;
      if (score) add(href, score);
    }

    for (const anchor of Array.from(doc.querySelectorAll('a[href]'))) {
      const label = `${anchor.textContent || ''} ${anchor.getAttribute('title') || ''} ${anchor.getAttribute('href') || ''}`.toLowerCase();
      if (!/(^|\b)(rss|atom|feed)(\b|$)/i.test(label)) continue;
      add(anchor.getAttribute('href'), 25);
    }
  } catch {
    // Conventional candidates below are still useful.
  }

  try {
    const origin = new URL(baseUrl).origin;
    [
      '/feed', '/feed/', '/feed.xml',
      '/rss', '/rss/', '/rss.xml',
      '/atom.xml', '/index.xml'
    ].forEach((path, index) => add(origin + path, 10 - index / 10));
  } catch { /* noop */ }

  const best = new Map();
  for (const item of candidates) {
    const key = item.url.replace(/#.*$/, '');
    if (!best.has(key) || best.get(key).score < item.score) best.set(key, item);
  }
  return [...best.values()].sort((a, b) => b.score - a.score).map(item => item.url);
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

async function validateFeedCandidate(candidateUrl, source) {
  const meta = await fetchFeedMeta(candidateUrl);
  if (!looksLikeFeedDocument(meta.text)) throw new Error('RSS / Atomとして認識できませんでした');
  const previewSource = { ...source, value: meta.finalUrl || candidateUrl };
  const parsed = parseFeed(meta.text, previewSource, meta.finalUrl || candidateUrl);
  return { meta, parsed, source: previewSource };
}

async function tryRepairRegisteredFeed(source) {
  if (!source || source.type !== 'rss') return null;

  const originalUrl = source.value;
  const pageUrls = [];
  const candidateUrls = [];

  const addPage = value => {
    const url = resolveHttpUrl(value);
    if (url && !pageUrls.includes(url)) pageUrls.push(url);
  };
  const addCandidate = value => {
    const url = resolveHttpUrl(value);
    if (url && !candidateUrls.includes(url)) candidateUrls.push(url);
  };

  if (/^http:\/\//i.test(originalUrl)) addCandidate(originalUrl.replace(/^http:\/\//i, 'https://'));
  addPage(source.siteUrl || '');
  try { addPage(new URL(originalUrl).origin + '/'); } catch { /* noop */ }

  for (const pageUrl of pageUrls) {
    let page = null;
    try {
      page = await fetchHtmlPage(pageUrl);
    } catch {
      continue;
    }
    if (!page) continue;
    const finalPageUrl = page.finalUrl || pageUrl;
    discoverFeedCandidates(page.html, finalPageUrl).forEach(addCandidate);
  }

  const normalizedOriginal = resolveHttpUrl(originalUrl);
  const candidates = candidateUrls.filter(url => url !== normalizedOriginal).slice(0, 14);

  for (const candidate of candidates) {
    try {
      const validated = await validateFeedCandidate(candidate, source);
      const finalFeedUrl = validated.meta.finalUrl || candidate;
      const repairedSource = { ...source, value: finalFeedUrl };
      const normalized = await normalizeItems(validated.parsed, repairedSource);

      let siteUrl = source.siteUrl || '';
      try {
        if (typeof v015ExtractFeedSiteUrl === 'function') {
          siteUrl = v015ExtractFeedSiteUrl(validated.meta.text, finalFeedUrl) || siteUrl;
        }
      } catch { /* noop */ }

      return {
        newUrl: finalFeedUrl,
        normalized,
        patch: {
          value: finalFeedUrl,
          siteUrl,
          siteIconUrl: '',
          siteIconCheckedAt: '',
          feedFailCount: 0,
          feedHealthStatus: 'ok',
          feedLastError: '',
          feedLastSuccessAt: new Date().toISOString(),
          feedLastRepairAttemptAt: new Date().toISOString(),
          feedRepairedAt: new Date().toISOString(),
          feedRepairFrom: originalUrl,
          feedRepairTo: finalFeedUrl
        }
      };
    } catch (error) {
      console.debug('自動修復候補をスキップ:', source.name, candidate, error);
    }
  }
  return null;
}

function shouldAttemptFeedRepair(source, error, failCount) {
  if (!source || source.type !== 'rss') return false;
  const status = feedErrorStatus(error);
  if ([404, 410].includes(status)) return true;
  if (failCount < FEED_AUTO_REPAIR_FAILURE_THRESHOLD) return false;

  const lastAttempt = new Date(source.feedLastRepairAttemptAt || 0).getTime();
  return !Number.isFinite(lastAttempt) || Date.now() - lastAttempt >= FEED_AUTO_REPAIR_RETRY_MS;
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
  let repaired = 0;
  let redirected = 0;
  const errors = [];
  const repairs = [];

  try {
    for (let i = 0; i < sources.length; i++) {
      const source = sources[i];
      elements.statusText.textContent = `${i + 1}/${sources.length}  ${source.name} を取得中…`;

      try {
        const url = sourceUrl(source);
        const meta = await fetchFeedMeta(url);
        if (!looksLikeFeedDocument(meta.text)) throw new Error('RSS / Atomとして認識できませんでした');

        const parsed = parseFeed(meta.text, source, meta.finalUrl || url);
        const effectiveSource = source.type === 'rss' && meta.finalUrl
          ? { ...source, value: meta.finalUrl }
          : source;
        const normalized = await normalizeItems(parsed, effectiveSource);
        await dbPutArticles(normalized);
        received += normalized.length;
        success++;

        const now = new Date().toISOString();
        const healthPatch = {
          feedFailCount: 0,
          feedHealthStatus: 'ok',
          feedLastError: '',
          feedLastSuccessAt: now
        };

        if (source.type === 'rss' && meta.upgradedFromHttp && meta.finalUrl && meta.finalUrl !== source.value) {
          Object.assign(healthPatch, {
            value: meta.finalUrl,
            feedRepairedAt: now,
            feedRepairFrom: source.value,
            feedRepairTo: meta.finalUrl,
            siteIconUrl: '',
            siteIconCheckedAt: ''
          });
          repaired++;
          repairs.push(`${source.name}: HTTPSへ更新`);
        } else if (source.type === 'rss' && meta.redirected && meta.finalUrl && meta.finalUrl !== source.value) {
          const permanentTarget = await probePermanentRedirect(url);
          if (permanentTarget) {
            Object.assign(healthPatch, {
              value: meta.finalUrl,
              feedRepairedAt: now,
              feedRepairFrom: source.value,
              feedRepairTo: meta.finalUrl,
              siteIconUrl: '',
              siteIconCheckedAt: ''
            });
            redirected++;
            repairs.push(`${source.name}: 恒久リダイレクトを反映`);
          }
        }

        await patchFeedSource(source.id, healthPatch);
      } catch (error) {
        const failCount = Number(source.feedFailCount || 0) + 1;
        const now = new Date().toISOString();
        await patchFeedSource(source.id, {
          feedFailCount: failCount,
          feedHealthStatus: 'error',
          feedLastError: error.message || String(error),
          feedLastFailureAt: now
        });

        let repairedResult = null;
        if (shouldAttemptFeedRepair(source, error, failCount)) {
          elements.statusText.textContent = `${i + 1}/${sources.length}  ${source.name} を自動修復中…`;
          await patchFeedSource(source.id, { feedLastRepairAttemptAt: now });
          try {
            repairedResult = await tryRepairRegisteredFeed({ ...source, feedFailCount: failCount, feedLastRepairAttemptAt: now });
          } catch (repairError) {
            console.warn('フィード自動修復エラー:', source.name, repairError);
          }
        }

        if (repairedResult) {
          await dbPutArticles(repairedResult.normalized);
          await patchFeedSource(source.id, repairedResult.patch);
          received += repairedResult.normalized.length;
          success++;
          repaired++;
          repairs.push(`${source.name}: ${source.value} → ${repairedResult.newUrl}`);
          continue;
        }

        failed++;
        errors.push(`${source.name}: ${error.message}`);
        console.warn(source.name, error);
      }
    }

    const cleanup = await cleanupExpiredArticles();
    const dedupe = await deduplicateRecentArticles(true);
    const repairText = repaired || redirected ? ` ・ 修復 ${repaired + redirected}件` : '';
    const dedupeText = dedupe.groups ? ` ・ 重複 ${dedupe.groups}話題` : '';
    const cleanupText = cleanup.deleted ? ` ・ 72時間超 ${cleanup.deleted}件削除` : '';
    elements.statusText.textContent =
      `最終更新 ${new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} ・ 成功 ${success} / 失敗 ${failed}${repairText}${dedupeText}${cleanupText}`;
    await render();

    if (repairs.length) {
      const detail = repairs[0];
      showToast(`🔧 フィードを自動修復しました（${repairs.length}件）。${detail}${repairs.length > 1 ? ' ほか' : ''}`);
    } else if (failed) {
      showToast(`取得完了：${received}件 / ${failed}件のフィードでエラー。${errors[0]}`, true);
    } else {
      showToast(`取得完了：${received}件を確認。重複 ${dedupe.groups}話題・${dedupe.autoRead}件を自動既読。72時間超 ${cleanup.deleted}件を整理しました。`);
    }
  } finally {
    feedRefreshRunning = false;
    elements.refreshBtn.disabled = false;
    elements.refreshBtn.textContent = '↻ 更新';
  }
};
