function updateEmptyState(allArticles, filtered) {
  const title = elements.emptyState.querySelector('h3');
  const text = elements.emptyState.querySelector('p');
  const addButton = elements.emptyState.querySelector('#emptyAddBtn');
  const unreadOnly = currentFilter === 'unread' || elements.sortSelect.value === 'unreadOnly';
  const readOnly = elements.sortSelect.value === 'readOnly';

  if (!allArticles.length) {
    title.textContent = 'まだ記事がありません';
    text.textContent = 'RSS、Google Newsのキーワード、Xアカウントを登録できます。';
    addButton.hidden = false;
    return;
  }

  title.textContent = unreadOnly && !currentSourceId ? '未読記事はありません 🎉'
    : readOnly && !currentSourceId ? '既読記事はありません'
    : '該当する記事はありません';
  text.textContent = unreadOnly && !currentSourceId
    ? 'すべて確認済みです。「すべて」または「新しい順」に切り替えると既読記事も表示できます。'
    : readOnly && !currentSourceId
      ? 'まだ既読にした記事がありません。'
      : '検索条件・フィード・表示方法を変えてみてください。';
  addButton.hidden = true;
}

async function render() {
  const [allArticles, state] = await Promise.all([dbGetAllArticles(), getState()]);
  const { sources, categories, settings, collapsedCategories } = state;
  currentRenderSources = sources;

  if (currentSourceId && !sources.some(source => source.id === currentSourceId)) {
    currentSourceId = '';
    currentFilter = 'all';
  }
  if (currentCategoryId !== null && currentCategoryId !== '' && !categories.some(category => category.id === currentCategoryId)) {
    currentCategoryId = null;
    currentFilter = 'all';
  }

  const sortMode = normalizeSortMode(settings.sortMode);
  if (elements.sortSelect.value !== sortMode) elements.sortSelect.value = sortMode;

  renderCounts(allArticles, sources, categories, collapsedCategories);
  const filtered = getFilteredArticles(allArticles);
  const stories = buildStoryCards(filtered, allArticles);
  elements.articleCount.textContent = stories.length === filtered.length
    ? `${filtered.length.toLocaleString()}件`
    : `${stories.length.toLocaleString()}話題 / ${filtered.length.toLocaleString()}記事`;

  const viewMode = settings.viewMode === 'compact' ? 'compact' : 'card';
  elements.feedList.classList.toggle('compact', viewMode === 'compact');
  elements.viewCardBtn.classList.toggle('active', viewMode === 'card');
  elements.viewCompactBtn.classList.toggle('active', viewMode === 'compact');
  elements.viewCardBtn.setAttribute('aria-pressed', String(viewMode === 'card'));
  elements.viewCompactBtn.setAttribute('aria-pressed', String(viewMode === 'compact'));
  elements.viewTitle.textContent = currentViewTitle(sources, categories);

  if (!filtered.length) {
    if (imageObserver) imageObserver.disconnect();
    elements.feedList.hidden = true;
    elements.loadMoreWrap.hidden = true;
    elements.emptyState.hidden = false;
    updateEmptyState(allArticles, filtered);
    return;
  }

  elements.emptyState.hidden = true;
  elements.feedList.hidden = false;
  const visible = stories.slice(0, renderedLimit);
  renderedArticleMap = new Map(visible.map(article => [article.id, article]));

  elements.feedList.innerHTML = visible.map(article => {
    const articleUrl = article.url ? escapeHtml(article.url) : '';
    const imageUrl = article.imageUrl ? escapeHtml(article.imageUrl) : '';
    const duplicateMembers = (article._duplicateMembers || []).filter(member => member.id !== article.id);
    const duplicateHtml = duplicateMembers.length ? `
      <div class="duplicate-block">
        <button class="duplicate-toggle" type="button" aria-expanded="false">
          <span class="duplicate-toggle-main">
            <span class="duplicate-icon">🔗</span>
            <span class="duplicate-summary">
              <strong>同じ話題が ${duplicateMembers.length + 1}件あります</strong>
              <small>未読記事1件だけを残し、同じ話題の重複記事は自動で既読にしています</small>
            </span>
          </span>
          <span class="duplicate-toggle-side">
            <span class="duplicate-count">${duplicateMembers.length + 1}</span>
            <span class="duplicate-chevron">▾</span>
          </span>
        </button>
        <div class="duplicate-list" hidden>
          <div class="duplicate-list-head">
            <strong>同じ話題の元記事</strong>
            <span>クリックすると各記事を開けます</span>
          </div>
          ${[article, ...duplicateMembers]
            .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
            .map(member => {
              const memberUrl = member.url ? escapeHtml(member.url) : '';
              const isRepresentative = member.id === article.id;
              return `<div class="duplicate-row ${isRepresentative ? 'representative' : ''}">
                <span class="duplicate-status ${isRepresentative ? 'representative' : 'duplicate'}">${isRepresentative ? '未読' : '既読'}</span>
                <span class="duplicate-source">${typeIcon(member.sourceType)} ${escapeHtml(member.sourceName)}</span>
                <span class="duplicate-title">${memberUrl ? `<a class="duplicate-link" data-article-id="${escapeHtml(member.id)}" href="${memberUrl}" target="_blank" rel="noreferrer">${escapeHtml(member.title)} <span aria-hidden="true">↗</span></a>` : escapeHtml(member.title)}</span>
                <span class="duplicate-time">${formatRelativeDate(member.publishedAt)}</span>
              </div>`;
            }).join('')}
        </div>
      </div>` : '';
    return `
      <article class="article-card ${article.read ? 'read' : ''} ${duplicateMembers.length ? 'has-duplicates' : ''}" data-id="${article.id}">
        <div class="unread-dot"></div>
        <div class="article-content ${imageUrl ? 'has-image' : ''}">
          ${imageUrl ? `
            <a class="article-thumb article-link" href="${articleUrl || imageUrl}" target="_blank" rel="noreferrer" tabindex="-1" aria-label="${escapeHtml(article.title)}">
              <img src="${imageUrl}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />
            </a>` : ''}
          <div class="article-main">
            <div class="article-meta">
              <span class="type-badge">${typeLabel(article.sourceType)}</span>
              <span>${escapeHtml(article.sourceName)}</span>
              <span>•</span>
              <span title="${new Date(article.publishedAt).toLocaleString('ja-JP')}">${formatRelativeDate(article.publishedAt)}</span>
              ${duplicateMembers.length ? `<span class="duplicate-badge">🔗 同じ話題 ${duplicateMembers.length + 1}件</span>` : ''}
            </div>
            <h3 class="article-title">
              ${articleUrl ? `<a class="article-link" href="${articleUrl}" target="_blank" rel="noreferrer">${escapeHtml(article.title)}</a>` : escapeHtml(article.title)}
            </h3>
            ${article.description ? `<p class="article-desc">${escapeHtml(article.description)}</p>` : ''}
            ${duplicateHtml}
          </div>
        </div>
        <div class="article-actions">
          <button class="icon-action favorite-btn ${article.favorite ? 'active' : ''}" title="お気に入り">⭐</button>
          <button class="icon-action read-btn" title="${article.read ? '未読に戻す' : '既読にする'}">${article.read ? '↩' : '✓'}</button>
        </div>
      </article>`;
  }).join('');

  elements.loadMoreWrap.hidden = visible.length >= stories.length;
  attachArticleEvents();
  setupLazyImageEnrichment(visible, viewMode);
}

