// v0.1.24: YouTube channel URLs + dedicated category manager
// ----------------------------------------------------------

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
    name: v016FeedTitle(meta.text) || pageTitle || 'YouTube',
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

const v024BasePrepareSource = v016PrepareSource;
v016PrepareSource = async function(rawValue, categoryId = '') {
  if (v024IsYouTubeChannelUrl(rawValue)) {
    return v024PrepareYouTubeSource(rawValue, categoryId);
  }
  return v024BasePrepareSource(rawValue, categoryId);
};

function v024UpdateDetectionHint() {
  const hint = document.getElementById('sourceDetectHint');
  if (!hint || !v024IsYouTubeChannelUrl(elements.sourceValue.value)) return;
  hint.textContent = '自動判定：YouTube チャンネル';
}

elements.sourceValue.addEventListener('input', v024UpdateDetectionHint);
setTimeout(v024UpdateDetectionHint, 0);

// Split category management away from Settings without duplicating controls.
(function v024InstallDedicatedCategoryDialog() {
  const categorySection = document.querySelector('#settingsDialog .category-settings');
  const openButton = document.getElementById('openCategoriesBtn');
  if (!categorySection || !openButton || document.getElementById('categoriesDialog')) return;

  const dialog = document.createElement('dialog');
  dialog.id = 'categoriesDialog';
  dialog.className = 'modal small';

  const card = document.createElement('div');
  card.className = 'modal-card';
  card.innerHTML = `
    <div class="modal-header">
      <div>
        <h3>カテゴリを管理</h3>
        <p>左カラムのフォルダを追加・変更・削除します。</p>
      </div>
      <button id="closeCategoriesBtn" type="button" class="icon-btn" aria-label="閉じる">×</button>
    </div>`;

  categorySection.classList.add('standalone-category-settings');
  card.appendChild(categorySection);

  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  actions.innerHTML = '<button id="doneCategoriesBtn" type="button" class="primary-btn">閉じる</button>';
  card.appendChild(actions);
  dialog.appendChild(card);
  document.body.appendChild(dialog);

  const style = document.createElement('style');
  style.id = 'v024CategoryStyles';
  style.textContent = `
    #categoriesDialog .modal-card { width:min(620px, calc(100vw - 40px)); }
    #categoriesDialog .standalone-category-settings { margin-top:2px; }
    #categoriesDialog .category-manager-list { max-height:min(52vh, 480px); overflow-y:auto; }
    #categoriesDialog .modal-actions { justify-content:flex-end; }
  `;
  document.head.appendChild(style);

  openButton.addEventListener('click', async event => {
    event.preventDefault();
    event.stopImmediatePropagation();
    const { categories } = await getState();
    renderCategoryManager(categories);
    dialog.showModal();
    setTimeout(() => elements.categoryNameInput?.focus(), 30);
  }, true);

  document.getElementById('closeCategoriesBtn')?.addEventListener('click', () => dialog.close());
  document.getElementById('doneCategoriesBtn')?.addEventListener('click', () => dialog.close());

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !dialog.open) return;
    event.preventDefault();
    dialog.close();
  });
})();
