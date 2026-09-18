const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, loadSource } = require('./helpers/obsidian.cjs');
const { buildNodeContextMenu } = loadSource('node-context-menu.js');
const titles = (menu) => menu.items.map((item) => (item.separator ? '---' : item.title));
const item = (menu, title) => menu.items.find((entry) => entry.title === title);

function setup(t) {
  const f = fixture(t);
  const file = { path: 'Folder/alpha.md', extension: 'md' };
  const calls = [];
  f.app.vault.getAbstractFileByPath = () => file;
  f.app.vault.adapter.getFullPath = (path) => `/vault/${path}`;
  f.app.metadataCache.getFileCache = () => ({
    frontmatter: { path: '/project', url: 'https://example.com' },
  });
  f.app.workspace.trigger = (_, menu) => {
    for (const title of [
      'Open in new window',
      'Move file to...',
      'Bookmark...',
      'Merge entire file with...',
    ]) {
      menu.addItem((entry) => entry.setTitle(title).onClick(() => calls.push(title)));
    }
  };
  f.app.copyObsidianUrl = (target) => calls.push(['url', target.path]);
  f.app.openWithDefaultApp = () => {};
  f.app.showInFolder = () => {};
  const getLeaves = f.app.workspace.getLeavesOfType;
  f.app.workspace.getLeavesOfType = (type) =>
    type === 'file-explorer' ? [{ view: { revealInFolder() {} } }] : getLeaves(type);
  f.app.fileManager = { promptForDeletion: (target) => calls.push(['delete', target.path]) };
  f.view.copyTextToClipboard = async (text) => {
    calls.push(text);
    return true;
  };
  const node = { id: file.path, label: 'alpha', x: 0, y: 0 };
  f.view.nodeById.set(node.id, node);
  f.view.nodeById.set('linked.md', { id: 'linked.md', x: 10, y: 20 });
  f.view.neighborsById = new Map([[node.id, new Set(['linked.md'])]]);
  f.plugin.setOrbitPin(node.id, { anchor_id: 'linked.md', radius: 10, angle: 0 });
  f.plugin.setPin('linked.md', { x: 10, y: 20 });
  return { ...f, file, calls, node, menu: buildNodeContextMenu(f.view, node, 10, 20) };
}

test('node menu follows requested sections and puts Delete last', (t) => {
  const { menu } = setup(t);
  assert.deepEqual(titles(menu), [
    'Copy system root',
    'Copy',
    '---',
    'Open path',
    'Open URL',
    'Open',
    '---',
    'Pin node',
    'Pin to grid',
    'Pin linked',
    'Unpin node',
    '---',
    'Visual settings',
    '---',
    'Select linked nodes',
    'Bookmark',
    'Other',
    '---',
    'Delete',
  ]);
  assert.deepEqual(titles(item(menu, 'Copy').submenu), [
    'As Obsidian URL',
    'From vault folder',
    'Copy linked names',
    'Copy linked paths',
  ]);
  assert.deepEqual(titles(item(menu, 'Open').submenu), [
    'Open in same tab',
    'Open in new window',
    'Open in default app',
    'Show in system explorer',
    'Reveal file in navigation',
  ]);
  assert.deepEqual(titles(item(menu, 'Pin linked').submenu), [
    'Pin linked nodes',
    'Pin linked nodes to grid',
    'Pin linked nodes to orbit',
    'Unpin node',
    'Unpin linked nodes',
  ]);
  assert.deepEqual(titles(item(menu, 'Visual settings').submenu), [
    'Text size',
    'Strong pull',
    'Paint edges',
  ]);
  assert.deepEqual(titles(item(menu, 'Other').submenu), [
    'Move file to',
    'Bookmark',
    'Merge entire file with',
    'Add to search',
    'Show local graph',
  ]);
  assert.equal(item(menu, 'Delete').warning, true);
});

test('copy and native actions retain their target file and deletion prompts first', async (t) => {
  const { menu, calls, file } = setup(t);
  assert.deepEqual(calls, []);
  await item(menu, 'Copy system root').callback();
  await item(item(menu, 'Copy').submenu, 'From vault folder').callback();
  await item(item(menu, 'Copy').submenu, 'As Obsidian URL').callback();
  await item(menu, 'Bookmark').callback();
  await item(item(menu, 'Other').submenu, 'Move file to').callback();
  await item(item(menu, 'Other').submenu, 'Merge entire file with').callback();
  await item(menu, 'Delete').callback();
  assert.deepEqual(calls, [
    `/vault/${file.path}`,
    file.path,
    ['url', file.path],
    'Bookmark...',
    'Move file to...',
    'Merge entire file with...',
    ['delete', file.path],
  ]);
});

