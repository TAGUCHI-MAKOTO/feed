// v0.2.5: Google News keyword locale auto-selection
// --------------------------------------------------
// Japanese-containing keywords use the Japan edition.
// Alphabetic keywords use the US English edition so overseas sources are
// surfaced more often. Google-News site fallbacks remain Japan-oriented.

function v025ContainsJapaneseKeyword(value = '') {
  return /[ぁ-んァ-ヶ一-龯々〆ヵヶ]/u.test(String(value || ''));
}

function v025GoogleNewsLocaleForKeyword(value = '') {
  const text = String(value || '').normalize('NFKC').trim();
  if (!text) return 'jp';
  if (v025ContainsJapaneseKeyword(text)) return 'jp';
  return /[A-Za-z]/.test(text) ? 'us' : 'jp';
}

function v025GoogleNewsLocaleForSource(source = {}) {
  const explicit = String(source.newsLocale || '').toLowerCase();
  if (explicit === 'us' || explicit === 'jp') return explicit;

  // URL registration fallback internally generates site:example.com queries.
  // Keep those on the historical Japan edition; only keyword registration
  // should switch automatically to overseas/English results.
  if (source.discoveryMode === 'google-site-fallback') return 'jp';
  if (/^\s*site:/i.test(String(source.value || ''))) return 'jp';

  return v025GoogleNewsLocaleForKeyword(source.value || '');
}

function v025GoogleNewsLocaleLabel(locale) {
  return locale === 'us' ? '🌍 海外・英語' : '🇯🇵 国内';
}

const v025BaseSourceUrl = sourceUrl;
sourceUrl = function(source) {
  if (!source || source.type !== 'google') return v025BaseSourceUrl(source);

  const q = encodeURIComponent(String(source.value || '').trim());
  const locale = v025GoogleNewsLocaleForSource(source);
  if (locale === 'us') {
    return `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
  }
  return `https://news.google.com/rss/search?q=${q}&hl=ja&gl=JP&ceid=JP:ja`;
};

const v025BasePrepareAutoSource = prepareAutoSource;
prepareAutoSource = async function(rawValue, categoryId = '') {
  const detected = detectSourceInput(rawValue);
  const source = await v025BasePrepareAutoSource(rawValue, categoryId);

  if (source?.type === 'google') {
    if (source.discoveryMode === 'google-site-fallback' || /^\s*site:/i.test(String(source.value || ''))) {
      source.newsLocale = 'jp';
    } else if (detected.type === 'google') {
      source.newsLocale = v025GoogleNewsLocaleForKeyword(detected.value);
    }
  }

  return source;
};

const v025BaseUpdateAutoSourceDetectionHint = updateAutoSourceDetectionHint;
updateAutoSourceDetectionHint = function() {
  const hint = document.getElementById('sourceDetectHint');
  if (!hint) return;

  const detected = detectSourceInput(elements.sourceValue.value);
  if (detected.type !== 'google') {
    v025BaseUpdateAutoSourceDetectionHint();
    return;
  }

  const locale = v025GoogleNewsLocaleForKeyword(detected.value);
  hint.textContent = `自動判定：Google News キーワード（${v025GoogleNewsLocaleLabel(locale)}）`;
};
