const { Menu, Notice } = require('obsidian');
const { createEditorRow, setEditorRowReady } = require('./panel-controls');

// Layout block: every saved layout is a row; clicking one makes it active. Rows are the shared
// editor rows of Groups and Custom lists. Layouts follow their file names, so they have no handle.
class LayoutList {
  constructor(view, containerEl) {
    this.view = view;
    this.plugin = view.plugin;
    this.containerEl = containerEl;
    this.renderToken = 0;
  }

  displayName(layoutFileName) {
    return this.view.getLayoutDisplayName(layoutFileName);
  }

  setRowState(rowState, editing) {
    rowState.editing = editing;
    setEditorRowReady(rowState, true);
    rowState.dragHandle.style.visibility = 'hidden';
    rowState.row.draggable = false;
  }

  onEnter(input, callback) {
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      callback();
    });
  }

  async rename(layoutFileName, rawName) {
    const name = String(rawName || '').trim();
    if (!name || name === this.displayName(layoutFileName)) return false;
    const result = await this.plugin.renameLayoutFile(layoutFileName, name);
    if (!result?.ok) {
      new Notice(
        result?.reason === 'exists'
          ? `Layout already exists: ${this.displayName(result.layoutName)}`
          : 'Failed to rename layout'
      );
      return false;
    }
    return true;
  }

  async delete(layoutFileName) {
    const result = await this.plugin.deleteLayoutFile(layoutFileName);
    if (!result || result.ok !== true) {
      const reason = String(result?.reason || '');
      if (reason === 'last-layout') new Notice('Cannot delete the last layout');
      else if (reason === 'not-found') new Notice('Layout file not found');
      else new Notice('Failed to delete layout');
      return;
    }
    if (result.activeChanged) {
      this.plugin.refreshAllViews({ forceSavedPositions: true, skipLayoutKick: true });
      this.view.buildSidePanel();
      this.plugin.renderAllViews();
      return;
    }
    await this.render();
  }

  // Saving under a new name writes the current graph there and makes that layout active.
  async create(rawName) {
    const name = String(rawName || '').trim();
    if (!name) return false;
    const layoutFileName = this.plugin.normalizeLayoutFileName(name);
    if ((await this.plugin.listLayoutFileNames()).includes(layoutFileName)) {
      new Notice(`Layout already exists: ${this.displayName(layoutFileName)}`);
      return false;
    }
    const saved = await this.view.saveCurrentLayout({ layoutFileName });
    if (saved) await this.render();
    return saved;
  }

  openMenu(layoutFileName, rowState, event) {
    const button = rowState.button;
    const rect = button.getBoundingClientRect?.() || { left: event.clientX, bottom: event.clientY };
    const menu = new Menu(this.view.app);
    menu.addItem((item) =>
      item
        .setTitle('Rename')
        .setIcon('pencil')
        .onClick(() => {
          const input = rowState.queryInput;
          input.readOnly = false;
          this.setRowState(rowState, true);
          input.focus();
          input.select?.();
        })
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle('Delete layout')
        .setIcon('trash')
        .onClick(() => this.delete(layoutFileName))
    );
    this.view.showMenuAtPointer(menu, rect.left, rect.bottom, event);
  }

  renderLayoutRow(layoutFileName, active) {
    const rowState = createEditorRow(this.containerEl, {
      value: this.displayName(layoutFileName),
      placeholder: 'Layout name',
      icon: 'more-horizontal',
      label: 'Layout actions',
    });
    rowState.id = layoutFileName;
    const { row, queryInput: input, button } = rowState;
    row.addClass('graphfrontier-layout-row');
    row.toggleClass('is-active', active);
    // The name is edited only after Rename; until then a click selects the layout.
    input.readOnly = true;
    input.setAttribute('aria-label', `Layout ${this.displayName(layoutFileName)}`);
    input.setAttribute('title', active ? 'Active layout' : 'Click to make this layout active');
    input.addEventListener('click', () => {
      if (!input.readOnly || active) return;
      void this.view.selectActiveLayoutFileByName(layoutFileName);
    });
    this.onEnter(input, () => input.blur());
    input.addEventListener('input', () => this.setRowState(rowState, true));
    input.addEventListener('blur', async () => {
      if (input.readOnly) return;
      input.readOnly = true;
      this.setRowState(rowState, false);
      if (!(await this.rename(layoutFileName, input.value)))
        input.value = this.displayName(layoutFileName);
      else await this.render();
    });
    button.addEventListener('click', (event) => {
      event.preventDefault?.();
      this.openMenu(layoutFileName, rowState, event);
    });
    this.setRowState(rowState, false);
  }

  // Rows from the last listing appear at once, so a panel rebuild keeps its height and scroll;
  // the folder listing then replaces them only when the files differ.
  async render() {
    const token = ++this.renderToken;
    const cached = this.view.layoutNamesCache;
    if (cached) this.renderRows(cached);
    const names = await this.plugin.listLayoutFileNames();
    if (token !== this.renderToken || this.containerEl.isConnected === false) return;
    this.view.layoutNamesCache = names;
    if (!cached || cached.join('\n') !== names.join('\n')) this.renderRows(names);
  }

  renderRows(names) {
    const activeName = this.plugin.getActiveLayoutFileName();
    this.containerEl.empty();
    for (const name of names) this.renderLayoutRow(name, name === activeName);
    // Like the trailing empty group row: a typed name saves the current graph as a new layout.
    const rowState = createEditorRow(this.containerEl, { placeholder: 'New layout...' });
    setEditorRowReady(rowState, false);
    const input = rowState.queryInput;
    input.setAttribute('aria-label', 'New layout name');
    input.setAttribute('title', 'Save the current graph as a new layout and make it active');
    const create = async () => {
      const name = input.value;
      if (!name.trim()) return;
      input.value = '';
      if (!(await this.create(name))) input.value = name;
    };
    this.onEnter(input, () => input.blur());
    input.addEventListener('blur', create);
  }
}

module.exports = { LayoutList };