function bindThumbError(image, articleId) {
  image.addEventListener('error', async () => {
    const thumb = image.closest('.article-thumb');
    const content = image.closest('.article-content');
    if (thumb) thumb.remove();
    if (content) content.classList.remove('has-image');
    await dbPatchArticle(articleId, { imageUrl: '', imageCheckedAt: new Date().toISOString() });
  }, { once: true });
}

function attachArticleEvents() {
  $$('.article-card').forEach(card => {
    const id = card.dataset.id;

    card.querySelector('.favorite-btn').addEventListener('click', async (event) => {
      event.stopPropagation();
      const article = renderedArticleMap.get(id);
      if (article) {
        const nextFavorite = !article.favorite;
        await dbPatchArticle(id, { favorite: nextFavorite });
        if (!nextFavorite) await cleanupExpiredArticles();
      }
      await render();
    });

    card.querySelector('.read-btn').addEventListener('click', async (event) => {
      event.stopPropagation();
      const article = renderedArticleMap.get(id);
      if (article) await setStoryReadState(id, !article.read);
      await render();
    });

    card.querySelectorAll('.article-link').forEach(link => {
      link.addEventListener('click', async () => {
        await setStoryReadState(id, true);
        setTimeout(render, 150);
      });
    });

    const duplicateToggle = card.querySelector('.duplicate-toggle');
    if (duplicateToggle) {
      duplicateToggle.addEventListener('click', event => {
        event.stopPropagation();
        const list = card.querySelector('.duplicate-list');
        const open = list?.hidden !== false;
        if (list) list.hidden = !open;
        duplicateToggle.setAttribute('aria-expanded', String(open));
        duplicateToggle.querySelector('.duplicate-chevron').textContent = open ? '▴' : '▾';
      });
    }

    card.querySelectorAll('.duplicate-link').forEach(link => {
      link.addEventListener('click', async () => {
        await setStoryReadState(link.dataset.articleId || id, true);
        setTimeout(render, 150);
      });
    });

    const image = card.querySelector('.article-thumb img');
    if (image) bindThumbError(image, id);
  });
}

