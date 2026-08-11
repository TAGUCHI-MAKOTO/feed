// v0.2.1: content-aware duplicate detection
// -----------------------------------------
// Base dedupe remains the fast first pass. This module performs a second pass
// using RSS description/content first, and article-body signatures only for
// ambiguous cross-feed candidates.

const V021_CONTENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const V021_BODY_WINDOW_MS = 18 * 60 * 60 * 1000;
const V021_BODY_RETRY_MS = 24 * 60 * 60 * 1000;
const V021_BODY_MAX_PAIRS = 18;
const V021_BODY_MAX_ARTICLES = 10;
const V021_BODY_CONCURRENCY = 3;

function v021NormalizeContentText(value = '') {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[!！?？“”"'‘’「」『』【】\[\]［］()（）・、,，.。:：;；|｜/／\\—–ー~〜…]/g, '')
    .trim();
}

function v021ContentBigrams(value = '') {
  const text = v021NormalizeContentText(value).slice(0, 1800);
  return rawBigrams(text);
}

function v021DescriptionSimilarity(a, b) {
  const aText = v021NormalizeContentText(a.description || '');
  const bText = v021NormalizeContentText(b.description || '');
  if (aText.length < 35 || bText.length < 35) return 0;
  return diceSimilarity(v021ContentBigrams(aText), v021ContentBigrams(bText));
}

function v021TitleSimilarity(a, b) {
  return diceSimilarity(makeBigrams(a.title || ''), makeBigrams(b.title || ''));
}

function v021StrongContentDuplicate(a, b, titleScore, descriptionScore) {
  const sameSource = a.sourceId && a.sourceId === b.sourceId;
  if (sameSource) return titleScore >= 0.70 && descriptionScore >= 0.58;
  if (titleScore >= 0.62 && descriptionScore >= 0.42) return true;
  if (titleScore >= 0.48 && descriptionScore >= 0.62) return true;
  if (titleScore >= 0.32 && descriptionScore >= 0.76) return true;
  return false;
}

function v021BodyCandidate(a, b, titleScore, descriptionScore, timeDiff) {
  if (!a.url || !b.url) return false;
  if (a.sourceId && a.sourceId === b.sourceId) return false;
  if (timeDiff > V021_BODY_WINDOW_MS) return false;
  if (titleScore < 0.36 && descriptionScore < 0.28) return false;
  return true;
}

function v021ExtractMainText(html = '') {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const root = doc.querySelector('article, main, [role="main"]') || doc.body;
  if (!root) return '';
  const clone = root.cloneNode(true);
  clone.querySelectorAll('script,style,noscript,nav,header,footer,aside,form,svg,canvas,iframe,.advertisement,.ads,.ad,.share,.social,.breadcrumb').forEach(node => node.remove());
  return String(clone.textContent || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 8000);
}

function v021Fnv1a64(value = '') {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < value.length; i++) {
    hash ^= BigInt(value.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * prime);
  }
  return hash;
}

function v021BodySimHash(text = '') {
  const normalized = String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '')
    .slice(0, 6500);
  if (normalized.length < 300) return '';

  const vector = new Int32Array(64);
  const gramSize = 3;
  const step = normalized.length > 4000 ? 2 : 1;
  for (let i = 0; i <= normalized.length - gramSize; i += step) {
    const gram = normalized.slice(i, i + gramSize);
    const hash = v021Fnv1a64(gram);
    for (let bit = 0n; bit < 64n; bit++) {
      vector[Number(bit)] += ((hash >> bit) & 1n) === 1n ? 1 : -1;
    }
  }

  let signature = 0n;
  for (let i = 0; i < 64; i++) {
    if (vector[i] >= 0) signature |= (1n << BigInt(i));
  }
  return signature.toString(16).padStart(16, '0');
}

function v021BodySignatureSimilarity(a = '', b = '') {
  if (!/^[0-9a-f]{16}$/i.test(a) || !/^[0-9a-f]{16}$/i.test(b)) return 0;
  let xor = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let distance = 0;
  while (xor) {
    distance += Number(xor & 1n);
    xor >>= 1n;
  }
  return 1 - (distance / 64);
}

async function v021FetchBodyPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const type = (response.headers.get('content-type') || '').toLowerCase();
    if (type && !type.includes('html') && !type.includes('xhtml')) return null;
    return { html: await response.text(), finalUrl: response.url || url };
  } finally {
    clearTimeout(timer);
  }
}

