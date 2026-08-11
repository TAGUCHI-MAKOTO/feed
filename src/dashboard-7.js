// v0.1.15: direct website favicon discovery + cleaner empty folders
// ---------------------------------------------------------------
const V015_SOURCE_ICON_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
let v015SourceIconDiscoveryRunning = false;
let v015SourceIconDiscoveryPending = false;

// v0.1.14 used /favicon.ico guessing. For WEB RSS, only use an icon that was
// discovered from the website HTML. Google News / X keep their known icons.
v014SourceFaviconUrl = function(source, allArticles = []) {
  if (!source) return '';
  if (source.type === 'google') return 'https://news.google.com/favicon.ico';
  if (source.type === 'x') return 'https://x.com/favicon.ico';
  return source.siteIconUrl || '';
};

function v015ExtractFeedSiteUrl(xmlText, feedUrl = '') {
  try {
    const xml = new DOMParser().parseFromString(xmlText, 'application/xml');
    if (xml.querySelector('parsererror')) return '';

    const rssLink = xml.querySelector('channel > link')?.textContent?.trim();
    const resolvedRss = resolveHttpUrl(rssLink, feedUrl);
    if (resolvedRss) return resolvedRss;

    const atomLink = xml.querySelector('feed > link[rel="alternate"]') || xml.querySelector('feed > link[href]');
    const resolvedAtom = resolveHttpUrl(atomLink?.getAttribute('href') || '', feedUrl);
    if (resolvedAtom) return resolvedAtom;
  } catch {
    // fall through
  }
  return '';
}

function v015SiteIconScore(node) {
  const rel = (node.getAttribute('rel') || '').toLowerCase();
  const sizes = (node.getAttribute('sizes') || '').toLowerCase();
  const type = (node.getAttribute('type') || '').toLowerCase();
  let score = 0;

  if (rel.split(/\s+/).includes('icon')) score += 100;
  if (rel.includes('apple-touch-icon')) score += 70;
  if (rel.includes('mask-icon')) score += 20;
  if (sizes === 'any') score += 40;

  const match = sizes.match(/(\d+)x(\d+)/);
  if (match) score += Math.min(60, Math.max(Number(match[1]), Number(match[2])) / 4);
  if (type.includes('svg')) score += 15;
  if (type.includes('png')) score += 10;
  return score;
}

function v015ExtractDeclaredSiteIcon(html, baseUrl) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const nodes = Array.from(doc.querySelectorAll(
    'link[rel~="icon"][href], link[rel*="apple-touch-icon"][href], link[rel="mask-icon"][href]'
  ));

  const candidates = nodes
    .map(node => ({
      url: resolveHttpUrl(node.getAttribute('href') || '', baseUrl),
      score: v015SiteIconScore(node)
    }))
    .filter(item => item.url)
    .sort((a, b) => b.score - a.score);

  return candidates[0]?.url || '';
}

function v015FallbackSitePageUrl(source, allArticles = []) {
  const article = allArticles
    .filter(item => item.sourceId === source.id && item.url)
    .sort((a, b) => new Date(b.publishedAt || 0).getTime() - new Date(a.publishedAt || 0).getTime())
    .find(item => {
      try {
        const host = new URL(item.url).hostname.toLowerCase();
        return host
          && !/(^|\.)(youtube\.com|youtu\.be|x\.com|twitter\.com|news\.google\.com)$/.test(host)
          && !host.includes('nitter.');
      } catch {
        return false;
      }
    });

  if (article?.url) return article.url;
  try {
    return new URL(source.value).origin + '/';
  } catch {
    return '';
  }
}

async function v015DiscoverDirectSiteIcon(source, allArticles = []) {
  if (!source || source.type !== 'rss') return null;

  let siteUrl = source.siteUrl || '';
  if (!siteUrl) {
    try {
      const feedUrl = sourceUrl(source);
      const xmlText = await fetchXml(feedUrl);
      siteUrl = v015ExtractFeedSiteUrl(xmlText, feedUrl);
    } catch (error) {
      console.debug('フィード元サイトURLの取得をスキップ:', source.name, error);
    }
  }

  if (!siteUrl) siteUrl = v015FallbackSitePageUrl(source, allArticles);
  if (!siteUrl) {
    return { siteUrl: '', siteIconUrl: '', siteIconCheckedAt: new Date().toISOString() };
  }

  let page = null;
  try {
    page = await fetchHtmlPage(siteUrl);
  } catch (error) {
    console.debug('サイトアイコン取得をスキップ:', source.name, error);
  }

  const finalUrl = page?.finalUrl || siteUrl;
  let siteIconUrl = page ? v015ExtractDeclaredSiteIcon(page.html, finalUrl) : '';

  // Only if the website HTML does not declare an icon, use the conventional path.
  if (!siteIconUrl) {
    try {
      siteIconUrl = `${new URL(finalUrl).origin}/favicon.ico`;
    } catch {
      siteIconUrl = '';
    }
  }

  return {
    siteUrl: finalUrl,
    siteIconUrl,
    siteIconCheckedAt: new Date().toISOString()
  };
}

