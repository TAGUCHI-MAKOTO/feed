(() => {
  "use strict";

  window.__MYFEED_GPT_EXPORT_VERSION__ = "4.0-gpt-text-tsv";

  const SUMMARY_MAX = 800;
  const TXT_BUTTON_ID = "gptExportTxtBtn";
  const TSV_BUTTON_ID = "gptExportTsvBtn";

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

  function exportMeta(items) {
    return {
      viewTitle: document.getElementById("viewTitle")?.textContent?.trim() || "MyFeed",
      displayCount: document.getElementById("articleCount")?.textContent?.trim() || "",
      exportedAt: new Date().toISOString(),
      total: items.length
    };
  }

  function makeText(items) {
    const meta = exportMeta(items);
    const lines = [
      "MYFEED_GPT_EXPORT",
      `TOTAL_ARTICLES: ${meta.total}`,
      `EXPORTED_AT: ${meta.exportedAt}`,
      `VIEW: ${cleanCell(meta.viewTitle)}`,
      `DISPLAY_COUNT: ${cleanCell(meta.displayCount)}`,
      "",
      "INSTRUCTION: Process every ARTICLE block from 1 through TOTAL_ARTICLES. Do not stop after a partial sample.",
      ""
    ];

    items.forEach((article, index) => {
      const number = index + 1;
      lines.push(
        `=== ARTICLE ${number} / ${items.length} ===`,
        `SOURCE: ${cleanCell(article.sourceName || article.source || "")}`,
        `PUBLISHED: ${toIso(article.publishedAt || article.published || "")}`,
        `TITLE: ${cleanCell(article.title || "")}`,
        `SUMMARY: ${trimSummary(article.description || article.summary || "")}`,
        `URL: ${cleanCell(article.url || "")}`,
        ""
      );
    });

    return lines.join("\r\n");
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

  function timestamp() {
    const d = new Date();
    const pad = value => String(value).padStart(2, "0");
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }

  function downloadFile(content, extension, mimeType) {
    const blob = new Blob(["\uFEFF", content], { type: `${mimeType};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `myfeed_gpt_${timestamp()}.${extension}`;
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
    if (typeof getFilteredArticles !== "function") {
      throw new Error("表示中の記事抽出機能が見つかりません");
    }

    const allArticles = await dbGetAllArticles();

    // MyFeedで現在選択しているフォルダ / フィード / 未読・既読 / 検索条件を反映。
    // 話題統合は行わず、表示条件に該当する元記事をすべて出力する。
    const filtered = getFilteredArticles(allArticles);

    return Array.isArray(filtered) ? filtered : [];
  }

  function createExportButton({ id, label, title, format }) {
    const btn = document.createElement("button");
    btn.id = id;
    btn.type = "button";
    btn.className = "ghost-btn";
    btn.textContent = label;
    btn.title = title;

    btn.addEventListener("click", async () => {
      const defaultText = label;
      btn.disabled = true;
      btn.textContent = "出力中…";

      try {
        const items = await getExportItems();
        if (!items.length) {
          btn.textContent = "記事なし";
          setTimeout(() => { btn.textContent = defaultText; }, 1800);
          return;
        }

        if (format === "txt") {
          downloadFile(makeText(items), "txt", "text/plain");
          btn.textContent = `✓ TXT ${items.length}件`;
        } else {
          downloadFile(makeTsv(items), "tsv", "text/tab-separated-values");
          btn.textContent = `✓ TSV ${items.length}件`;
        }

        setTimeout(() => { btn.textContent = defaultText; }, 2200);
      } catch (error) {
        console.error("[MyFeed GPT Export]", error);
        btn.textContent = "出力失敗";
        btn.title = String(error?.message || error);
        setTimeout(() => {
          btn.textContent = defaultText;
          btn.title = title;
        }, 2500);
      } finally {
        setTimeout(() => { btn.disabled = false; }, 300);
      }
    });

    return btn;
  }

  function installButtons() {
    const refreshBtn = document.getElementById("refreshBtn");
    const actions = document.querySelector(".topbar-actions");
    if (!actions || !refreshBtn) return;

    if (!document.getElementById(TXT_BUTTON_ID)) {
      const txtBtn = createExportButton({
        id: TXT_BUTTON_ID,
        label: "⇩ GPT用TXT",
        title: "選択中のフォルダ/フィード等に該当する全記事をGPT向けTXTで出力",
        format: "txt"
      });
      actions.insertBefore(txtBtn, refreshBtn);
    }

    if (!document.getElementById(TSV_BUTTON_ID)) {
      const tsvBtn = createExportButton({
        id: TSV_BUTTON_ID,
        label: "⇩ TSV",
        title: "選択中のフォルダ/フィード等に該当する全記事をTSVで出力",
        format: "tsv"
      });
      actions.insertBefore(tsvBtn, refreshBtn);
    }
  }

  installButtons();

  const observer = new MutationObserver(() => {
    if (!document.getElementById(TXT_BUTTON_ID) || !document.getElementById(TSV_BUTTON_ID)) {
      installButtons();
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