async function v021ResolveArticleBodyPage(article) {
  const first = await v021FetchBodyPage(article.url);
  if (!first) return null;
  try {
    const firstUrl = new URL(first.finalUrl || article.url);
    if (firstUrl.hostname === 'news.google.com' && typeof googleExternalArticleCandidate === 'function') {
      const doc = new DOMParser().parseFromString(first.html, 'text/html');
      const external = googleExternalArticleCandidate(doc, first.finalUrl || article.url);
      if (external) {
        try {
          const second = await v021FetchBodyPage(external);
          if (second) return second;
        } catch (error) {
          console.debug('重複判定用Google News本文の取得をスキップ:', error);
        }
      }
    }
  } catch { /* first pageを使う */ }
  return first;
}

async function v021GetBodySignature(article) {
  const checkedAt = new Date(article.dedupeBodyCheckedAt || 0).getTime();
  const isFresh = Number.isFinite(checkedAt) && checkedAt > 0 && Date.now() - checkedAt < V021_BODY_RETRY_MS;
  if (isFresh) return article.dedupeBodySignature || '';
  if (!article.url || !resolveHttpUrl(article.url)) return '';

  const now = new Date().toISOString();
  try {
    const page = await v021ResolveArticleBodyPage(article);
    const text = page ? v021ExtractMainText(page.html) : '';
    const signature = v021BodySimHash(text);
    await dbPatchArticle(article.id, {
      dedupeBodySignature: signature,
      dedupeBodyCheckedAt: now,
      dedupeBodyLength: text.length
    });
    article.dedupeBodySignature = signature;
    article.dedupeBodyCheckedAt = now;
    article.dedupeBodyLength = text.length;
    return signature;
  } catch (error) {
    console.debug('重複判定用本文の取得をスキップ:', article.title, error);
    await dbPatchArticle(article.id, {
      dedupeBodySignature: '',
      dedupeBodyCheckedAt: now,
      dedupeBodyLength: 0
    });
    article.dedupeBodySignature = '';
    article.dedupeBodyCheckedAt = now;
    article.dedupeBodyLength = 0;
    return '';
  }
}

async function v021RunLimited(items, concurrency, worker) {
  let next = 0;
  async function runner() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  }
  const count = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: count }, () => runner()));
}

function v021PairPriority(pair) {
  return pair.titleScore * 0.62 + pair.descriptionScore * 0.38;
}

