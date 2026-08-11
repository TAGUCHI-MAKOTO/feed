// v0.1.13: folder drag-and-drop fix
// Folder IDs live on .custom-category, not .category-header.
let v013CategoryDragId = '';

function v013CategoryRowFrom(target) {
  const header = target?.closest?.('.category-header[draggable="true"]');
  const row = header?.closest('.custom-category');
  return { header, row, id: row?.dataset.categoryId || '' };
}

function v013ClearCategoryDragMarkers() {
  document.querySelectorAll('.drop-before, .drop-after, .category-moving').forEach(node => {
    node.classList.remove('drop-before', 'drop-after', 'category-moving');
  });
}

// Keep the drag handle itself explicitly draggable after every navigation render.
const v013BaseRenderSourceNavigation = renderSourceNavigation;
renderSourceNavigation = function(...args) {
  v013BaseRenderSourceNavigation(...args);
  document.querySelectorAll('.category-drag-handle').forEach(handle => {
    handle.draggable = true;
  });
};

elements.sourceNav.addEventListener('dragstart', event => {
  const source = event.target.closest('.draggable-source');
  if (source) return; // leave feed dragging to the existing handler

  const { header, row, id } = v013CategoryRowFrom(event.target);
  if (!header || !row || !id) return;

  event.stopImmediatePropagation();
  v013CategoryDragId = id;
  row.classList.add('category-moving');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', `category:${id}`);
}, true);

elements.sourceNav.addEventListener('dragover', event => {
  if (!v013CategoryDragId) return;

  const { header, row, id } = v013CategoryRowFrom(event.target);
  if (!header || !row || !id || id === v013CategoryDragId) return;

  event.preventDefault();
  event.stopImmediatePropagation();
  event.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.custom-category.drop-before, .custom-category.drop-after').forEach(node => {
    node.classList.remove('drop-before', 'drop-after');
  });
  row.classList.add(v012DropPosition(header, event.clientY) === 'after' ? 'drop-after' : 'drop-before');
}, true);

elements.sourceNav.addEventListener('drop', async event => {
  if (!v013CategoryDragId) return;

  event.preventDefault();
  event.stopImmediatePropagation();
  const { header, id } = v013CategoryRowFrom(event.target);

  if (header && id && id !== v013CategoryDragId) {
    await v012MoveCategoryRelative(v013CategoryDragId, id, v012DropPosition(header, event.clientY));
  } else if (!header) {
    await v012MoveCategoryRelative(v013CategoryDragId, '', 'after');
  }

  v013CategoryDragId = '';
  v013ClearCategoryDragMarkers();
}, true);

elements.sourceNav.addEventListener('dragend', event => {
  if (!v013CategoryDragId) return;
  event.stopImmediatePropagation();
  v013CategoryDragId = '';
  v013ClearCategoryDragMarkers();
}, true);

// --------------------------------------------------
// v0.1.14: resizable sidebar + feed/site favicons
// --------------------------------------------------
const V014_SIDEBAR_DEFAULT = 290;
const V014_SIDEBAR_MIN = 230;
const V014_SIDEBAR_MAX = 460;

function v014ClampSidebarWidth(value) {
  const width = Number(value) || V014_SIDEBAR_DEFAULT;
  return Math.max(V014_SIDEBAR_MIN, Math.min(V014_SIDEBAR_MAX, width));
}

function v014ApplySidebarWidth(value) {
  const width = v014ClampSidebarWidth(value);
  document.documentElement.style.setProperty('--sidebar-width', `${width}px`);
  return width;
}

async function v014SaveSidebarWidth(width) {
  const { settings } = await getState();
  await saveSettings({ ...settings, sidebarWidth: v014ClampSidebarWidth(width) });
}

