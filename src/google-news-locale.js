// v0.2.6: Google News keyword locale auto-selection
// --------------------------------------------------
// Japanese-containing keywords use Japan only.
// Alphabetic keywords fetch BOTH Japan and US-English editions, then merge the
// results into the same MyFeed source. Google-News site fallbacks remain Japan-only.

function v026ContainsJapaneseKeyword(value = '') {
  return /[ぁ-んァ-ヶ一-龯々〆ヵヶ]/u.test(String(value || ''));
}

function v026GoogleNewsModeForKeyword(value = '') {
  const text = String(value || '').normalize('NFKC').trim();
  if (!text) return 'jp';
  if (v026ContainsJapaneseKeyword(text)) return 'jp';
  return /[A-Za-z]/.test(text) ? 'dual' : 'jp';
}

function v026GoogleNewsModeForSource(source = {}) {
  // Temporary edition clones used during a dual fetch must keep their locale.
  if (source.newsEdition === 'jp' || source.newsEdition === 'us') return source.newsEdition;

  // URL registration fallback internally generates site:example.com queries.
  // Keep those on the historical Japan edition; only keyword registration can
  // become dual-locale.
  if (source.discoveryMode === 'google-site-fallback') return 'jp';
  if (/^\s*site:/i.test(String(source.value || ''))) return 'jp';

  return v026GoogleNewsModeForKeyword(source.value || '');
}

function v026GoogleNewsModeLabel(mode) {
  return mode === 'dual' ? '🇯🇵 国内 + 🌍 海外・英語' : '🇯🇵 国内';
}

function v026GoogleNewsRssUrl(query, locale = 'jp') {
  const q = encodeURIComponent(String(query || '').trim());
  if (locale === 'us') {
    return `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
  }
  return `https://news.google.com/rss/search?q=${q}&hl=ja&gl=JP&ceid=JP:ja`;
}

function v026GoogleNewsSearchUrl(query, locale = 'jp') {
  const q = encodeURIComponent(String(query || '').trim());
  if (locale === 'us') {
    return `https://news.google.com/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
  }
  return `https://news.google.com/search?q=${q}&hl=ja&gl=JP&ceid=JP:ja`;
}

const v026BaseSourceUrl = sourceUrl;
sourceUrl = function(source) {
  if (!source || source.type !== 'google') return v026BaseSourceUrl(source);

  const mode = v026GoogleNewsModeForSource(source);
  // A dual source has no single canonical RSS URL. Return the Japan edition for
  // generic callers; the refresh worker below explicitly fetches both editions.
  return v026GoogleNewsRssUrl(source.value, mode === 'us' ? 'us' : 'jp');
};

// google-news-thumbnail-fix.js opens the Google News search page to match images.
// Edition clones passed by the dual worker make this use the matching JP/US page.
if (typeof googleNewsSearchPageUrl === 'function') {
  googleNewsSearchPageUrl = function(source) {
    const query = String(source?.value || '').trim();
    if (!query) return '';
    const mode = v026GoogleNewsModeForSource(source);
    return v026GoogleNewsSearchUrl(query, mode === 'us' ? 'us' : 'jp');
  };
}

const v026BasePrepareAutoSource = prepareAutoSource;
prepareAutoSource = async function(rawValue, categoryId = '') {
  const detected = detectSourceInput(rawValue);
  const source = await v026BasePrepareAutoSource(rawValue, categoryId);

  if (source?.type === 'google') {
    if (source.discoveryMode === 'google-site-fallback' || /^\s*site:/i.test(String(source.value || ''))) {
      source.newsLocale = 'jp';
    } else if (detected.type === 'google') {
      source.newsLocale = v026GoogleNewsModeForKeyword(detected.value);
    }
  }

  return source;
};

const v026BaseUpdateAutoSourceDetectionHint = updateAutoSourceDetectionHint;
updateAutoSourceDetectionHint = function() {
  const hint = document.getElementById('sourceDetectHint');
  if (!hint) return;

  const detected = detectSourceInput(elements.sourceValue.value);
  if (detected.type !== 'google') {
    v026BaseUpdateAutoSourceDetectionHint();
    return;
  }

  const mode = v026GoogleNewsModeForKeyword(detected.value);
  hint.textContent = `自動判定：Google News キーワード（${v026GoogleNewsModeLabel(mode)}）`;
};

function v026MergeNormalizedArticles(articleLists = []) {
  const merged = new Map();
  for (const articles of articleLists) {
    for (const article of articles || []) {
      const existing = merged.get(article.id);
      if (!existing) {
        merged.set(article.id, article);
        continue;
      }
      merged.set(article.id, {
        ...existing,
        ...article,
        imageUrl: existing.imageUrl || article.imageUrl || '',
        description: existing.description?.length >= article.description?.length
          ? existing.description
          : article.description
      });
    }
  }
  return Array.from(merged.values());
}

async function v026FetchGoogleEdition(source, locale) {
  const editionSource = { ...source, newsEdition: locale };
  const url = v026GoogleNewsRssUrl(source.value, locale);
  const meta = await fetchFeedMeta(url);
  if (!looksLikeFeedDocument(meta.text)) {
    throw new Error(`${locale === 'us' ? '海外' : '国内'}版をRSSとして認識できませんでした`);
  }

  const parsed = parseFeed(meta.text, editionSource, meta.finalUrl || url);
  if (typeof enrichGoogleNewsItemsFromSearch === 'function') {
    await enrichGoogleNewsItemsFromSearch(parsed, editionSource);
  }
  return normalizeItems(parsed, editionSource);
}

const v026BaseFetchOneSource = v032FetchOneSource;
v032FetchOneSource = async function(source) {
  if (!source || source.type !== 'google' || v026GoogleNewsModeForSource(source) !== 'dual') {
    return v026BaseFetchOneSource(source);
  }

  const settled = await Promise.allSettled([
    v026FetchGoogleEdition(source, 'jp'),
    v026FetchGoogleEdition(source, 'us')
  ]);

  const successfulLists = settled
    .filter(result => result.status === 'fulfilled')
    .map(result => result.value);
  const failures = settled.filter(result => result.status === 'rejected');

  if (!successfulLists.length) {
    const messages = failures.map(result => result.reason?.message || String(result.reason || '')).filter(Boolean);
    const error = new Error(messages.join(' / ') || '国内版・海外版とも取得できませんでした');
    return {
      ok: false,
      source,
      articles: [],
      error,
      sourcePatch: {
        feedFailCount: Number(source.feedFailCount || 0) + 1,
        feedHealthStatus: 'error',
        feedLastError: error.message,
        feedLastFailureAt: new Date().toISOString()
      }
    };
  }

  if (failures.length) {
    console.warn('Google News 国内+海外取得: 一部エディションをスキップ', source.name, failures[0].reason);
  }

  return {
    ok: true,
    source,
    articles: v026MergeNormalizedArticles(successfulLists),
    sourcePatch: {
      feedFailCount: 0,
      feedHealthStatus: 'ok',
      feedLastError: failures.length ? '国内版 / 海外版のどちらか一方のみ取得しました' : '',
      feedLastFailureAt: '',
      registrationWarning: false,
      feedLastSuccessAt: new Date().toISOString(),
      newsLocale: 'dual'
    }
  };
};