async function v021EnhanceDuplicateGroups() {
  const allArticles = await dbGetAllArticles();
  const cutoff = Date.now() - V021_CONTENT_WINDOW_MS;
  const recent = allArticles
    .filter(article => new Date(article.publishedAt || article.fetchedAt || 0).getTime() >= cutoff)
    .sort((a, b) => new Date(b.publishedAt || b.fetchedAt || 0).getTime() - new Date(a.publishedAt || a.fetchedAt || 0).getTime())
    .slice(0, 1500);
  if (recent.length < 2) return { groups: 0, autoRead: 0, bodyPairs: 0 };

  const parent = recent.map((_, index) => index);
  const rank = recent.map(() => 0);
  const find = index => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const union = (a, b) => {
    let ra = find(a);
    let rb = find(b);
    if (ra === rb) return false;
    if (rank[ra] < rank[rb]) [ra, rb] = [rb, ra];
    parent[rb] = ra;
    if (rank[ra] === rank[rb]) rank[ra]++;
    return true;
  };

  const existingOwner = new Map();
  recent.forEach((article, index) => {
    if (!article.duplicateGroupId) return;
    if (existingOwner.has(article.duplicateGroupId)) union(index, existingOwner.get(article.duplicateGroupId));
    else existingOwner.set(article.duplicateGroupId, index);
  });

  const ambiguous = [];
  for (let i = 0; i < recent.length; i++) {
    const a = recent[i];
    const aTime = new Date(a.publishedAt || a.fetchedAt || 0).getTime();
    for (let j = i + 1; j < recent.length; j++) {
      const b = recent[j];
      const bTime = new Date(b.publishedAt || b.fetchedAt || 0).getTime();
      const timeDiff = Math.abs(aTime - bTime);
      if (timeDiff > V021_CONTENT_WINDOW_MS) break;
      if (find(i) === find(j)) continue;

      const aUrl = canonicalArticleUrl(a.url || '');
      const bUrl = canonicalArticleUrl(b.url || '');
      if (aUrl && bUrl && aUrl === bUrl) {
        union(i, j);
        continue;
      }

      const titleScore = v021TitleSimilarity(a, b);
      const descriptionScore = v021DescriptionSimilarity(a, b);
      if (v021StrongContentDuplicate(a, b, titleScore, descriptionScore)) {
        union(i, j);
        continue;
      }
      if (v021BodyCandidate(a, b, titleScore, descriptionScore, timeDiff)) {
        ambiguous.push({ i, j, titleScore, descriptionScore });
      }
    }
  }

  ambiguous.sort((a, b) => v021PairPriority(b) - v021PairPriority(a));
  const bodyPairs = ambiguous.slice(0, V021_BODY_MAX_PAIRS);
  const articleIndexes = [];
  const seenIndexes = new Set();
  for (const pair of bodyPairs) {
    for (const index of [pair.i, pair.j]) {
      if (seenIndexes.has(index)) continue;
      seenIndexes.add(index);
      articleIndexes.push(index);
      if (articleIndexes.length >= V021_BODY_MAX_ARTICLES) break;
    }
    if (articleIndexes.length >= V021_BODY_MAX_ARTICLES) break;
  }

  await v021RunLimited(articleIndexes, V021_BODY_CONCURRENCY, async index => {
    await v021GetBodySignature(recent[index]);
  });

  let bodyMatched = 0;
  for (const pair of bodyPairs) {
    if (!seenIndexes.has(pair.i) || !seenIndexes.has(pair.j)) continue;
    if (find(pair.i) === find(pair.j)) continue;
    const a = recent[pair.i];
    const b = recent[pair.j];
    const bodyScore = v021BodySignatureSimilarity(a.dedupeBodySignature || '', b.dedupeBodySignature || '');
    const matched = bodyScore >= 0.89
      || (bodyScore >= 0.83 && pair.titleScore >= 0.44)
      || (bodyScore >= 0.81 && pair.descriptionScore >= 0.44);
    if (matched && union(pair.i, pair.j)) bodyMatched++;
  }

  const groups = new Map();
  recent.forEach((article, index) => {
    const root = find(index);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(article);
  });

  const clusters = [...groups.values()].filter(group => group.length > 1);
  const updates = [];
  let autoRead = 0;
  for (const cluster of clusters) {
    const representative = chooseClusterRepresentative(cluster);
    const existingRepresentatives = cluster.filter(article => article.duplicateRepresentative);
    const groupUnread = existingRepresentatives.length
      ? existingRepresentatives.some(article => !article.read)
      : cluster.some(article => !article.read && !article.duplicateAutoRead);
    const inheritedGroupId = representative.duplicateGroupId
      || cluster.find(article => article.duplicateGroupId)?.duplicateGroupId
      || `dup-${representative.id}`;

    for (const article of cluster) {
      const isRepresentative = article.id === representative.id;
      const nextRead = isRepresentative ? !groupUnread : true;
      const nextAutoRead = !isRepresentative && groupUnread && (!article.read || article.duplicateAutoRead);
      if (!isRepresentative && !article.read && nextRead) autoRead++;
      updates.push({
        id: article.id,
        patch: {
          duplicateGroupId: inheritedGroupId,
          duplicateRepresentative: isRepresentative,
          duplicateAutoRead: nextAutoRead,
          read: nextRead
        }
      });
    }
  }

  await dbPatchArticles(updates);
  return { groups: clusters.length, autoRead, bodyPairs: bodyPairs.length, bodyMatched };
}

const v021BaseDeduplicateRecentArticles = deduplicateRecentArticles;
deduplicateRecentArticles = async function(force = false) {
  const base = await v021BaseDeduplicateRecentArticles(force);
  const enhanced = await v021EnhanceDuplicateGroups();
  return {
    ...base,
    groups: Math.max(Number(base?.groups || 0), Number(enhanced.groups || 0)),
    autoRead: Number(base?.autoRead || 0) + Number(enhanced.autoRead || 0),
    contentEnhanced: true,
    bodyPairs: enhanced.bodyPairs || 0,
    bodyMatched: enhanced.bodyMatched || 0
  };
};