function v014InstallSidebarResizer() {
  const sidebar = document.querySelector('.sidebar');
  if (!sidebar || document.getElementById('sidebarResizer')) return;

  const resizer = document.createElement('div');
  resizer.id = 'sidebarResizer';
  resizer.className = 'sidebar-resizer';
  resizer.setAttribute('role', 'separator');
  resizer.setAttribute('aria-orientation', 'vertical');
  resizer.setAttribute('aria-label', '左カラムの幅を変更');
  resizer.title = 'ドラッグで左カラム幅を変更 / ダブルクリックで標準幅';
  sidebar.appendChild(resizer);

  let currentWidth = V014_SIDEBAR_DEFAULT;
  let pointerId = null;
  let active = false;

  getState().then(({ settings }) => {
    currentWidth = v014ApplySidebarWidth(settings?.sidebarWidth ?? V014_SIDEBAR_DEFAULT);
  });

  const finish = async () => {
    if (!active) return;
    active = false;
    document.body.classList.remove('sidebar-resizing');
    try { if (pointerId !== null) resizer.releasePointerCapture(pointerId); } catch { /* noop */ }
    pointerId = null;
    await v014SaveSidebarWidth(currentWidth);
  };

  resizer.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    active = true;
    pointerId = event.pointerId;
    document.body.classList.add('sidebar-resizing');
    resizer.setPointerCapture(pointerId);
  });

  resizer.addEventListener('pointermove', event => {
    if (!active || event.pointerId !== pointerId) return;
    currentWidth = v014ApplySidebarWidth(event.clientX);
  });
  resizer.addEventListener('pointerup', finish);
  resizer.addEventListener('pointercancel', finish);
  resizer.addEventListener('dblclick', async () => {
    currentWidth = v014ApplySidebarWidth(V014_SIDEBAR_DEFAULT);
    await v014SaveSidebarWidth(currentWidth);
    showToast('左カラム幅を標準に戻しました。');
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes.settings?.newValue) return;
    const width = changes.settings.newValue.sidebarWidth;
    if (width != null && !active) currentWidth = v014ApplySidebarWidth(width);
  });
}

function v014SourceFaviconUrl(source, allArticles = []) {
  if (!source) return '';
  try {
    if (source.type === 'google') return 'https://news.google.com/favicon.ico';
    if (source.type === 'x') return 'https://x.com/favicon.ico';

    const article = allArticles
      .filter(item => item.sourceId === source.id && item.url)
      .sort((a, b) => new Date(b.publishedAt || 0).getTime() - new Date(a.publishedAt || 0).getTime())
      .find(item => {
        try {
          const host = new URL(item.url).hostname.toLowerCase();
          return host && host !== 'news.google.com' && !host.includes('nitter.');
        } catch { return false; }
      });

    const candidate = article?.url || (source.type === 'rss' ? source.value : '');
    if (!candidate) return '';
    return `${new URL(candidate).origin}/favicon.ico`;
  } catch {
    return '';
  }
}

function v014FeedIconMarkup(source, allArticles = []) {
  const fallback = typeIcon(source.type);
  const favicon = v014SourceFaviconUrl(source, allArticles);
  if (!favicon) return `<span class="source-fallback-icon">${fallback}</span>`;
  return `<span class="source-icon-wrap">
    <img class="source-favicon" src="${escapeHtml(favicon)}" alt="" loading="lazy" decoding="async">
    <span class="source-fallback-icon">${fallback}</span>
  </span>`;
}

function v014BindFaviconFallbacks(root = document) {
  root.querySelectorAll('.source-favicon').forEach(image => {
    if (image.dataset.v014Bound === 'true') return;
    image.dataset.v014Bound = 'true';
    const wrap = image.closest('.source-icon-wrap');
    image.addEventListener('load', () => wrap?.classList.add('loaded'), { once: true });
    image.addEventListener('error', () => wrap?.classList.add('failed'), { once: true });
    if (image.complete) {
      if (image.naturalWidth > 0) wrap?.classList.add('loaded');
      else wrap?.classList.add('failed');
    }
  });
}

function v014DecorateSourceNavigation(sources, allArticles) {
  document.querySelectorAll('.source-item[data-source-id]').forEach(row => {
    const source = sources.find(item => item.id === row.dataset.sourceId);
    const holder = row.querySelector('.source-kind-icon');
    if (!source || !holder) return;
    holder.innerHTML = v014FeedIconMarkup(source, allArticles);
  });
  v014BindFaviconFallbacks(elements.sourceNav);
}

const v014BaseRenderSourceNavigation = renderSourceNavigation;
renderSourceNavigation = function(sources, categories, allArticles, collapsedCategories = {}) {
  v014BaseRenderSourceNavigation(sources, categories, allArticles, collapsedCategories);
  v014DecorateSourceNavigation(sources, allArticles);
};

const v014BaseRenderSources = renderSources;
renderSources = async function(...args) {
  await v014BaseRenderSources(...args);
  const { sources } = await getState();
  document.querySelectorAll('.source-row[data-id]').forEach(row => {
    const source = sources.find(item => item.id === row.dataset.id);
    const holder = row.querySelector('.source-type');
    if (!source || !holder) return;
    holder.classList.add('source-manager-icon');
    holder.innerHTML = v014FeedIconMarkup(source, []);
  });
  v014BindFaviconFallbacks(elements.sourceList);
};

v014InstallSidebarResizer();
