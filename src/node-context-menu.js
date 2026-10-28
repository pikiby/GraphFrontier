const { Menu, Notice } = require('obsidian');
const { openNoteTarget } = require('./note-navigation');

function buildNodeContextMenu(view, node, clientX, clientY, options = {}) {
  const { app, plugin } = view;
  const menu = options.menu || new Menu(app);
  const snapshot = options.snapshot || view.captureNodeActionTargets(node);
  const only = !!options.singleOnly;
  const singleSnapshot = { ...snapshot, ids: [node.id] };
  if (!only && snapshot.ids.length > 1) {
    view.addSelectionActionsToMenu(menu, snapshot, clientX, clientY);
    menu.addItem((item) =>
      item
        .setTitle(view.nodeActionLabel('Combine selected into subgraph', snapshot))
        .setIcon('circle')
        .onClick(() => view.editSubgraph(null, snapshot))
    );
    view.addContextSubmenuItem(menu, {
      title: `Only for ${view.getLinkedNodeDisplayName(node)}`,
      icon: 'file',
      clientX,
      clientY,
      fillSubmenu: (target) =>
        buildNodeContextMenu(view, node, clientX, clientY, {
          menu: target,
          snapshot,
          singleOnly: true,
        }),
    });
    return menu;
  }
  const file = app.vault.getAbstractFileByPath(node.id);
  const isFile = !!file && typeof file.extension === 'string';
  const nativeMenu = new Menu(app);
  if (isFile) app.workspace.trigger?.('file-menu', nativeMenu, file, 'graphfrontier', view.leaf);

  const add = (target, title, icon, callback, enabled = true) => {
    if (!enabled) return null;
    let added;
    target.addItem((item) => {
      added = item;
      item
        .setTitle(title)
        .setIcon(icon)
        .onClick(async (event) => {
          try {
            if (!view.resolveNodeActionTargets(singleSnapshot).length) return;
            await callback(event);
          } catch (error) {
            new Notice(`${title}: ${error.message}`);
          }
        });
    });
    return added;
  };
  const submenu = (title, icon, fillSubmenu, enabled = true) => {
    if (!enabled) return;
    view.addContextSubmenuItem(menu, {
      title,
      icon,
      clientX,
      clientY,
      fillSubmenu,
    });
  };
  const nativeAction = (target, title, icon, pattern) => {
    const original = nativeMenu.items.find((item) => pattern.test(view.getMenuItemTitleText(item)));
    add(
      target,
      title,
      icon,
      (event) => original.callback(event),
      typeof original?.callback === 'function' && !original.disabled
    );
  };
  const unpin = () => {
    plugin.removePin(node.id);
    plugin.removeOrbitPin(node.id);
    view.kickLayoutSearch();
  };
  const pinned = plugin.isPinned(node.id) || plugin.isOrbitPinned(node.id);
  const linkedIds = view.getLinkedNodeIds(node.id);
  const hasLinked = linkedIds.length > 0;
  const hasLinkedPins = linkedIds.some((id) => plugin.isPinned(id) || plugin.isOrbitPinned(id));
  if (node.meta?.darkEnergy) {
    add(menu, 'Edit gravity node', 'settings', () => view.editDarkEnergy(node));
    add(menu, 'Delete gravity node', 'trash', () => view.removeDarkEnergy(node));
    menu.addSeparator();
  }
  if (node.meta?.subgraph) {
    add(menu, 'Open subgraph in pane', 'panels-top-left', () =>
      view.openSubgraphSeparately(node.id)
    );
    add(menu, 'Rename subgraph', 'pencil', () => view.editSubgraph(node));
    add(menu, 'Ungroup subgraph', 'ungroup', () => view.ungroupSubgraph(node.id));
    menu.addSeparator();
  }
  add(
    menu,
    'Combine selected into subgraph',
    'circle',
    () => view.editSubgraph(null, snapshot),
    !only && view.selectedNodeIds.has(node.id) && snapshot.ids.length > 0
  );

  add(
    menu,
    'Copy system root',
    'hard-drive',
    () => view.copySelectedNodes('systemPaths', snapshot),
    !only && isFile && typeof app.vault.adapter.getFullPath === 'function'
  );
  submenu(
    'Copy',
    'copy',
    (target) => {
      add(target, 'Copy name', 'copy', () => view.copySelectedNodes('names', snapshot), !only);
      add(
        target,
        'As Obsidian URL',
        'link',
        () => app.copyObsidianUrl(file),
        isFile && typeof app.copyObsidianUrl === 'function'
      );
      add(
        target,
        'From vault folder',
        'vault',
        () => view.copySelectedNodes('paths', snapshot),
        !only && isFile
      );
      add(target, 'Copy linked names', 'copy', () => view.copyLinkedNames(node.id), hasLinked);
      add(target, 'Copy linked paths', 'copy', () => view.copyLinkedPaths(node.id), hasLinked);
    },
    !only || hasLinked || (isFile && typeof app.copyObsidianUrl === 'function')
  );
  if (isFile) menu.addSeparator();

  const properties = isFile ? app.metadataCache.getFileCache(file)?.frontmatter : null;
  for (const [key, title, icon] of [
    ['path', 'Open path', 'folder-open'],
    ['url', 'Open URL', 'external-link'],
  ]) {
    const value = properties?.[key];
    add(
      menu,
      title,
      icon,
      () => openNoteTarget(app, key, value.trim(), view.contentEl.win),
      typeof value === 'string' && !!value.trim()
    );
  }
  submenu(
    'Open',
    'folder-open',
    (target) => {
      add(target, 'Open in same tab', 'file', () => view.leaf.openFile(file), isFile);
      nativeAction(
        target,
        'Open in new window',
        'picture-in-picture-2',
        /open in (a )?new window/i
      );
      add(
        target,
        'Open in default app',
        'external-link',
        () => app.openWithDefaultApp(file.path),
        isFile && typeof app.openWithDefaultApp === 'function'
      );
      add(
        target,
        'Show in system explorer',
        'folder-open',
        () => app.showInFolder(file.path),
        isFile && typeof app.showInFolder === 'function'
      );
      const explorer = app.workspace.getLeavesOfType('file-explorer')[0];
      add(
        target,
        'Reveal file in navigation',
        'folder-search',
        async () => {
          await app.workspace.revealLeaf(explorer);
          await explorer.view.revealInFolder(file);
        },
        isFile && typeof explorer?.view?.revealInFolder === 'function'
      );
    },
    isFile
  );
  if (menu.items.length) menu.addSeparator();

  add(
    menu,
    'Pin node',
    'pin',
    () => view.applyNodePinAction(snapshot, 'exact'),
    !only && view.getNodePinActionTargets(snapshot, 'exact').length > 0
  );
  add(
    menu,
    'Pin to grid',
    'grid',
    () => view.applyNodePinAction(snapshot, 'grid'),
    !only && view.getNodePinActionTargets(snapshot, 'grid').length > 0
  );
  submenu(
    'Pin linked',
    'git-branch',
    (target) => {
      add(target, 'Pin linked nodes', 'pin', () => view.pinLinkedNodes(node.id));
      add(target, 'Pin linked nodes to grid', 'grid', () => view.pinLinkedNodesToGrid(node.id));
      add(target, 'Pin linked nodes to orbit', 'orbit', () => view.pinLinkedNodesToOrbit(node.id));
      add(target, 'Unpin node', 'pin-off', unpin, pinned);
      add(
        target,
        'Unpin linked nodes',
        'pin-off',
        () => view.unpinLinkedNodes(node.id),
        hasLinkedPins
      );
    },
    hasLinked
  );
  add(
    menu,
    'Unpin node',
    'pin-off',
    () => view.applyNodePinAction(snapshot, 'unpin'),
    !only && pinned
  );
  menu.addSeparator();

  submenu(
    only ? 'Advanced visual settings' : 'Visual settings',
    'settings-2',
    (target) => {
      view.addVisualSettingsToMenu(target, node, clientX, clientY, singleSnapshot, {
        advancedOnly: only,
      });
    },
    !only || !node.meta?.darkEnergy
  );
  if (node.meta?.darkEnergy) return menu;
  menu.addSeparator();

  add(
    menu,
    'Select linked nodes',
    'check-square',
    () => view.selectLinkedNodes(node.id),
    hasLinked
  );
  nativeAction(menu, 'Bookmark', 'bookmark', /bookmark/i);
  submenu('Other', 'ellipsis', (target) => {
    nativeAction(target, 'Move file to', 'folder-input', /move file to/i);
    nativeAction(target, 'Bookmark', 'bookmark', /bookmark/i);
    nativeAction(target, 'Merge entire file with', 'git-merge', /merge (entire )?file/i);
    add(target, 'Add to search', 'search', () =>
      view.applySearchSelectionFromNode(node, { forceSource: 'name' })
    );
    add(
      target,
      'Show local graph',
      'dot-network',
      () => view.openLocalGraphForNode(node.id),
      isFile && file.extension.toLowerCase() === 'md'
    );
    add(
      target,
      'Open local GraphFrontier',
      'orbit',
      () => (view.owner || view.plugin).openLocalGraphFrontierView(file),
      isFile && file.extension.toLowerCase() === 'md'
    );
  });
  const canDelete = isFile && typeof app.fileManager?.promptForDeletion === 'function';
  if (canDelete) menu.addSeparator();
  const deleteItem = add(
    menu,
    'Delete',
    'trash-2',
    () => app.fileManager.promptForDeletion(file),
    canDelete
  );
  deleteItem?.setWarning(true);
  return menu;
}

module.exports = { buildNodeContextMenu };
