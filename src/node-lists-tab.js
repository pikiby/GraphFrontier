const { Menu, Notice } = require('obsidian');
const {
  createEditorRow,
  setEditorRowReady,
  bindEditorRowDrag,
  keepMenuOpen,
} = require('./panel-controls');

const LIST_GROUP_COLOR = '#e5484d';
const MEMBER_MENU_LIMIT = 100;

// Compact list editor in the Sets tab; rows and menus follow the group editor.
class NodeListsTab {
  constructor(view, containerEl) {
    this.view = view;
    this.containerEl = containerEl;
    this.owner = view.owner || view.plugin;
  }

  selectedFilePaths() {
    const { app } = this.view;
    return [...(this.view.selectedNodeIds || [])]
      .map((id) => this.view.nodeById?.get(id))
      .filter((node) => node && !node.meta?.darkEnergy && !node.meta?.subgraph)
      .map((node) => app.vault.getAbstractFileByPath(node.id))
      .filter((file) => file && typeof file.extension === 'string')
      .map((file) => file.path);
  }

  async update(request) {
    try {
      return await this.owner.updateNodeList(request);
    } catch (error) {
      new Notice(`Node lists: ${error.message}`);
      return undefined;
    }
  }

  createGroup(list) {
    const plugin = this.view.plugin;
    const query = `list:${list.id}`;
    const groups = plugin.data.groups || [];
    if (!groups.some((group) => group.query === query)) {
      plugin.updateGroups([...groups, { query, color: LIST_GROUP_COLOR, enabled: true }]);
      this.view.buildSidePanel();
    }
    this.view.selectSettingsTab('groups');
  }

  memberTitle(path) {
    const file = this.view.app.vault.getAbstractFileByPath(path);
    const name = path.split('/').pop().replace(/\.md$/i, '');
    return file ? name : `${name} (missing)`;
  }

  // Each member shows a cross; clicking it removes the note and keeps the submenu open,
  // so several notes can be removed in a row. Keyboard Enter removes one and closes the menu.
  fillMembers(submenu, list, membersItem) {
    if (!list.nodeIds.length)
      submenu.addItem((item) => item.setTitle('No notes').setDisabled(true));
    let remaining = list.nodeIds.length;
    for (const path of list.nodeIds.slice(0, MEMBER_MENU_LIMIT)) {
      submenu.addItem((item) => {
        let removed = false;
        const remove = () => {
          if (removed) return;
          removed = true;
          item.dom.style.display = 'none';
          remaining -= 1;
          membersItem?.setTitle(`Members (${remaining})`);
          this.update({ action: 'remove', listId: list.id, nodeIds: [path] });
        };
        item.setTitle(this.memberTitle(path)).setIcon('x').onClick(remove);
        item.dom.setAttribute('title', `${path}\nClick to remove from the list`);
        keepMenuOpen(item.dom, remove, true);
      });
    }
    const more = list.nodeIds.length - MEMBER_MENU_LIMIT;
    if (more > 0) submenu.addItem((item) => item.setTitle(`${more} more...`).setDisabled(true));
  }

  openMenu(list, button, event) {
    const rect = button.getBoundingClientRect?.() || { left: event.clientX, bottom: event.clientY };
    const menu = new Menu(this.view.app);
    const nodeIds = this.selectedFilePaths();
    if (nodeIds.length)
      menu.addItem((item) =>
        item
          .setTitle(`Add selected notes (${nodeIds.length})`)
          .setIcon('list-plus')
          .onClick(() => this.update({ action: 'add', listId: list.id, nodeIds }))
      );
    this.view.addContextSubmenuItem(menu, {
      title: `Members (${list.nodeIds.length})`,
      icon: 'list',
      clientX: rect.left,
      clientY: rect.bottom,
      fillSubmenu: (submenu, membersItem) => this.fillMembers(submenu, list, membersItem),
    });
    menu.addItem((item) =>
      item
        .setTitle('Create group')
        .setIcon('palette')
        .onClick(() => this.createGroup(list))
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle('Delete list')
        .setIcon('trash')
        .onClick(() => this.update({ action: 'delete', listId: list.id }))
    );
    this.view.showMenuAtPointer(menu, rect.left, rect.bottom, event);
  }

  onEnter(input, callback) {
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      callback();
    });
  }

  // Rows are the shared editor rows used by Groups and Filters.
  renderListRow(list) {
    const rowState = createEditorRow(this.containerEl, {
      value: list.name,
      placeholder: 'List name',
      icon: 'more-horizontal',
      label: 'List actions',
    });
    rowState.id = list.id;
    const { queryInput: input, button } = rowState;
    input.setAttribute('aria-label', `List ${list.name}`);
    input.setAttribute('title', `${list.name}: ${list.nodeIds.length} notes (list:${list.id})`);
    const setEditing = (editing) => {
      rowState.editing = editing;
      setEditorRowReady(rowState, true);
    };
    const rename = async () => {
      setEditing(false);
      const name = input.value.trim();
      if (!name) input.value = list.name;
      else if (name !== list.name) await this.update({ action: 'rename', listId: list.id, name });
    };
    this.onEnter(input, () => input.blur());
    input.addEventListener('input', () => setEditing(true));
    input.addEventListener('blur', rename);
    button.addEventListener('click', (event) => {
      event.preventDefault?.();
      this.openMenu(list, button, event);
    });
    setEditing(false);
    // Dropping a list on another puts it in that list's place.
    bindEditorRowDrag(rowState, 'lists', (moved) => {
      const position = this.owner.getNodeLists().findIndex((entry) => entry.id === list.id);
      if (position >= 0) this.update({ action: 'move', listId: moved.id, position });
    });
  }

  render() {
    if (this.containerEl.isConnected === false) return;
    this.containerEl.empty();
    for (const list of this.owner.getNodeLists()) this.renderListRow(list);
    // Like the trailing empty group row, typing a name creates a list on Enter or blur.
    const rowState = createEditorRow(this.containerEl, { placeholder: 'New list...' });
    setEditorRowReady(rowState, false);
    const input = rowState.queryInput;
    input.setAttribute('aria-label', 'New list name');
    input.setAttribute('title', 'Selected notes are added to the new list');
    const create = async () => {
      const name = input.value.trim();
      if (!name) return;
      input.value = '';
      const list = await this.update({ action: 'create', name, nodeIds: this.selectedFilePaths() });
      if (!list) input.value = name;
    };
    this.onEnter(input, () => input.blur());
    input.addEventListener('blur', create);
  }
}

module.exports = { NodeListsTab };
