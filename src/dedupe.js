function canonicalArticleUrl(value = '') {
  const resolved = resolveHttpUrl(value);
  if (!resolved) return '';
  try {
    const url = new URL(resolved);
    url.hash = '';
    const drop = [
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'gclid', 'fbclid', 'yclid', 'mc_cid', 'mc_eid', 'ref', 'ref_src', 's'
    ];
    drop.forEach(key => url.searchParams.delete(key));
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
    return url.href;
  } catch {
    return resolved;
  }
}

function normalizeDuplicateTitle(value = '') {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\s(?:-|–|—|\||｜)\s[^|｜]{2,40}$/, '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[【\[［(（][^】\]］)）]{0,16}(?:速報|更新|写真|動画|解説|独自|注目|ニュース)[^】\]］)）]{0,16}[】\]］)）]/g, '')
    .replace(/(?:速報|更新|写真|動画|解説|独自)[:：\s]*/g, '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[!！?？“”"'‘’「」『』【】\[\]［］()（）・、,，.。:：;；|｜/／\\—–ー~〜…]/g, '')
    .trim();
}

function makeBigrams(text = '') {
  const normalized = normalizeDuplicateTitle(text);
  const grams = new Set();
  if (!normalized) return grams;
  if (normalized.length < 2) {
    grams.add(normalized);
    return grams;
  }
  for (let i = 0; i < normalized.length - 1; i++) grams.add(normalized.slice(i, i + 2));
  return grams;
}

function diceSimilarity(aSet, bSet) {
  if (!aSet.size || !bSet.size) return 0;
  let common = 0;
  const [small, large] = aSet.size <= bSet.size ? [aSet, bSet] : [bSet, aSet];
  for (const gram of small) if (large.has(gram)) common++;
  return (2 * common) / (aSet.size + bSet.size);
}

function japaneseTitleCore(value = '') {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[a-z0-9_+.#-]+/g, '')
    .replace(/(?:速報|更新|写真|動画|解説|独自|発表)/g, '')
    .replace(/[^ぁ-んァ-ヶ一-龯々]/g, '');
}

function rawBigrams(text = '') {
  const grams = new Set();
  if (!text) return grams;
  if (text.length < 2) {
    grams.add(text);
    return grams;
  }
  for (let i = 0; i < text.length - 1; i++) grams.add(text.slice(i, i + 2));
  return grams;
}

function titleLooksDuplicate(a, b) {
  const aText = a._dedupeTitle;
  const bText = b._dedupeTitle;
  if (!aText || !bText) return false;
  if (aText === bText && aText.length >= 7) return true;

  const minLen = Math.min(aText.length, bText.length);
  const maxLen = Math.max(aText.length, bText.length);
  if (minLen < 9 || minLen / maxLen < 0.48) return false;

  if ((aText.includes(bText) || bText.includes(aText)) && minLen >= 12) return true;

  const score = diceSimilarity(a._dedupeBigrams, b._dedupeBigrams);
  if (score < DEDUPE_SIMILARITY) return false;

  const aJapanese = japaneseTitleCore(a.title || aText);
  const bJapanese = japaneseTitleCore(b.title || bText);
  if (aJapanese.length >= 4 && bJapanese.length >= 4) {
    const japaneseScore = diceSimilarity(rawBigrams(aJapanese), rawBigrams(bJapanese));
    if (japaneseScore < 0.28 && score < 0.90) return false;
  }

  if (minLen < 16 && score < 0.84) return false;
  return true;
}

function representativeScore(article) {
  let score = 0;
  if (article.favorite) score += 1000;
  if (article.sourceType === 'rss') score += 80;
  else if (article.sourceType === 'google') score += 45;
  else if (article.sourceType === 'x') score += 20;

  const host = (() => {
    try { return new URL(article.url || '').hostname.toLowerCase(); } catch { return ''; }
  })();
  if (host && !host.includes('news.google.') && !host.includes('nitter.')) score += 30;
  if (article.imageUrl) score += 15;
  score += Math.min(25, Math.floor((article.description || '').length / 40));
  return score;
}

function chooseClusterRepresentative(cluster) {
  const existing = cluster
    .filter(article => article.duplicateRepresentative)
    .sort((a, b) => representativeScore(b) - representativeScore(a));
  if (existing.length) return existing[0];

  return [...cluster].sort((a, b) => {
    const scoreDiff = representativeScore(b) - representativeScore(a);
    if (scoreDiff) return scoreDiff;
    return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
  })[0];
}

function findDuplicateClusters(articles) {
  if (articles.length < 2) return [];
  const items = [...articles]
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
    .slice(0, DEDUPE_MAX_ARTICLES)
    .map(article => ({
      ...article,
      _dedupeTitle: normalizeDuplicateTitle(article.title),
      _dedupeBigrams: makeBigrams(article.title),
      _dedupeUrl: canonicalArticleUrl(article.url),
      _dedupeTime: new Date(article.publishedAt).getTime()
    }));

  const parent = items.map((_, index) => index);
  const rank = items.map(() => 0);
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
    if (ra === rb) return;
    if (rank[ra] < rank[rb]) [ra, rb] = [rb, ra];
    parent[rb] = ra;
    if (rank[ra] === rank[rb]) rank[ra]++;
  };

  const urlOwner = new Map();
  items.forEach((item, index) => {
    if (!item._dedupeUrl) return;
    if (urlOwner.has(item._dedupeUrl)) union(index, urlOwner.get(item._dedupeUrl));
    else urlOwner.set(item._dedupeUrl, index);
  });

  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    for (let j = i + 1; j < items.length; j++) {
      const b = items[j];
      const diff = Math.abs(a._dedupeTime - b._dedupeTime);
      if (diff > DEDUPE_WINDOW_MS) break;
      if (a._dedupeUrl && b._dedupeUrl && a._dedupeUrl === b._dedupeUrl) continue;
      if (titleLooksDuplicate(a, b)) union(i, j);
    }
  }

  const groups = new Map();
  items.forEach((item, index) => {
    const root = find(index);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(item);
  });

  return [...groups.values()]
    .filter(group => group.length > 1)
    .map(group => group.map(({ _dedupeTitle, _dedupeBigrams, _dedupeUrl, _dedupeTime, ...article }) => article));
}