async function v015PatchSourceIconMetadata(sourceId, patch) {
  const { sources } = await getState();
  const nextSources = sources.map(source => source.id === sourceId ? { ...source, ...patch } : source);
  await saveSources(nextSources);

  const updated = nextSources.find(source => source.id === sourceId);
  if (!updated) return;

  document.querySelectorAll(`.source-item[data-source-id="${CSS.escape(sourceId)}"] .source-kind-icon`).forEach(holder => {
    holder.innerHTML = v014FeedIconMarkup(updated, []);
    v014BindFaviconFallbacks(holder);
  });

  document.querySelectorAll(`.source-row[data-id="${CSS.escape(sourceId)}"] .source-type`).forEach(holder => {
    holder.innerHTML = v014FeedIconMarkup(updated, []);
    holder.classList.add('source-manager-icon');
    v014BindFaviconFallbacks(holder);
  });
}

function v015ShouldDiscoverSourceIcon(source) {
  if (!source || source.type !== 'rss') return false;
  if (source.siteIconUrl) return false;
  if (!source.siteIconCheckedAt) return true;

  const checked = new Date(source.siteIconCheckedAt).getTime();
  return !Number.isFinite(checked) || Date.now() - checked > V015_SOURCE_ICON_RETRY_MS;
}

async function v015DiscoverMissingSourceIcons(sources, allArticles = []) {
  if (v015SourceIconDiscoveryRunning) {
    v015SourceIconDiscoveryPending = true;
    return;
  }

  const targets = sources.filter(v015ShouldDiscoverSourceIcon);
  if (!targets.length) return;

  v015SourceIconDiscoveryRunning = true;
  try {
    // Sequential on purpose: don't hit many websites at once when hundreds of feeds exist.
    for (const source of targets) {
      const patch = await v015DiscoverDirectSiteIcon(source, allArticles);
      if (patch) await v015PatchSourceIconMetadata(source.id, patch);
    }
  } finally {
    v015SourceIconDiscoveryRunning = false;
    if (v015SourceIconDiscoveryPending) {
      v015SourceIconDiscoveryPending = false;
      const [state, articles] = await Promise.all([getState(), dbGetAllArticles()]);
      v015DiscoverMissingSourceIcons(state.sources, articles);
    }
  }
}

// v0.1.14 already wraps renderSourceNavigation. Add the final cleanup/discovery layer.
const v015BaseRenderSourceNavigation = renderSourceNavigation;
renderSourceNavigation = function(sources, categories, allArticles, collapsedCategories = {}) {
  v015BaseRenderSourceNavigation(sources, categories, allArticles, collapsedCategories);

  // Empty folders remain valid drop targets via .custom-category; explanatory text is unnecessary.
  elements.sourceNav.querySelectorAll('.source-empty').forEach(node => node.remove());
  v015DiscoverMissingSourceIcons(sources, allArticles);
};

// v0.1.16: one-input registration + automatic type/name detection
// ----------------------------------------------------------------
function v016DetectSourceInput(raw = '') {
  const value = String(raw || '').trim();
  if (!value) return { type: '', value: '' };
  if (value.startsWith('@') && /^@[A-Za-z0-9_]{1,15}$/.test(value)) {
    return { type: 'x', value: normalizeXHandle(value) };
  }
  if (/^https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\//i.test(value)) {
    return { type: 'x', value: normalizeXHandle(value) };
  }
  if (/^https?:\/\//i.test(value)) return { type: 'rss', value };
  return { type: 'google', value };
}

function v016FeedTitle(xmlText = '') {
  try {
    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    if (doc.querySelector('parsererror')) return '';
    const channelTitle = doc.querySelector('channel > title')?.textContent?.trim();
    const feedTitle = Array.from(doc.documentElement?.children || [])
      .find(node => node.localName === 'title')?.textContent?.trim();
    return channelTitle || feedTitle || '';
  } catch {
    return '';
  }
}

function v016LooksLikeFeed(xmlText = '') {
  try {
    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    if (doc.querySelector('parsererror')) return false;
    const root = (doc.documentElement?.localName || '').toLowerCase();
    return ['rss', 'feed', 'rdf'].includes(root) || Boolean(doc.querySelector('channel > item, entry'));
  } catch {
    return false;
  }
}

function v016SiteNameFromHtml(html = '', fallbackUrl = '') {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const values = [
      doc.querySelector('meta[property="og:site_name"]')?.getAttribute('content'),
      doc.querySelector('meta[name="application-name"]')?.getAttribute('content'),
      doc.querySelector('meta[name="apple-mobile-web-app-title"]')?.getAttribute('content'),
      doc.querySelector('title')?.textContent
    ];
    for (const value of values) {
      const cleaned = String(value || '').replace(/\s+/g, ' ').trim();
      if (cleaned) return cleaned.slice(0, 100);
    }
  } catch { /* noop */ }
  try { return new URL(fallbackUrl).hostname.replace(/^www\./, ''); } catch { return 'WEBフィード'; }
}

