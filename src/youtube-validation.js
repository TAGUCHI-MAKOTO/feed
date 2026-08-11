// v0.1.29: strict YouTube channel IDs + transient retry + old-source repair
const V029_YOUTUBE_CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;

function v029IsValidYouTubeChannelId(value = '') {
  return V029_YOUTUBE_CHANNEL_ID_RE.test(String(value || '').trim());
}

function v029YouTubeFeedChannelId(value = '') {
  try {
    const url = new URL(String(value || '').trim());
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (!['youtube.com', 'm.youtube.com'].includes(host)) return '';
    if (url.pathname !== '/feeds/videos.xml') return '';
    return url.searchParams.get('channel_id') || '';
  } catch {
    return '';
  }
}

function v029IsYouTubeFeedUrl(value = '') {
  return Boolean(v029YouTubeFeedChannelId(value));
}

function v029Sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const v029BaseFetchFeedMeta = fetchFeedMeta;
fetchFeedMeta = async function(url) {
  if (!v029IsYouTubeFeedUrl(url)) {
    return v029BaseFetchFeedMeta(url);
  }

  const waits = [0, 650, 1500];
  let lastError = null;

  for (let attempt = 0; attempt < waits.length; attempt++) {
    if (waits[attempt]) await v029Sleep(waits[attempt]);

    try {
      return await v029BaseFetchFeedMeta(url);
    } catch (error) {
      lastError = error;
      const status = Number(error?.status || 0);
      const transient =
        [429, 500, 502, 503, 504].includes(status)
        || error?.name === 'AbortError'
        || status === 0;

      if (!transient || attempt === waits.length - 1) throw error;
      console.debug(`YouTubeフィード再試行 ${attempt + 1}/${waits.length - 1}:`, url, error);
    }
  }

  throw lastError || new Error('YouTubeフィードを取得できませんでした');
};

v024IsYouTubeChannelUrl = function(rawValue = '') {
  try {
    const url = new URL(String(rawValue || '').trim());
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (!['youtube.com', 'm.youtube.com'].includes(host)) return false;
    const path = decodeURIComponent(url.pathname || '');
    return /^\/@[^/]+\/?$/i.test(path)
      || /^\/channel\/UC[A-Za-z0-9_-]{22}\/?$/i.test(path)
      || /^\/(?:user|c)\/[^/]+\/?$/i.test(path);
  } catch {
    return false;
  }
};

v024DirectYouTubeChannelId = function(urlValue = '') {
  try {
    const path = new URL(urlValue).pathname;
    const match = path.match(/^\/channel\/(UC[A-Za-z0-9_-]{22})(?:\/|$)/i);
    return match?.[1] || '';
  } catch {
    return '';
  }
};

v024ExtractYouTubeChannelId = function(html = '', pageUrl = '') {
  const direct = v024DirectYouTubeChannelId(pageUrl);
  if (direct) return direct;

  const patterns = [
    /feeds\/videos\.xml\?channel_id=(UC[A-Za-z0-9_-]{22})(?:[^A-Za-z0-9_-]|$)/i,
    /["']externalId["']\s*:\s*["'](UC[A-Za-z0-9_-]{22})["']/i,
    /itemprop=["']channelId["'][^>]*content=["'](UC[A-Za-z0-9_-]{22})["']/i,
    /content=["'](UC[A-Za-z0-9_-]{22})["'][^>]*itemprop=["']channelId["']/i,
    /["']channelId["']\s*:\s*["'](UC[A-Za-z0-9_-]{22})["']/i,
    /["']browseId["']\s*:\s*["'](UC[A-Za-z0-9_-]{22})["']/i,
    /\/channel\/(UC[A-Za-z0-9_-]{22})(?:[/?"'\\]|$)/i
  ];

  for (const pattern of patterns) {
    const match = String(html || '').match(pattern);
    if (match?.[1] && v029IsValidYouTubeChannelId(match[1])) return match[1];
  }
  return '';
};

v024PrepareYouTubeSource = async function(rawValue, categoryId = '') {
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

  if (!v029IsValidYouTubeChannelId(channelId)) {
    throw new Error(
      `YouTubeのチャンネルIDを正しく取得できませんでした`
      + (channelId ? `（${channelId.length}文字。24文字必要）` : '')
      + '。チャンネルURLを確認してください。'
    );
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
    feedLastFailureAt: '',
    registrationWarning: false,
    feedLastSuccessAt: new Date().toISOString()
  };
};

const v029BasePrepareAutoSource = prepareAutoSource;
prepareAutoSource = async function(rawValue, categoryId = '') {
  const input = String(rawValue || '').trim();
  const youtubeFeedId = v029YouTubeFeedChannelId(input);

  if (youtubeFeedId && !v029IsValidYouTubeChannelId(youtubeFeedId)) {
    throw new Error(
      `YouTubeチャンネルIDが不正です（${youtubeFeedId.length}文字）。`
      + '24文字のチャンネルID、またはYouTubeのチャンネルURLを貼り付けてください。'
    );
  }

  return v029BasePrepareAutoSource(rawValue, categoryId);
};

async function v029RepairStoredYouTubeIds() {
  try {
    const { sources } = await getState();
    let changed = false;
    const next = [];

    for (const source of sources) {
      const currentId = v029YouTubeFeedChannelId(source.value);

      if (!currentId || v029IsValidYouTubeChannelId(currentId)) {
        next.push(source);
        continue;
      }

      if (source.youtubeChannelUrl && v024IsYouTubeChannelUrl(source.youtubeChannelUrl)) {
        try {
          const repaired = await v024PrepareYouTubeSource(
            source.youtubeChannelUrl,
            source.categoryId || ''
          );
          next.push({
            ...source,
            ...repaired,
            id: source.id,
            name: source.name || repaired.name,
            order: source.order,
            categoryId: source.categoryId || ''
          });
          changed = true;
          continue;
        } catch (error) {
          console.debug('YouTube旧IDの再取得に失敗:', source.name, error);
        }
      }

      const message =
        `YouTubeチャンネルIDが不正です（${currentId.length}文字 / 24文字必要）。`
        + 'チャンネルURLから登録し直してください。';

      next.push({
        ...source,
        feedHealthStatus: 'error',
        feedLastError: message,
        feedLastFailureAt: new Date().toISOString()
      });
      changed = true;
    }

    if (changed) {
      await saveSources(next);
      await render();
      if (elements.sourcesDialog?.open) await renderSources();
    }
  } catch (error) {
    console.debug('YouTube ID整合処理をスキップ:', error);
  }
}

window.addEventListener('load', () => {
  setTimeout(v029RepairStoredYouTubeIds, 500);
}, { once: true });
