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
