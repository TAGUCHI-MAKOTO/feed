// v0.1.19: repair registered WEB feeds immediately after the first failed fetch
// ---------------------------------------------------------------------------
// v0.1.18 waited for 3 consecutive failures (except 404/410).
// From v0.1.19, every WEB/RSS feed gets one repair attempt on the first failure.
// The existing 1-hour cooldown is kept to avoid repeatedly scanning the site.
shouldAttemptFeedRepair = function(source, error, failCount) {
  if (!source || source.type !== 'rss') return false;

  const lastAttempt = new Date(source.feedLastRepairAttemptAt || 0).getTime();
  if (Number.isFinite(lastAttempt) && lastAttempt > 0 && Date.now() - lastAttempt < FEED_AUTO_REPAIR_RETRY_MS) {
    return false;
  }

  return Number(failCount || 0) >= 1;
};
