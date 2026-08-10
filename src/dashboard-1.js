const DB_NAME = 'myfeed-db';
const DB_VERSION = 1;
const ARTICLE_STORE = 'articles';
const PAGE_SIZE = 50;
const IMAGE_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
const IMAGE_ENRICH_CONCURRENCY = 3;
const DEDUPE_VERSION = 1;
const DEDUPE_WINDOW_MS = 48 * 60 * 60 * 1000;
const DEDUPE_MAX_ARTICLES = 2500;
const DEDUPE_SIMILARITY = 0.76;
const CACHE_RETENTION_MS = 72 * 60 * 60 * 1000;

let currentFilter = 'all';
let currentSourceId = '';
let currentCategoryId = null;
let renderedLimit = PAGE_SIZE;
let autoRefreshTimer = null;
let cacheCleanupTimer = null;
let imageObserver = null;
let imageEnrichActive = 0;
const imageEnrichQueue = [];
const imageEnrichQueued = new Set();
let renderedArticleMap = new Map();
let currentRenderSources = [];

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const elements = {
  navList: $('#navList'),
  sourceNav: $('#sourceNav'),
  viewTitle: $('#viewTitle'),
  statusText: $('#statusText'),
  searchInput: $('#searchInput'),
  refreshBtn: $('#refreshBtn'),
  sortSelect: $('#sortSelect'),
  markAllReadBtn: $('#markAllReadBtn'),
  viewCardBtn: $('#viewCardBtn'),
  viewCompactBtn: $('#viewCompactBtn'),
  articleCount: $('#articleCount'),
  emptyState: $('#emptyState'),
  feedList: $('#feedList'),
  loadMoreWrap: $('#loadMoreWrap'),
  loadMoreBtn: $('#loadMoreBtn'),
  sourcesDialog: $('#sourcesDialog'),
  sourceForm: $('#sourceForm'),
  sourceType: $('#sourceType'),
  sourceName: $('#sourceName'),
  sourceValue: $('#sourceValue'),
  sourceCategory: $('#sourceCategory'),
  sourceValueLabel: $('#sourceValueLabel'),
  sourceHint: $('#sourceHint'),
  sourceList: $('#sourceList'),
  sourceCount: $('#sourceCount'),
  settingsDialog: $('#settingsDialog'),
  settingsForm: $('#settingsForm'),
  autoRefreshMinutes: $('#autoRefreshMinutes'),
  themeMode: $('#themeMode'),
  categoryNameInput: $('#categoryNameInput'),
  addCategoryBtn: $('#addCategoryBtn'),
  categoryManagerList: $('#categoryManagerList'),
  clearArticlesBtn: $('#clearArticlesBtn'),
  toast: $('#toast')
};

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ARTICLE_STORE)) {
        const store = db.createObjectStore(ARTICLE_STORE, { keyPath: 'id' });
        store.createIndex('publishedAt', 'publishedAt');
        store.createIndex('sourceType', 'sourceType');
        store.createIndex('read', 'read');
        store.createIndex('favorite', 'favorite');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function dbPutArticles(articles) {
  if (!articles.length) return;
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(ARTICLE_STORE, 'readwrite');
    const store = tx.objectStore(ARTICLE_STORE);

    for (const article of articles) {
      const getReq = store.get(article.id);
      getReq.onsuccess = () => {
        const existing = getReq.result;
        if (!existing) {
          store.put(article);
          return;
        }

        store.put({
          ...existing,
          ...article,
          imageUrl: article.imageUrl || existing.imageUrl || '',
          imageCheckedAt: article.imageUrl ? '' : (existing.imageCheckedAt || article.imageCheckedAt || ''),
          read: existing.read,
          favorite: existing.favorite
        });
      };
    }

    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function dbGetAllArticles() {
  const db = await openDb();
  const result = await new Promise((resolve, reject) => {
    const tx = db.transaction(ARTICLE_STORE, 'readonly');
    const req = tx.objectStore(ARTICLE_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return result;
}

async function dbPatchArticle(id, patch) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(ARTICLE_STORE, 'readwrite');
    const store = tx.objectStore(ARTICLE_STORE);
    const req = store.get(id);
    req.onsuccess = () => {
      if (req.result) store.put({ ...req.result, ...patch });
    };
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function dbPatchMany(ids, patch) {
  if (!ids.length) return;
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(ARTICLE_STORE, 'readwrite');
    const store = tx.objectStore(ARTICLE_STORE);
    for (const id of ids) {
      const req = store.get(id);
      req.onsuccess = () => {
        if (req.result) store.put({ ...req.result, ...patch });
      };
    }
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function dbPatchArticles(updates) {
  if (!updates.length) return;
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(ARTICLE_STORE, 'readwrite');
    const store = tx.objectStore(ARTICLE_STORE);
    for (const { id, patch } of updates) {
      const req = store.get(id);
      req.onsuccess = () => {
        if (req.result) store.put({ ...req.result, ...patch });
      };
    }
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function dbClearArticles() {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(ARTICLE_STORE, 'readwrite');
    tx.objectStore(ARTICLE_STORE).clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function dbDeleteArticles(ids) {
  if (!ids.length) return;
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(ARTICLE_STORE, 'readwrite');
    const store = tx.objectStore(ARTICLE_STORE);
    for (const id of ids) store.delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function cleanupExpiredArticles() {
  const allArticles = await dbGetAllArticles();
  const cutoff = Date.now() - CACHE_RETENTION_MS;
  const expiredIds = allArticles
    .filter(article => {
      if (article.favorite) return false;
      const time = new Date(article.publishedAt || article.fetchedAt || 0).getTime();
      return Number.isFinite(time) && time > 0 && time < cutoff;
    })
    .map(article => article.id);

  if (!expiredIds.length) return { deleted: 0 };

  await dbDeleteArticles(expiredIds);
  const expiredSet = new Set(expiredIds);
  const survivors = allArticles.filter(article => !expiredSet.has(article.id));
  const groupCounts = new Map();
  for (const article of survivors) {
    if (!article.duplicateGroupId) continue;
    groupCounts.set(article.duplicateGroupId, (groupCounts.get(article.duplicateGroupId) || 0) + 1);
  }

  const orphanUpdates = survivors
    .filter(article => article.duplicateGroupId && (groupCounts.get(article.duplicateGroupId) || 0) < 2)
    .map(article => ({
      id: article.id,
      patch: {
        duplicateGroupId: '',
        duplicateRepresentative: false,
        read: article.duplicateAutoRead ? false : article.read,
        duplicateAutoRead: false
      }
    }));
  await dbPatchArticles(orphanUpdates);

  await chrome.storage.local.set({ dedupeMeta: { version: 0, lastFetchedAt: '' } });
  return { deleted: expiredIds.length };
}

async function getState() {
  return chrome.storage.local.get({
    sources: [],
    categories: [],
    categoryLayoutInitialized: false,
    settings: { autoRefreshMinutes: 30, viewMode: 'card', sortMode: 'newest', themeMode: 'system' },
    collapsedCategories: {},
    dedupeMeta: { version: 0, lastFetchedAt: '' },
    demoSeeded: false
  });
}

async function saveSources(sources) {
  await chrome.storage.local.set({ sources });
}

async function saveCategories(categories) {
  await chrome.storage.local.set({ categories });
}

async function toggleCategoryCollapsed(categoryId) {
  const { collapsedCategories } = await getState();
  const next = { ...(collapsedCategories || {}) };
  next[categoryId] = !next[categoryId];
  await chrome.storage.local.set({ collapsedCategories: next });
  await render();
}

async function saveSettings(settings) {
  await chrome.storage.local.set({ settings });
}

function normalizeThemeMode(mode) {
  return ['system', 'light', 'dark'].includes(mode) ? mode : 'system';
}

function normalizeSortMode(mode) {
  if (mode === 'unread') return 'unreadOnly';
  return ['newest', 'oldest', 'unreadOnly', 'readOnly', 'all'].includes(mode) ? mode : 'newest';
}

function applyTheme(mode) {
  const normalized = normalizeThemeMode(mode);
  document.documentElement.dataset.theme = normalized;
}

function uid() {
  return `${Date.now()}-${crypto.randomUUID()}`;
}

async function hashText(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function stripHtml(html = '') {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
}

function normalizeDate(value) {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function typeLabel(type) {
  return type === 'rss' ? 'WEB' : type === 'google' ? 'News' : 'X';
}

function typeIcon(type) {
  return type === 'rss' ? '🌐' : type === 'google' ? '🔎' : '𝕏';
}

function categoryKey(source) {
  return source.categoryId || '';
}

function orderedCategories(categories = []) {
  return [...categories].sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
}

function orderedSources(sources = []) {
  return [...sources].sort((a, b) => {
    const orderDiff = (Number(a.order) || 0) - (Number(b.order) || 0);
    return orderDiff || String(a.name || '').localeCompare(String(b.name || ''), 'ja');
  });
}

function normalizeXHandle(value = '') {
  let handle = value.trim();
  handle = handle.replace(/^https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\//i, '');
  handle = handle.replace(/^@/, '');
  handle = handle.split(/[/?#]/)[0].trim();
  return handle;
}

function sourceUrl(source) {
  if (source.type === 'rss') return source.value.trim();
  if (source.type === 'google') {
    const q = encodeURIComponent(source.value.trim());
    return `https://news.google.com/rss/search?q=${q}&hl=ja&gl=JP&ceid=JP:ja`;
  }
  if (source.type === 'x') {
    const handle = normalizeXHandle(source.value);
    if (!handle) throw new Error('Xアカウント名が空です');
    return `https://nitter.net/${encodeURIComponent(handle)}/rss`;
  }
  throw new Error('不明なフィード種別です');
}

async function fetchXml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      signal: controller.signal,
      headers: { 'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function resolveHttpUrl(value = '', baseUrl = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const resolved = new URL(raw, baseUrl || undefined);
    if (!['http:', 'https:'].includes(resolved.protocol)) return '';
    return resolved.href;
  } catch {
    return '';
  }
}

function candidateFromSrcset(srcset = '', baseUrl = '') {
  if (!srcset) return '';
  const candidates = srcset.split(',')
    .map(part => part.trim().split(/\s+/)[0])
    .map(value => resolveHttpUrl(value, baseUrl))
    .filter(Boolean);
  return candidates.at(-1) || '';
}

function extractFirstImageFromHtml(html = '', baseUrl = '') {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const image = doc.querySelector('img');
  if (!image) return '';

  const candidates = [
    image.getAttribute('src'),
    image.getAttribute('data-src'),
    image.getAttribute('data-original'),
    image.getAttribute('data-lazy-src'),
    candidateFromSrcset(image.getAttribute('srcset') || image.getAttribute('data-srcset') || '', baseUrl)
  ];

  for (const candidate of candidates) {
    const resolved = resolveHttpUrl(candidate, baseUrl);
    if (resolved) return resolved;
  }
  return '';
}

function firstChildText(root, tagNames) {
  for (const name of tagNames) {
    const node = root.getElementsByTagName(name)[0];
    const value = node?.textContent?.trim();
    if (value) return value;
  }
  return '';
}

function imageFromXmlEntry(entry, rawHtml, baseUrl, articleUrl = '') {
  const preferredBase = articleUrl || baseUrl;
  const mediaTags = ['media:content', 'media:thumbnail', 'thumbnail'];

  for (const tag of mediaTags) {
    for (const node of Array.from(entry.getElementsByTagName(tag))) {
      const rawUrl = node.getAttribute('url') || node.getAttribute('href');
      const medium = (node.getAttribute('medium') || '').toLowerCase();
      const type = (node.getAttribute('type') || '').toLowerCase();
      if (medium && medium !== 'image') continue;
      if (type && !type.startsWith('image/')) continue;
      const resolved = resolveHttpUrl(rawUrl, preferredBase);
      if (resolved) return resolved;
    }
  }

  for (const enclosure of Array.from(entry.getElementsByTagName('enclosure'))) {
    const type = (enclosure.getAttribute('type') || '').toLowerCase();
    if (type && !type.startsWith('image/')) continue;
    const resolved = resolveHttpUrl(enclosure.getAttribute('url'), preferredBase);
    if (resolved) return resolved;
  }

  return extractFirstImageFromHtml(rawHtml, preferredBase);
}

function parseFeed(xmlText, source, feedUrl = '') {
  const xml = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (xml.querySelector('parsererror')) throw new Error('RSS/XMLを解析できませんでした');

  const rssItems = Array.from(xml.querySelectorAll('channel > item'));
  if (rssItems.length) {
    return rssItems.map(item => {
      const link = firstChildText(item, ['link']);
      const rawDescription = firstChildText(item, ['content:encoded', 'description']);
      return {
        title: firstChildText(item, ['title']) || '(無題)',
        url: link,
        description: rawDescription,
        imageUrl: imageFromXmlEntry(item, rawDescription, feedUrl, link),
        publishedAt: firstChildText(item, ['pubDate', 'dc:date']),
        guid: firstChildText(item, ['guid'])
      };
    });
  }

  const atomEntries = Array.from(xml.querySelectorAll('feed > entry'));
  return atomEntries.map(entry => {
    const alternate = entry.querySelector('link[rel="alternate"]') || entry.querySelector('link[href]');
    const link = alternate?.getAttribute('href') || '';
    const rawDescription = firstChildText(entry, ['content', 'summary']);
    return {
      title: firstChildText(entry, ['title']) || '(無題)',
      url: resolveHttpUrl(link, feedUrl) || link,
      description: rawDescription,
      imageUrl: imageFromXmlEntry(entry, rawDescription, feedUrl, link),
      publishedAt: firstChildText(entry, ['published', 'updated']),
      guid: firstChildText(entry, ['id'])
    };
  });
}

async function normalizeItems(items, source) {
  const result = [];
  for (const item of items) {
    const title = stripHtml(item.title || '(無題)');
    const url = item.url || '';
    const basis = item.guid || url || `${source.id}|${title}|${item.publishedAt}`;
    result.push({
      id: await hashText(basis),
      sourceId: source.id,
      sourceName: source.name,
      sourceType: source.type,
      title,
      description: stripHtml(item.description || '').slice(0, 500),
      imageUrl: resolveHttpUrl(item.imageUrl || '', url || sourceUrl(source)),
      imageCheckedAt: '',
      url,
      publishedAt: normalizeDate(item.publishedAt),
      fetchedAt: new Date().toISOString(),
      read: false,
      favorite: false
    });
  }
  return result;
}
