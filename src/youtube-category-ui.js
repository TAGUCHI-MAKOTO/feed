// v0.1.24: YouTube channel URLs + dedicated category dialog
function v024IsYouTubeChannelUrl(rawValue = '') {
  try {
    const url = new URL(String(rawValue || '').trim());
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (!['youtube.com', 'm.youtube.com'].includes(host)) return false;
    const path = decodeURIComponent(url.pathname || '');
    return /^\/@[^/]+\/?$/i.test(path)
      || /^\/channel\/UC[A-Za-z0-9_-]{20,30}\/?$/i.test(path)
      || /^\/(?:user|c)\/[^/]+\/?$/i.test(path);
  } catch {
    return false;
  }
}

function v024DirectYouTubeChannelId(urlValue = '') {
  try {
    const path = new URL(urlValue).pathname;
    const match = path.match(/^\/channel\/(UC[A-Za-z0-9_-]{20,30})(?:\/|$)/i);
    return match?.[1] || '';
  } catch {
    return '';
  }
}

function v024ExtractYouTubeChannelId(html = '', pageUrl = '') {
  const direct = v024DirectYouTubeChannelId(pageUrl);
  if (direct) return direct;

  const patterns = [
    /feeds\/videos\.xml\?channel_id=(UC[A-Za-z0-9_-]{20,30})/i,
    /["']externalId["']\s*:\s*["'](UC[A-Za-z0-9_-]{20,30})["']/i,
    /itemprop=["']channelId["'][^>]*content=["'](UC[A-Za-z0-9_-]{20,30})["']/i,
    /content=["'](UC[A-Za-z0-9_-]{20,30})["'][^>]*itemprop=["']channelId["']/i,
    /itemprop=["']identifier["'][^>]*content=["'](UC[A-Za-z0-9_-]{20,30})["']/i,
    /["']channelId["']\s*:\s*["'](UC[A-Za-z0-9_-]{20,30})["']/i,
    /["']browseId["']\s*:\s*["'](UC[A-Za-z0-9_-]{20,30})["']/i,
    /\/channel\/(UC[A-Za-z0-9_-]{20,30})(?:[/?"'\\]|$)/i
  ];

  for (const pattern of patterns) {
    const match = String(html || '').match(pattern);
    if (match?.[1]) return match[1];
  }
  return '';
}

function v024YouTubePageTitle(html = '') {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const values = [
      doc.querySelector('meta[property="og:title"]')?.getAttribute('content'),
      doc.querySelector('meta[name="title"]')?.getAttribute('content'),
      doc.querySelector('title')?.textContent
    ];
    for (const value of values) {
      const cleaned = String(value || '').replace(/\s+-\s+YouTube\s*$/i, '').trim();
      if (cleaned) return cleaned;
    }
  } catch { /* noop */ }
  return '';
}

async function v024PrepareYouTubeSource(rawValue, categoryId = '') {
  const channelUrl = String(rawValue || '').trim();
  let channelId = v024DirectYouTubeChannelId(channelUrl);
  let pageTitle = '';

  if (!channelId) {
    let page = null;
    try {
      page = await fetchHtmlPage(channelUrl);
    } catch (error) {
      throw new Error(`YouTubeチャンネルページを取得できませんでした：${error.message || error}`);
    }
    if (!page) throw new Error('YouTubeチャンネルページを取得できませんでした。');
    channelId = v024ExtractYouTubeChannelId(page.html, page.finalUrl || channelUrl);
    pageTitle = v024YouTubePageTitle(page.html);
  }

  if (!channelId) {
    throw new Error('YouTubeのチャンネルIDを取得できませんでした。チャンネルURLを確認してください。');
  }

  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
  let meta = null;
  try {
    meta = await fetchFeedMeta(feedUrl);
  } catch (error) {
    throw new Error(`YouTubeフィードを取得できませんでした：${error.message || error}`);
  }
  if (!looksLikeFeedDocument(meta.text)) {
    throw new Error('YouTubeフィードをAtomとして認識できませんでした。');
  }

  return {
    id: uid(),
    type: 'rss',
    name: feedDocumentTitle(meta.text) || pageTitle || 'YouTube',
    value: feedUrl,
    categoryId,
    siteUrl: channelUrl,
    youtubeChannelId: channelId,
    youtubeChannelUrl: channelUrl,
    feedFailCount: 0,
    feedHealthStatus: 'ok',
    feedLastError: '',
    feedLastSuccessAt: new Date().toISOString()
  };
}

const v024BasePrepareAutoSource = prepareAutoSource;
prepareAutoSource = async function(rawValue, categoryId = '') {
  if (v024IsYouTubeChannelUrl(rawValue)) {
    return v024PrepareYouTubeSource(rawValue, categoryId);
  }
  return v024BasePrepareAutoSource(rawValue, categoryId);
};

function v024UpdateDetectionHint() {
  const hint = document.getElementById('sourceDetectHint');
  if (!hint || !v024IsYouTubeChannelUrl(elements.sourceValue.value)) return;
  hint.textContent = '自動判定：YouTube チャンネル';
}

elements.sourceValue.addEventListener('input', v024UpdateDetectionHint);
setTimeout(v024UpdateDetectionHint, 0);

const v024CategoriesDialog = document.getElementById('categoriesDialog');
const v024OpenCategoriesBtn = document.getElementById('openCategoriesBtn');
const v024CloseCategoriesBtn = document.getElementById('closeCategoriesBtn');
const v024DoneCategoriesBtn = document.getElementById('doneCategoriesBtn');

if (v024OpenCategoriesBtn && v024CategoriesDialog) {
  v024OpenCategoriesBtn.addEventListener('click', async event => {
    event.preventDefault();
    event.stopImmediatePropagation();
    const { categories } = await getState();
    renderCategoryManager(categories);
    v024CategoriesDialog.showModal();
    setTimeout(() => elements.categoryNameInput?.focus(), 30);
  }, true);
}

v024CloseCategoriesBtn?.addEventListener('click', () => v024CategoriesDialog?.close());
v024DoneCategoriesBtn?.addEventListener('click', () => v024CategoriesDialog?.close());

document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || !v024CategoriesDialog?.open) return;
  event.preventDefault();
  v024CategoriesDialog.close();
});

async function v024MigrateExistingYouTubeSources() {
  try {
    const { sources } = await getState();
    let changed = false;
    const nextSources = [];

    for (const source of sources) {
      if (source.type !== 'rss' || !v024IsYouTubeChannelUrl(source.value)) {
        nextSources.push(source);
        continue;
      }

      try {
        const converted = await v024PrepareYouTubeSource(source.value, source.categoryId || '');
        nextSources.push({
          ...source,
          ...converted,
          id: source.id,
          name: source.name || converted.name,
          order: source.order,
          categoryId: source.categoryId || ''
        });
        changed = true;
      } catch (error) {
        console.debug('既存YouTubeフィードの変換をスキップ:', source.name, error);
        nextSources.push(source);
      }
    }

    if (changed) {
      await saveSources(nextSources);
      await render();
      if (elements.sourcesDialog?.open) await renderSources();
    }
  } catch (error) {
    console.debug('YouTubeフィード移行をスキップ:', error);
  }
}

window.addEventListener('load', () => {
  setTimeout(v024MigrateExistingYouTubeSources, 300);
}, { once: true });

function v025FolderSvg(open = false, small = false) {
  const stateClass = open ? 'open' : 'closed';
  const sizeClass = small ? 'small' : '';
  return `
    <span class="folder-glyph ${stateClass} ${sizeClass}" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" focusable="false">
        <path class="folder-tab" d="M3.8 7.85c0-1.35 1.1-2.45 2.45-2.45h4.35c.56 0 1.1.2 1.54.56l1.12.92c.24.2.55.31.86.31h3.55c1.26 0 2.28 1.02 2.28 2.28v.9H3.8v-2.52Z"/>
        <path class="folder-back" d="M3.55 10.05c0-.7.56-1.26 1.26-1.26h14.34c1.23 0 2.13 1.16 1.82 2.35l-1.43 5.48a2.28 2.28 0 0 1-2.2 1.7H6.66a2.28 2.28 0 0 1-2.2-1.7L3.63 12.3a2.77 2.77 0 0 1-.08-.68v-1.57Z"/>
        <path class="folder-front" d="M4.35 10.95h15.25c1.02 0 1.8.94 1.58 1.94l-1.08 5.02a1.95 1.95 0 0 1-1.9 1.54H5.8a1.95 1.95 0 0 1-1.9-1.54L2.82 12.9a1.62 1.62 0 0 1 1.53-1.95Z"/>
        <path class="folder-rim" d="M4.7 11.12h14.52"/>
        <path class="folder-shine" d="M6.85 13.25h4.65"/>
      </svg>
    </span>`;
}

function v025ApplyFolderChrome() {
  const nav = elements.sourceNav;
  if (!nav) return;

  nav.querySelector('.drag-hint')?.remove();

  const uncategorizedSection = nav.querySelector('.custom-category[data-category-id=""]');
  const firstCategory = nav.querySelector('.custom-category');
  if (uncategorizedSection && firstCategory && uncategorizedSection !== firstCategory) {
    nav.insertBefore(uncategorizedSection, firstCategory);
  }
  if (uncategorizedSection) {
    uncategorizedSection.classList.add('category-pinned-top');
    uncategorizedSection.querySelector('.category-header')?.classList.add('is-uncategorized');
    uncategorizedSection.querySelector('.category-drag-handle')?.remove();
    uncategorizedSection.querySelector('.category-drag-spacer')?.classList.add('hidden-spacer');
  }

  nav.querySelectorAll('.category-select-btn .category-folder').forEach(node => {
    const section = node.closest('.custom-category');
    const isOpen = !section?.classList.contains('collapsed');
    node.innerHTML = v025FolderSvg(isOpen);
  });

  nav.querySelectorAll('.favorite-folder-item .favorite-folder-icon').forEach(node => {
    if (node.textContent.includes('★')) return;
    node.innerHTML = v025FolderSvg(false, true);
  });
}

const v025BaseRenderSourceNavigation = renderSourceNavigation;
renderSourceNavigation = function(...args) {
  v025BaseRenderSourceNavigation(...args);
  v025ApplyFolderChrome();
};

const v025BaseRenderCategoryManager = renderCategoryManager;
renderCategoryManager = function(...args) {
  v025BaseRenderCategoryManager(...args);
  document.querySelectorAll('.category-manager-row .folder').forEach(node => {
    node.innerHTML = v025FolderSvg(false, true);
  });
};

function v027RestoreOriginalFolderIcons() {
  if (!elements.sourceNav) return;

  elements.sourceNav.querySelectorAll('.custom-category').forEach(section => {
    const icon = section.querySelector('.category-select-btn .category-folder');
    if (!icon) return;
    icon.textContent = section.classList.contains('collapsed') ? '📁' : '📂';
  });

  elements.sourceNav.querySelectorAll('.favorite-folder-item .favorite-folder-icon').forEach(icon => {
    if (icon.textContent.includes('★')) return;
    icon.textContent = '📁';
  });

  elements.sourceNav.querySelector('.drag-hint')?.remove();
}

const v027BaseRenderSourceNavigation = renderSourceNavigation;
renderSourceNavigation = function(...args) {
  v027BaseRenderSourceNavigation(...args);
  v027RestoreOriginalFolderIcons();
};

const v027BaseRenderCategoryManager = renderCategoryManager;
renderCategoryManager = function(...args) {
  v027BaseRenderCategoryManager(...args);
  document.querySelectorAll('.category-manager-row .folder').forEach(icon => {
    icon.textContent = '📁';
  });
};