function shouldEnrichImage(article) {
  if (!article || article.imageUrl || !article.url) return false;
  if (!resolveHttpUrl(article.url)) return false;
  if (!article.imageCheckedAt) return true;
  const checkedAt = new Date(article.imageCheckedAt).getTime();
  return Number.isNaN(checkedAt) || Date.now() - checkedAt > IMAGE_RETRY_MS;
}

async function fetchHtmlPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
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

function getImageAttr(image, baseUrl) {
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

function looksLikeDecorativeImage(url, image) {
  const haystack = `${url} ${image.getAttribute('class') || ''} ${image.getAttribute('id') || ''} ${image.getAttribute('alt') || ''}`.toLowerCase();
  if (/logo|icon|avatar|sprite|emoji|tracking|pixel|spacer|badge|advert|(^|[-_])ad([-_]|$)/i.test(haystack)) return true;

  const width = Number.parseInt(image.getAttribute('width') || '0', 10);
  const height = Number.parseInt(image.getAttribute('height') || '0', 10);
  if (width && height && (width < 180 || height < 90)) return true;
  return false;
}

function extractImageFromPage(html, baseUrl) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const metaSelectors = [
    'meta[property="og:image:secure_url"]',
    'meta[property="og:image"]',
    'meta[property="og:image:url"]',
    'meta[name="twitter:image"]',
    'meta[name="twitter:image:src"]',
    'link[rel="image_src"]'
  ];

  for (const selector of metaSelectors) {
    const node = doc.querySelector(selector);
    const raw = node?.getAttribute('content') || node?.getAttribute('href');
    const resolved = resolveHttpUrl(raw, baseUrl);
    if (resolved) return { imageUrl: resolved, doc };
  }

  // Google Newsの中継ページではロゴ等を拾いやすいので、OG画像が無い場合のimg探索は行わない。
  let hostname = '';
  try { hostname = new URL(baseUrl).hostname; } catch { /* noop */ }
  if (hostname === 'news.google.com') return { imageUrl: '', doc };

  const imageCandidates = [
    ...Array.from(doc.querySelectorAll('article img')),
    ...Array.from(doc.querySelectorAll('main img')),
    ...Array.from(doc.querySelectorAll('img'))
  ];
  const seen = new Set();

  for (const image of imageCandidates) {
    if (seen.has(image)) continue;
    seen.add(image);
    const url = getImageAttr(image, baseUrl);
    if (!url || looksLikeDecorativeImage(url, image)) continue;
    return { imageUrl: url, doc };
  }

  return { imageUrl: '', doc };
}

function googleExternalArticleCandidate(doc, baseUrl) {
  let baseHost = '';
  try { baseHost = new URL(baseUrl).hostname; } catch { return ''; }
  if (baseHost !== 'news.google.com') return '';

  const rejectedHosts = ['google.com', 'www.google.com', 'news.google.com', 'accounts.google.com', 'support.google.com', 'policies.google.com', 'gstatic.com', 'googleusercontent.com'];
  const anchors = [
    ...Array.from(doc.querySelectorAll('article a[href]')),
    ...Array.from(doc.querySelectorAll('main a[href]'))
  ];

  for (const anchor of anchors) {
    const href = resolveHttpUrl(anchor.getAttribute('href'), baseUrl);
    if (!href) continue;
    try {
      const host = new URL(href).hostname;
      if (rejectedHosts.some(rejected => host === rejected || host.endsWith(`.${rejected}`))) continue;
      if ((anchor.textContent || '').trim().length < 4) continue;
      return href;
    } catch {
      // 次候補へ
    }
  }
  return '';
}

async function fetchPreviewImage(article) {
  const first = await fetchHtmlPage(article.url);
  if (!first) return '';

  const firstResult = extractImageFromPage(first.html, first.finalUrl);
  if (firstResult.imageUrl) return firstResult.imageUrl;

  if (article.sourceType === 'google' || (() => {
    try { return new URL(first.finalUrl).hostname === 'news.google.com'; } catch { return false; }
  })()) {
    const externalUrl = googleExternalArticleCandidate(firstResult.doc, first.finalUrl);
    if (externalUrl) {
      try {
        const second = await fetchHtmlPage(externalUrl);
        if (second) return extractImageFromPage(second.html, second.finalUrl).imageUrl;
      } catch (error) {
        console.debug('Google News image fallback failed', error);
      }
    }
  }

  return '';
}