function v016DiscoverFeedUrl(html = '', baseUrl = '') {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const links = Array.from(doc.querySelectorAll('link[rel~="alternate"][href]'));
    const preferred = links.find(link => /(?:application|text)\/(?:rss|atom)\+?xml/i.test(link.getAttribute('type') || ''))
      || links.find(link => /rss|atom/i.test(`${link.getAttribute('type') || ''} ${link.getAttribute('title') || ''} ${link.getAttribute('href') || ''}`));
    return preferred ? resolveHttpUrl(preferred.getAttribute('href'), baseUrl) : '';
  } catch {
    return '';
  }
}

async function v016PrepareSource(rawValue, categoryId = '') {
  const detected = v016DetectSourceInput(rawValue);
  if (!detected.type) throw new Error('URL・Xアカウント・キーワードを入力してください。');

  if (detected.type === 'google') {
    return { id: uid(), type: 'google', name: detected.value, value: detected.value, categoryId };
  }

  if (detected.type === 'x') {
    if (!detected.value) throw new Error('Xアカウントを判定できませんでした。');
    let name = detected.value;
    try {
      const xml = await fetchXml(sourceUrl({ type: 'x', value: detected.value }));
      const title = v016FeedTitle(xml);
      if (title) name = title.replace(/\s*\(@?[^)]+\)\s*$/, '').trim() || detected.value;
    } catch { /* Nitter unavailable: use handle */ }
    return { id: uid(), type: 'x', name, value: detected.value, categoryId };
  }

  // URL: try it as RSS/Atom first, then discover RSS/Atom from the website HTML.
  try {
    const xml = await fetchXml(detected.value);
    if (v016LooksLikeFeed(xml)) {
      const fallback = (() => {
        try { return new URL(detected.value).hostname.replace(/^www\./, ''); } catch { return 'WEBフィード'; }
      })();
      return { id: uid(), type: 'rss', name: v016FeedTitle(xml) || fallback, value: detected.value, categoryId };
    }
  } catch { /* try HTML next */ }

  const page = await fetchHtmlPage(detected.value);
  if (!page) throw new Error('Webサイトを取得できませんでした。');
  const siteName = v016SiteNameFromHtml(page.html, page.finalUrl || detected.value);
  const feedUrl = v016DiscoverFeedUrl(page.html, page.finalUrl || detected.value);
  if (!feedUrl) throw new Error('このWebサイトからRSS / Atomを見つけられませんでした。RSS URLを直接入力してください。');
  const xml = await fetchXml(feedUrl);
  if (!v016LooksLikeFeed(xml)) throw new Error('見つかったURLをRSS / Atomとして読み込めませんでした。');
  return { id: uid(), type: 'rss', name: v016FeedTitle(xml) || siteName, value: feedUrl, categoryId };
}

function v016UpdateDetectionHint() {
  const hint = document.getElementById('sourceDetectHint');
  if (!hint) return;
  const detected = v016DetectSourceInput(elements.sourceValue.value);
  const labels = { rss: 'WEB RSS', x: 'X / Nitter', google: 'Google News キーワード' };
  hint.textContent = detected.type ? `自動判定：${labels[detected.type]}` : '自動判定：入力待ち';
}

