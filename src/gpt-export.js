(() => {
  "use strict";

  const SUMMARY_MAX = 800;
  const BUTTON_ID = "gptExportBtn";

  function cleanCell(value) {
    return String(value ?? "")
      .replace(/\t/g, " ")
      .replace(/\r?\n/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  function trimSummary(value) {
    const text = cleanCell(value);
    return text.length <= SUMMARY_MAX ? text : text.slice(0, SUMMARY_MAX) + "…";
  }

  function toIso(value) {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? cleanCell(value) : date.toISOString();
  }

  function makeTsv(items) {
    const lines = [["ID", "source", "published", "title", "summary", "url"].join("\t")];

    items.forEach((article, index) => {
      lines.push([
        index + 1,
        cleanCell(article.sourceName || article.source || ""),
        toIso(article.publishedAt || article.published || ""),
        cleanCell(article.title || ""),
        trimSummary(article.description || article.summary || ""),
        cleanCell(article.url || "")
      ].join("\t"));
    });

    return lines.join("\r\n");
  }

  function makeFilename() {
    const d = new Date();
    const pad = value => String(value).padStart(2, "0");
    return `myfeed_gpt_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.tsv`;
  }

  function downloadTsv(text) {
    const blob = new Blob(["\uFEFF", text], {
      type: "text/tab-separated-values;charset=utf-8"
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = makeFilename();
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function getExportItems() {
    if (typeof dbGetAllArticles !== "function") {
      throw new Error("記事データ取得機能が見つかりません");
    }

    const allArticles = await dbGetAllArticles();
    const filtered = typeof getFilteredArticles === "function"
      ? getFilteredArticles(allArticles)
      : allArticles;

    const stories = typeof buildStoryCards === "function"
      ? buildStoryCards(filtered, allArticles)
      : filtered;

    return Array.isArray(stories) ? stories : [];
  }

  function installButton() {
    if (document.getElementById(BUTTON_ID)) return;

    const refreshBtn = document.getElementById("refreshBtn");
    const actions = document.querySelector(".topbar-actions");
    if (!actions || !refreshBtn) return;

    const btn = document.createElement("button");
    btn.id = BUTTON_ID;
    btn.type = "button";
    btn.className = "ghost-btn";
    btn.textContent = "⇩ GPT用TSV";
    btn.title = "現在の表示条件に合う記事をGPT用TSVで出力";
    actions.insertBefore(btn, refreshBtn);

    btn.addEventListener("click", async () => {
      const defaultText = "⇩ GPT用TSV";
      btn.disabled = true;
      btn.textContent = "出力中…";

      try {
        const items = await getExportItems();
        if (!items.length) {
          btn.textContent = "記事なし";
          setTimeout(() => { btn.textContent = defaultText; }, 1800);
          return;
        }

        downloadTsv(makeTsv(items));
        btn.textContent = `✓ ${items.length}件`;
        setTimeout(() => { btn.textContent = defaultText; }, 2200);
      } catch (error) {
        console.error("[MyFeed GPT Export]", error);
        btn.textContent = "出力失敗";
        btn.title = String(error?.message || error);
        setTimeout(() => { btn.textContent = defaultText; }, 2500);
      } finally {
        setTimeout(() => { btn.disabled = false; }, 300);
      }
    });
  }

  installButton();

  const observer = new MutationObserver(() => {
    if (!document.getElementById(BUTTON_ID)) installButton();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
