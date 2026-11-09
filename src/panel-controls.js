const { setIcon } = require('obsidian');

// Side panel controls shared by the Search, Groups, Filters and Custom lists blocks.

let draggingRow = null;

// Editor row: drag handle, text field and an optional round button that opens the row menu.
function createEditorRow(parentEl, { value = '', placeholder, icon, label }) {
  const row = parentEl.createDiv({ cls: 'graphfrontier-group-row' });
  const dragHandle = row.createSpan({ cls: 'graphfrontier-group-drag', text: '::' });
  const inputWrap = row.createDiv({
    cls: 'graphfrontier-group-query-wrap graphfrontier-input-anchor',
  });
  const queryInput = inputWrap.createEl('input', {
    cls: 'graphfrontier-group-query',
    type: 'text',
    placeholder,
  });
  queryInput.value = value;
  const rowState = { row, dragHandle, inputWrap, queryInput, button: null, controls: [] };
  if (icon) {
    rowState.button = row.createEl('button', { cls: 'graphfrontier-group-settings' });
    rowState.button.setAttribute('aria-label', label);
    rowState.button.setAttribute('title', label);
    setIcon(rowState.button, icon);
    rowState.controls.push(rowState.button);
  }
  return rowState;
}

// The handle and controls show only on a ready row, and hide while its text is being changed.
function setEditorRowReady(rowState, ready) {
  const shown = ready && !rowState.editing;
  rowState.dragHandle.style.visibility = shown ? 'visible' : 'hidden';
  for (const control of rowState.controls) control.style.display = shown ? '' : 'none';
  rowState.row.draggable = shown;
}

// Handle drag between rows of one editor; `editor` keeps drops inside it.
function bindEditorRowDrag(rowState, editor, onDrop) {
  const { row } = rowState;
  const isTarget = () => draggingRow?.editor === editor && draggingRow.rowState !== rowState;
  row.addEventListener('dragstart', (event) => {
    if (!row.draggable) {
      event.preventDefault();
      return;
    }
    draggingRow = { editor, rowState };
    row.addClass('is-dragging');
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', rowState.id || editor);
    }
  });
  row.addEventListener('dragover', (event) => {
    if (!isTarget()) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  });
  row.addEventListener('drop', (event) => {
    if (!isTarget()) return;
    event.preventDefault();
    const moved = draggingRow.rowState;
    // A drop may re-render the editor, so the source row can miss its dragend.
    draggingRow = null;
    onDrop(moved);
  });
  row.addEventListener('dragend', () => {
    row.removeClass('is-dragging');
    draggingRow = null;
  });
}

// Places the dragged row where the target was, in the row list and in the DOM.
function moveEditorRow(sectionEl, rowStates, moved, target) {
  const fromIndex = rowStates.indexOf(moved);
  const toIndex = rowStates.indexOf(target);
  if (fromIndex < 0 || toIndex < 0) return false;
  rowStates.splice(fromIndex, 1);
  rowStates.splice(toIndex, 0, moved);
  sectionEl.insertBefore(moved.row, fromIndex < toIndex ? target.row.nextSibling : target.row);
  return true;
}

// Clicks inside `el` run `onClick` without closing the Obsidian menu that holds it. A menu item's
// own element needs the capture phase, because the menu's click handler sits on that element.
function keepMenuOpen(el, onClick = null, capture = false) {
  for (const eventName of ['click', 'mousedown', 'keydown'])
    el.addEventListener(
      eventName,
      (event) => {
        if (capture) event.stopImmediatePropagation();
        else event.stopPropagation();
        if (eventName === 'click') onClick?.(event);
      },
      capture
    );
}

// "Left [switch] Right" control, as in Find/Filter, Hide/Exclude and Exclude/Include only.
function createModeSwitch(parentEl, { left, right, leftTitle, rightTitle }) {
  const leftLabel = parentEl.createSpan({
    cls: 'graphfrontier-find-mode-label',
    text: left,
    ...(leftTitle ? { attr: { title: leftTitle } } : {}),
  });
  const toggle = parentEl.createEl('button', {
    cls: 'graphfrontier-toggle-btn graphfrontier-search-mode-toggle',
    attr: { type: 'button', role: 'switch' },
  });
  const rightLabel = parentEl.createSpan({
    cls: 'graphfrontier-find-mode-label',
    text: right,
    ...(rightTitle ? { attr: { title: rightTitle } } : {}),
  });
  return {
    toggle,
    leftLabel,
    rightLabel,
    sync(rightOn) {
      toggle.toggleClass('is-on', rightOn);
      toggle.setAttribute('aria-checked', String(rightOn));
      leftLabel.toggleClass('is-active', !rightOn);
      rightLabel.toggleClass('is-active', rightOn);
    },
  };
}

module.exports = {
  createEditorRow,
  setEditorRowReady,
  bindEditorRowDrag,
  moveEditorRow,
  keepMenuOpen,
  createModeSwitch,
};