function v016InstallRegistrationUi() {
  const formGrid = elements.sourceForm?.querySelector('.form-grid');
  if (!formGrid) return;
  formGrid.classList.add('auto-source-form');

  const typeLabel = elements.sourceType.closest('label');
  const nameLabel = elements.sourceName.closest('label');
  const categoryLabel = elements.sourceCategory.closest('label');
  const valueLabel = elements.sourceValue.closest('label');
  if (typeLabel) typeLabel.hidden = true;
  if (nameLabel) nameLabel.hidden = true;
  elements.sourceName.required = false;
  if (valueLabel) {
    valueLabel.classList.add('wide');
    valueLabel.style.order = '1';
  }
  if (categoryLabel) {
    categoryLabel.classList.add('wide', 'source-category-select');
    categoryLabel.style.order = '2';
  }

  const label = document.getElementById('sourceValueLabel');
  const hint = document.getElementById('sourceHint');
  if (label) label.textContent = 'URL / Xアカウント / キーワード';
  if (hint) hint.textContent = 'URLならWEB RSS、@またはXのURLならX、それ以外はGoogle Newsキーワードとして自動判定します。';
  elements.sourceValue.placeholder = 'https://example.com / https://x.com/OpenAI / @OpenAI / 生成AI';

  if (!document.getElementById('sourceDetectHint') && hint) {
    const detect = document.createElement('small');
    detect.id = 'sourceDetectHint';
    detect.className = 'source-detect-hint';
    hint.after(detect);
  }
  v016UpdateDetectionHint();

  if (!document.getElementById('v016Styles')) {
    const style = document.createElement('style');
    style.id = 'v016Styles';
    style.textContent = `
      .auto-source-form { grid-template-columns: 1fr; }
      .auto-source-form .wide { grid-column: 1; }
      .auto-source-form #sourceValue { font-size: 16px; min-height: 48px; }
      .source-detect-hint { display:inline-flex; width:fit-content; margin-top:2px; padding:4px 8px; border-radius:999px; background:var(--accent-soft); color:var(--accent-dark); font-size:12px; font-weight:800; }
      .source-category-select { max-width:420px; }
      .source-name:hover { text-decoration:underline dotted; text-underline-offset:3px; }
    `;
    document.head.appendChild(style);
  }
}

async function v016RenameSource(sourceId) {
  const { sources } = await getState();
  const source = sources.find(item => item.id === sourceId);
  if (!source) return;
  const next = prompt('フィードの表示名を変更', source.name || '');
  if (next === null) return;
  const name = next.trim();
  if (!name || name === source.name) return;
  await saveSources(sources.map(item => item.id === sourceId ? { ...item, name } : item));
  const articles = await dbGetAllArticles();
  const ids = articles.filter(article => article.sourceId === sourceId).map(article => article.id);
  await dbPatchMany(ids, { sourceName: name });
  await renderSources();
  await render();
  showToast(`表示名を「${name}」に変更しました。`);
}

elements.sourceValue.addEventListener('input', v016UpdateDetectionHint);
elements.sourceNav.addEventListener('dblclick', async event => {
  const row = event.target.closest('.source-item[data-source-id]');
  if (!row || !event.target.closest('.source-name')) return;
  event.preventDefault();
  event.stopPropagation();
  await v016RenameSource(row.dataset.sourceId);
});
elements.sourceNav.addEventListener('mouseover', event => {
  const name = event.target.closest('.source-name');
  if (name) name.title = 'ダブルクリックで表示名を変更';
});

// Capture phase: this runs before the legacy submit handler in dashboard-4.js.
elements.sourceForm.addEventListener('submit', async event => {
  event.preventDefault();
  event.stopImmediatePropagation();
  const rawValue = elements.sourceValue.value.trim();
  if (!rawValue) return;

  const saveButton = document.getElementById('saveSourceBtn');
  const originalLabel = saveButton?.textContent || '登録する';
  if (saveButton) {
    saveButton.disabled = true;
    saveButton.textContent = '確認中…';
  }

  try {
    const source = await v016PrepareSource(rawValue, elements.sourceCategory.value || '');
    elements.sourceType.value = source.type;
    elements.sourceName.value = source.name;

    const { sources } = await getState();
    const duplicate = sources.some(item => item.type === source.type
      && String(item.value).trim().toLowerCase() === String(source.value).trim().toLowerCase());
    if (duplicate) throw new Error('同じフィードはすでに登録されています。');

    const sameCategory = sources.filter(item => categoryKey(item) === source.categoryId);
    source.order = sameCategory.length;
    await saveSources([...sources, source]);
    elements.sourceValue.value = '';
    elements.sourceName.value = '';
    v016UpdateDetectionHint();
    await renderSources();
    await render();
    showToast(`${source.name} を登録しました。`);
  } catch (error) {
    console.error(error);
    showToast(`登録できませんでした：${error.message}`, true);
  } finally {
    if (saveButton) {
      saveButton.disabled = false;
      saveButton.textContent = originalLabel;
    }
  }
}, true);

v016InstallRegistrationUi();
// dashboard-4.js calls its legacy helper during init, so re-apply after that synchronous step.
setTimeout(v016InstallRegistrationUi, 0);
