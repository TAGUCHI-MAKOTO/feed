// v0.1.27: pin uncategorized to the top + keep original folder emoji icons
// ---------------------------------------------------------------------

const v027BaseRenderSourceNavigation = renderSourceNavigation;
renderSourceNavigation = function(sources, categories, allArticles, collapsedCategories = {}) {
  v027BaseRenderSourceNavigation(sources, categories, allArticles, collapsedCategories);

  // 「未分類」はユーザー作成カテゴリではないため、常に一覧の先頭へ固定する。
  const uncategorized = elements.sourceNav.querySelector('.custom-category[data-category-id=""]');
  const firstCategory = elements.sourceNav.querySelector('.custom-category');
  if (uncategorized && firstCategory && uncategorized !== firstCategory) {
    elements.sourceNav.insertBefore(uncategorized, firstCategory);
  }

  // 4Kでも判別しやすい初期のフォルダ絵文字を維持する。
  elements.sourceNav.querySelectorAll('.custom-category').forEach(section => {
    const icon = section.querySelector('.category-select-btn .category-folder');
    if (icon) icon.textContent = section.classList.contains('collapsed') ? '📁' : '📂';
  });
  elements.sourceNav.querySelectorAll('.favorite-folder-item .favorite-folder-icon').forEach(icon => {
    if (!icon.textContent.includes('★')) icon.textContent = '📁';
  });

  // ドラッグ説明文は常時表示しない。
  elements.sourceNav.querySelector('.drag-hint')?.remove();
};