test('all general linked pin modes and unpin include notes and attachments', async (t) => {
  const { node, view, plugin } = setup(t);
  const note = { id: 'linked.md', x: 10, y: 20, meta: { isAttachment: false } };
  const attachment = { id: 'image.png', x: 30, y: 40, meta: { isAttachment: true } };
  view.nodes = [node, note, attachment];
  view.nodeById = new Map(view.nodes.map((entry) => [entry.id, entry]));
  view.neighborsById = new Map([[node.id, new Set([note.id, attachment.id])]]);
  view.kickLayoutSearch = () => {};
  for (const title of [
    'Pin linked nodes',
    'Pin linked nodes to grid',
    'Pin linked nodes to orbit',
  ]) {
    const linked = item(buildNodeContextMenu(view, node, 10, 20), 'Pin linked').submenu;
    await item(linked, title).callback();
    for (const id of [note.id, attachment.id]) {
      assert.ok(
        title.endsWith('orbit') ? plugin.isOrbitPinned(id) : plugin.isPinned(id),
        `${title}: ${id}`
      );
    }
    const refreshed = item(buildNodeContextMenu(view, node, 10, 20), 'Pin linked').submenu;
    await item(refreshed, 'Unpin linked nodes').callback();
    for (const id of [note.id, attachment.id]) {
      assert.equal(plugin.isPinned(id), false);
      assert.equal(plugin.isOrbitPinned(id), false);
    }
  }
});

test('inapplicable YAML and unpin actions are absent, not disabled', (t) => {
  const { app, view, node, plugin } = setup(t);
  app.metadataCache.getFileCache = () => ({ frontmatter: { path: ' ', url: null } });
  plugin.removeOrbitPin(node.id);
  plugin.removePin('linked.md');
  const menu = buildNodeContextMenu(view, node, 10, 20);
  assert.equal(item(menu, 'Open path'), undefined);
  assert.equal(item(menu, 'Open URL'), undefined);
  assert.equal(item(menu, 'Unpin node'), undefined);
  const linked = item(menu, 'Pin linked').submenu;
  assert.equal(item(linked, 'Unpin node'), undefined);
  assert.equal(item(linked, 'Unpin linked nodes'), undefined);
  app.metadataCache.getFileCache = () => ({ frontmatter: { url: 'https://example.com' } });
  const withUrl = buildNodeContextMenu(view, node, 10, 20);
  assert.ok(item(withUrl, 'Open URL'));
  assert.equal(item(withUrl, 'Open path'), undefined);
});

test('unavailable file and linked actions disappear without leaving empty groups', (t) => {
  const { app, view, node } = setup(t);
  app.vault.getAbstractFileByPath = () => null;
  view.neighborsById.clear();
  const menu = buildNodeContextMenu(view, node, 10, 20);
  for (const title of [
    'Copy system root',
    'Copy',
    'Open',
    'Open URL',
    'Open path',
    'Pin linked',
    'Select linked nodes',
    'Bookmark',
    'Delete',
  ]) {
    assert.equal(item(menu, title), undefined, title);
  }
  assert.deepEqual(titles(item(menu, 'Other').submenu), ['Add to search']);
});

test('already-applied pin modes and disabled native actions are hidden', (t) => {
  const { app, view, node, plugin } = setup(t);
  app.workspace.trigger = (_, menu) =>
    menu.addItem((entry) =>
      entry
        .setTitle('Bookmark...')
        .setDisabled(true)
        .onClick(() => {})
    );
  plugin.setPin(node.id, { x: 0, y: 0 }, { mode: 'exact' });
  const menu = buildNodeContextMenu(view, node, 10, 20);
  assert.equal(item(menu, 'Pin node'), undefined);
  assert.ok(item(menu, 'Pin to grid'));
  assert.ok(item(menu, 'Unpin node'));
  assert.equal(item(menu, 'Bookmark'), undefined);
  assert.equal(item(item(menu, 'Other').submenu, 'Bookmark'), undefined);
  plugin.setPin(node.id, { x: 0, y: 0 }, { mode: 'grid' });
  const grid = buildNodeContextMenu(view, node, 10, 20);
  assert.equal(item(grid, 'Pin to grid'), undefined);
  assert.ok(item(grid, 'Pin node'));
});

test('text-size slider still edits only its node from the Visual settings submenu', (t) => {
  const { menu, node, plugin } = setup(t);
  const size = item(item(menu, 'Visual settings').submenu, 'Text size');
  const input = size.dom.children[0].children[0];
  input.value = '18';
  input.events.input();
  assert.equal(plugin.getNodeLabelSize(node.id), 18);
  assert.equal(plugin.getNodeLabelSize('other.md'), null);
});