function insertImageIntoCard(article, imageUrl) {
  const card = document.querySelector(`.article-card[data-id="${CSS.escape(article.id)}"]`);
  if (!card) return;
  const content = card.querySelector('.article-content');
  if (!content || content.querySelector('.article-thumb')) return;

  const thumb = document.createElement('a');
  thumb.className = 'article-thumb article-link';
  thumb.href = article.url || imageUrl;
  thumb.target = '_blank';
  thumb.rel = 'noreferrer';
  thumb.tabIndex = -1;
  thumb.setAttribute('aria-label', article.title || '記事画像');

  const image = document.createElement('img');
  image.src = imageUrl;
  image.alt = '';
  image.loading = 'lazy';
  image.decoding = 'async';
  image.referrerPolicy = 'no-referrer';
  bindThumbError(image, article.id);

  thumb.addEventListener('click', async () => {
    await dbPatchArticle(article.id, { read: true });
    setTimeout(render, 150);
  });

  thumb.appendChild(image);
  content.prepend(thumb);
  content.classList.add('has-image');
}

function enqueueImageEnrichment(article) {
  if (!shouldEnrichImage(article) || imageEnrichQueued.has(article.id)) return;
  imageEnrichQueued.add(article.id);
  imageEnrichQueue.push(article);
  pumpImageEnrichmentQueue();
}

function pumpImageEnrichmentQueue() {
  while (imageEnrichActive < IMAGE_ENRICH_CONCURRENCY && imageEnrichQueue.length) {
    const article = imageEnrichQueue.shift();
    imageEnrichActive++;

    (async () => {
      let imageUrl = '';
      try {
        imageUrl = await fetchPreviewImage(article);
      } catch (error) {
        console.debug('画像補完をスキップ:', article.title, error);
      }

      const checkedAt = new Date().toISOString();
      await dbPatchArticle(article.id, { imageUrl: imageUrl || '', imageCheckedAt: checkedAt });

      if (imageUrl) {
        const updated = { ...article, imageUrl, imageCheckedAt: checkedAt };
        renderedArticleMap.set(article.id, updated);
        insertImageIntoCard(updated, imageUrl);
      }
    })().finally(() => {
      imageEnrichActive--;
      imageEnrichQueued.delete(article.id);
      pumpImageEnrichmentQueue();
    });
  }
}

function setupLazyImageEnrichment(visible, viewMode) {
  if (imageObserver) imageObserver.disconnect();
  if (viewMode !== 'card') return;

  const candidates = visible.filter(shouldEnrichImage);
  if (!candidates.length) return;

  const articleById = new Map(candidates.map(article => [article.id, article]));

  if (!('IntersectionObserver' in window)) {
    candidates.slice(0, 12).forEach(enqueueImageEnrichment);
    return;
  }

  imageObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      imageObserver.unobserve(entry.target);
      const article = articleById.get(entry.target.dataset.id);
      if (article) enqueueImageEnrichment(article);
    }
  }, { rootMargin: '500px 0px' });

  for (const article of candidates) {
    const card = document.querySelector(`.article-card[data-id="${CSS.escape(article.id)}"]`);
    if (card) imageObserver.observe(card);
  }
}

function renderCategoryOptions(categories, selected = '') {
  const options = ['<option value="">未分類</option>', ...orderedCategories(categories).map(category =>
    `<option value="${escapeHtml(category.id)}" ${category.id === selected ? 'selected' : ''}>${escapeHtml(category.name)}</option>`
  )];
  elements.sourceCategory.innerHTML = options.join('');
}

async function renderSources() {
  const { sources, categories } = await getState();
  renderCategoryOptions(categories, elements.sourceCategory.value || '');
  const categoryMap = new Map(categories.map(category => [category.id, category.name]));
  elements.sourceCount.textContent = `${sources.length}件`;
  if (!sources.length) {
    elements.sourceList.innerHTML = '<small>まだ登録されていません。</small>';
    return;
  }

  elements.sourceList.innerHTML = orderedSources(sources).map(source => `
    <div class="source-row" data-id="${source.id}">
      <div class="source-type">${typeLabel(source.type)}</div>
      <div>
        <strong>${escapeHtml(source.name)}<span class="source-category-label">${escapeHtml(categoryMap.get(categoryKey(source)) || '未分類')}</span></strong>
        <small>${escapeHtml(source.value)}</small>
      </div>
      <button class="source-delete" type="button">削除</button>
    </div>
  `).join('');

  $$('.source-delete').forEach(button => button.addEventListener('click', async () => {
    const id = button.closest('.source-row').dataset.id;
    const { sources } = await getState();
    await saveSources(sources.filter(source => source.id !== id));
    if (currentSourceId === id) {
      currentSourceId = '';
      currentFilter = 'all';
    }
    await renderSources();
    await render();
    showToast('フィードを削除しました。');
  }));
}
