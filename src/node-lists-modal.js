const { Modal, Menu, Notice, setIcon } = require('obsidian');
const { DataConfirmModal } = require('./data-confirm-modal');
const PAGE_SIZE = 50;

class NodeListsPanel {
  constructor(view, containerEl) {
    this.app = view.app;
    this.contentEl = containerEl;
    this.view = view;
    this.owner = view.owner || view.plugin;
    this.selectedId = null;
    this.query = '';
    this.memberQuery = '';
    this.fileQuery = '';
    this.page = 0;
    this.addMode = false;
    this.selected = new Set();
    this.newNameDraft = '';
    this.busy = false;
    this.isOpen = false;
  }
  onOpen() {
    this.isOpen = true;
    this.render();
  }
  async update(request) {
    if (this.busy) return;
    this.busy = true;
    try {
      const result = await this.owner.updateNodeList(request);
      if (request.action === 'create') {
        this.selectedId = result.id;
        this.newNameDraft = '';
      }
      if (request.action === 'delete') this.selectedId = null;
      this.selected.clear();
      if (this.isOpen) this.render();
      return true;
    } catch (error) {
      new Notice(`Node lists: ${error.message}`);
    } finally {
      this.busy = false;
    }
  }
  search(parent, placeholder, value, onChange) {
    const input = parent.createEl('input', {
      type: 'search',
      placeholder,
      cls: 'graphfrontier-data-search',
    });
    input.value = value;
    input.setAttribute('aria-label', placeholder);
    input.addEventListener('input', () => onChange(input.value));
    return input;
  }
  render() {
    this.contentEl.empty();
    const list = this.owner.getNodeLists().find((l) => l.id === this.selectedId);
    if (list) this.renderList(list);
    else this.renderCatalog();
  }
  renderCatalog() {
    const createRow = this.contentEl.createDiv({ cls: 'setting-item' });
    const info = createRow.createDiv({ cls: 'setting-item-info' });
    info.createDiv({ cls: 'setting-item-name', text: 'Create list' });
    const create = createRow.createDiv({ cls: 'setting-item-control' });
    const name = create.createEl('input', { type: 'text', placeholder: 'New list name' });
    name.value = this.newNameDraft;
    name.setAttribute('aria-label', 'New list name');
    name.addEventListener('input', () => {
      this.newNameDraft = name.value;
    });
    create
      .createEl('button', { text: 'New list' })
      .addEventListener('click', () => this.update({ action: 'create', name: name.value.trim() }));
    this.search(this.contentEl, 'Search lists', this.query, (value) => {
      this.query = value;
      this.page = 0;
      draw();
    });
    const results = this.contentEl.createDiv({ cls: 'graphfrontier-data-results' });
    const draw = () => {
      results.empty();
      const lists = this.owner
        .getNodeLists()
        .filter((l) => `${l.name} ${l.id}`.toLowerCase().includes(this.query.toLowerCase()));
      this.pageResults(
        results,
        lists,
        (list) => {
          const row = results.createEl('button', { cls: 'graphfrontier-data-list-button' });
          row.createSpan({ text: list.name });
          row.createSpan({ text: String(list.nodeIds.length), cls: 'graphfrontier-data-count' });
          row.addEventListener('click', () => {
            this.selectedId = list.id;
            this.page = 0;
            this.memberQuery = '';
            this.addMode = false;
            this.selected.clear();
            this.render();
          });
        },
        draw
      );
    };
    draw();
  }
  pageResults(parent, items, drawItem, redraw) {
    this.page = Math.min(this.page, Math.max(0, Math.ceil(items.length / PAGE_SIZE) - 1));
    const start = this.page * PAGE_SIZE;
    for (const item of items.slice(start, start + PAGE_SIZE)) drawItem(item);
    if (!items.length) parent.createEl('p', { text: 'No matches' });
    if (items.length <= PAGE_SIZE) return;
    const nav = parent.createDiv({ cls: 'graphfrontier-node-list-actions' });
    nav.createSpan({
      text: `${items.length ? start + 1 : 0}-${Math.min(items.length, start + PAGE_SIZE)} of ${items.length}`,
    });
    if (start > 0)
      nav.createEl('button', { text: 'Previous' }).addEventListener('click', () => {
        this.page--;
        redraw();
      });
    if (start + PAGE_SIZE < items.length)
      nav.createEl('button', { text: 'Next' }).addEventListener('click', () => {
        this.page++;
        redraw();
      });
  }
  renderList(list) {
    const toolbar = this.contentEl.createDiv({ cls: 'graphfrontier-list-toolbar' });
    const back = toolbar.createEl('button', { cls: 'clickable-icon graphfrontier-list-icon' });
    back.setAttribute('aria-label', 'All lists');
    setIcon(back, 'arrow-left');
    back.addEventListener('click', () => {
      this.selectedId = null;
      this.page = 0;
      this.selected.clear();
      this.render();
    });
    toolbar.createSpan({
      text: `${list.name} (${list.nodeIds.length})`,
      cls: 'graphfrontier-data-heading',
    });
    const actions = toolbar.createDiv({ cls: 'graphfrontier-list-toolbar-actions' });
    const more = toolbar.createEl('button', { cls: 'clickable-icon graphfrontier-list-icon' });
    setIcon(more, 'ellipsis');
    more.setAttribute('aria-label', 'List actions');
    more.addEventListener('click', () => {
      const menu = new Menu(this.app);
      menu.addItem((item) =>
        item
          .setTitle('Copy list ID')
          .setIcon('copy')
          .onClick(() => this.view.copyTextToClipboard(list.id))
      );
      menu.addItem((item) =>
        item
          .setTitle('Rename...')
          .setIcon('pencil')
          .onClick(() => this.rename(list))
      );
      menu.addItem((item) =>
        item
          .setTitle('Delete list...')
          .setIcon('trash')
          .onClick(async () => {
            if (
              await DataConfirmModal.ask(
                this.app,
                'Delete list?',
                `Delete ${list.name}? Group rules referring to it will remain but match no nodes.`,
                'Delete'
              )
            )
              void this.update({ action: 'delete', listId: list.id });
          })
      );
      const rect = more.getBoundingClientRect();
      menu.showAtPosition({ x: rect.left, y: rect.bottom });
    });
    actions
      .createEl('button', { text: this.addMode ? 'Back to members' : 'Add files...' })
      .addEventListener('click', () => {
        this.addMode = !this.addMode;
        this.page = 0;
        this.selected.clear();
        this.render();
      });
    const apply = actions.createEl('button', {
      text: this.addMode ? 'Add selected' : 'Remove selected',
    });
    apply.disabled = !this.selected.size;
    apply.hidden = !this.selected.size;
    apply.addEventListener('click', () =>
      this.update({
        action: this.addMode ? 'add' : 'remove',
        listId: list.id,
        nodeIds: [...this.selected],
      })
    );
    const query = this.addMode ? this.fileQuery : this.memberQuery;
    this.search(
      this.contentEl,
      this.addMode ? 'Search vault files' : 'Search members',
      query,
      (value) => {
        if (this.addMode) this.fileQuery = value;
        else this.memberQuery = value;
        this.page = 0;
        draw();
      }
    );
    const results = this.contentEl.createDiv({ cls: 'graphfrontier-data-results' });
    // Enumerate only when opening the picker, not on each keystroke.
    const candidates = this.addMode ? this.app.vault.getFiles().map((f) => f.path) : list.nodeIds;
    const members = new Set(list.nodeIds);
    const draw = () => {
      results.empty();
      const text = (this.addMode ? this.fileQuery : this.memberQuery).toLowerCase();
      const paths = candidates.filter(
        (path) => path.toLowerCase().includes(text) && (!this.addMode || !members.has(path))
      );
      this.pageResults(
        results,
        paths,
        (path) => {
          const row = results.createDiv({ cls: 'graphfrontier-data-row' });
          const label = row.createEl('label', { cls: 'graphfrontier-data-file' });
          const check = label.createEl('input', { type: 'checkbox' });
          check.checked = this.selected.has(path);
          check.setAttribute('aria-label', path);
          check.addEventListener('change', () => {
            if (check.checked) this.selected.add(path);
            else this.selected.delete(path);
            apply.disabled = !this.selected.size;
            apply.hidden = !this.selected.size;
          });
          const text = label.createDiv({ cls: 'graphfrontier-data-file-text' });
          text.createSpan({ text: path.split('/').pop() });
          text.createSpan({ text: path, cls: 'graphfrontier-data-path' });
          if (!this.app.vault.getAbstractFileByPath(path))
            text.createSpan({ text: 'File not found', cls: 'graphfrontier-backup-warning' });
        },
        draw
      );
    };
    draw();
  }
  rename(list) {
    const modal = new Modal(this.app);
    modal.setTitle('Rename list');
    const input = modal.contentEl.createEl('input', { type: 'text' });
    input.value = list.name;
    input.setAttribute('aria-label', 'List name');
    modal.contentEl.createEl('button', { text: 'Rename' }).addEventListener('click', async () => {
      if (await this.update({ action: 'rename', listId: list.id, name: input.value.trim() }))
        modal.close();
    });
    modal.open();
  }
  onClose() {
    this.isOpen = false;
    this.selected.clear();
    this.contentEl.empty();
  }
}
module.exports = { NodeListsPanel };