async function deduplicateRecentArticles(force = false) {
  const allArticles = await dbGetAllArticles();
  if (allArticles.length < 2) return { groups: 0, autoRead: 0, skipped: true };

  const newestFetchedAt = allArticles.reduce((latest, article) => {
    const value = article.fetchedAt || '';
    return value > latest ? value : latest;
  }, '');
  const { dedupeMeta } = await getState();
  if (!force && dedupeMeta?.version === DEDUPE_VERSION && dedupeMeta?.lastFetchedAt === newestFetchedAt) {
    return { groups: 0, autoRead: 0, skipped: true };
  }

  const recentCutoff = Date.now() - DEDUPE_WINDOW_MS;
  const recent = allArticles.filter(article => new Date(article.publishedAt).getTime() >= recentCutoff);
  const clusters = findDuplicateClusters(recent);
  const clusteredIds = new Set();
  const updates = [];
  let autoRead = 0;

  for (const cluster of clusters) {
    cluster.forEach(article => clusteredIds.add(article.id));
    const representative = chooseClusterRepresentative(cluster);
    const existingRepresentatives = cluster.filter(article => article.duplicateRepresentative);
    const groupUnread = existingRepresentatives.length
      ? existingRepresentatives.some(article => !article.read)
      : cluster.some(article => !article.read && !article.duplicateAutoRead);
    const groupId = representative.duplicateGroupId || `dup-${representative.id}`;

    for (const article of cluster) {
      const isRepresentative = article.id === representative.id;
      const nextRead = isRepresentative ? !groupUnread : true;
      const nextAutoRead = !isRepresentative && groupUnread && (!article.read || article.duplicateAutoRead);
      if (!isRepresentative && !article.read && nextRead) autoRead++;
      updates.push({
        id: article.id,
        patch: {
          duplicateGroupId: groupId,
          duplicateRepresentative: isRepresentative,
          duplicateAutoRead: nextAutoRead,
          read: nextRead
        }
      });
    }
  }

  for (const article of recent) {
    if (!article.duplicateGroupId || clusteredIds.has(article.id)) continue;
    updates.push({
      id: article.id,
      patch: {
        duplicateGroupId: '',
        duplicateRepresentative: false,
        read: article.duplicateAutoRead ? false : article.read,
        duplicateAutoRead: false
      }
    });
  }

  await dbPatchArticles(updates);
  await chrome.storage.local.set({
    dedupeMeta: { version: DEDUPE_VERSION, lastFetchedAt: newestFetchedAt }
  });
  return { groups: clusters.length, autoRead, skipped: false };
}

function buildStoryCards(filteredArticles, allArticles) {
  const groupMembers = new Map();
  for (const article of allArticles) {
    if (!article.duplicateGroupId) continue;
    if (!groupMembers.has(article.duplicateGroupId)) groupMembers.set(article.duplicateGroupId, []);
    groupMembers.get(article.duplicateGroupId).push(article);
  }

  const filteredGroups = new Map();
  for (const article of filteredArticles) {
    const key = article.duplicateGroupId || `single:${article.id}`;
    if (!filteredGroups.has(key)) filteredGroups.set(key, []);
    filteredGroups.get(key).push(article);
  }

  const stories = [];
  const emitted = new Set();
  for (const article of filteredArticles) {
    const key = article.duplicateGroupId || `single:${article.id}`;
    if (emitted.has(key)) continue;
    emitted.add(key);
    const visibleMembers = filteredGroups.get(key) || [article];
    let representative = visibleMembers.find(item => item.duplicateRepresentative) || visibleMembers[0];
    if (!visibleMembers.some(item => item.id === representative.id)) representative = visibleMembers[0];
    const allMembers = article.duplicateGroupId
      ? (groupMembers.get(article.duplicateGroupId) || visibleMembers)
      : [representative];
    stories.push({ ...representative, _duplicateMembers: allMembers });
  }
  return stories;
}

async function setStoryReadState(id, read) {
  const allArticles = await dbGetAllArticles();
  const target = allArticles.find(article => article.id === id);
  if (!target) return;
  const members = target.duplicateGroupId
    ? allArticles.filter(article => article.duplicateGroupId === target.duplicateGroupId)
    : [target];

  if (read) {
    await dbPatchArticles(members.map(article => ({ id: article.id, patch: { read: true, duplicateAutoRead: false } })));
    return;
  }

  const groupId = target.duplicateGroupId || '';
  await dbPatchArticles(members.map(article => ({
    id: article.id,
    patch: {
      read: article.id === id ? false : true,
      ...(groupId ? {
        duplicateRepresentative: article.id === id,
        duplicateAutoRead: article.id !== id
      } : {})
    }
  })));
}

