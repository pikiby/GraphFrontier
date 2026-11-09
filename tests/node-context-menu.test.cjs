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
    'Strong pull',
    '---',
    'Select linked nodes',
    'Combine linked',
    '---',
    'Add to list',
    'Other',
    '---',
    'Delete',
  ]);
  assert.deepEqual(titles(item(menu, 'Copy').submenu), [
    'Copy name',
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
    'Node size',
    'Node color',
    'Color aura',
    'Aura brightness',
    'Link width',
    'Link color',
    'Link opacity',
    'Show arrows',
    'Reverse arrows',
    'Text zoom',
    'Text size',
    'Hover dimming',
    'Reset visual settings',
  ]);
  const strongPull = item(menu, 'Strong pull').dom.children[0].children[0];
  assert.deepEqual([strongPull.min, strongPull.max, strongPull.value], ['0', '20', '0']);
  assert.deepEqual(titles(item(menu, 'Other').submenu), [
    'Move file to',
    'Bookmark',
    'Merge entire file with',
    'Add to search',
    'Show local graph',
    'Open local GraphFrontier',
  ]);
  assert.equal(item(menu, 'Delete').warning, true);
});

test('copy and native actions retain their target file and deletion prompts first', async (t) => {
  const { menu, calls, file } = setup(t);
  assert.deepEqual(calls, []);
  await item(item(menu, 'Copy').submenu, 'Copy name').callback();
  await item(menu, 'Copy system root').callback();
  await item(item(menu, 'Copy').submenu, 'From vault folder').callback();
  await item(item(menu, 'Copy').submenu, 'As Obsidian URL').callback();
  await item(item(menu, 'Other').submenu, 'Bookmark').callback();
  await item(item(menu, 'Other').submenu, 'Move file to').callback();
  await item(item(menu, 'Other').submenu, 'Merge entire file with').callback();
  await item(menu, 'Delete').callback();
  assert.deepEqual(calls, [
    'alpha',
    `/vault/${file.path}`,
    file.path,
    ['url', file.path],
    'Bookmark...',
    'Move file to...',
    'Merge entire file with...',
    ['delete', file.path],
  ]);
});

test('Copy name is available for an unlinked node without a file', async (t) => {
  const { view, app, node, calls } = setup(t);
  app.vault.getAbstractFileByPath = () => null;
  view.neighborsById = new Map();
  node.label = 'Node display name';
  const copyMenu = item(buildNodeContextMenu(view, node, 10, 20), 'Copy').submenu;
  assert.deepEqual(titles(copyMenu), ['Copy name']);
  await item(copyMenu, 'Copy name').callback();
  assert.deepEqual(calls, ['Node display name']);
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

test('attachment same-tab opening uses native routing while default-app stays explicit', async (t) => {
  const { app, view, node, file, calls } = setup(t);
  file.extension = 'custom';
  view.leaf = { openFile: async (target) => calls.push(['native', target]) };
  app.openWithDefaultApp = (path) => calls.push(['external', path]);
  let open = item(buildNodeContextMenu(view, node, 10, 20), 'Open').submenu;
  await item(open, 'Open in same tab').callback();
  await item(open, 'Open in default app').callback();
  assert.deepEqual(calls, [
    ['native', file],
    ['external', file.path],
  ]);
  // An unsupported file is handled by openFile itself, not a second menu fallback.
  view.leaf.openFile = async (target) => app.openWithDefaultApp(target.path);
  open = item(buildNodeContextMenu(view, node, 10, 20), 'Open').submenu;
  await item(open, 'Open in same tab').callback();
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.at(-1), ['external', file.path]);
});

test('local GraphFrontier action passes the menu note, not the active note, to owner or plugin', async (t) => {
  const { app, view, node, file, plugin } = setup(t);
  const received = [];
  app.workspace.getActiveFile = () => ({ path: 'other.md', extension: 'md' });
  plugin.openLocalGraphFrontierView = (target) => received.push(['plugin', target]);
  let other = item(buildNodeContextMenu(view, node, 10, 20), 'Other').submenu;
  await item(other, 'Open local GraphFrontier').callback();
  assert.deepEqual(received, [['plugin', file]]);

  view.owner = { openLocalGraphFrontierView: (target) => received.push(['owner', target]) };
  other = item(buildNodeContextMenu(view, node, 10, 20), 'Other').submenu;
  await item(other, 'Open local GraphFrontier').callback();
  assert.deepEqual(received, [
    ['plugin', file],
    ['owner', file],
  ]);
});

test('local GraphFrontier action is absent for missing and non-Markdown files', (t) => {
  const { app, view, node, file } = setup(t);
  file.extension = 'pdf';
  let other = item(buildNodeContextMenu(view, node, 10, 20), 'Other').submenu;
  assert.equal(item(other, 'Open local GraphFrontier'), undefined);
  assert.equal(item(other, 'Show local graph'), undefined);
  app.vault.getAbstractFileByPath = () => null;
  other = item(buildNodeContextMenu(view, node, 10, 20), 'Other').submenu;
  assert.equal(item(other, 'Open local GraphFrontier'), undefined);
  file.extension = 'MD';
  app.vault.getAbstractFileByPath = () => file;
  other = item(buildNodeContextMenu(view, node, 10, 20), 'Other').submenu;
  assert.ok(item(other, 'Open local GraphFrontier'));
});

test('local GraphFrontier action keeps the snapshot guard on stale graph state', async (t) => {
  const { view, node, plugin } = setup(t);
  let calls = 0;
  plugin.openLocalGraphFrontierView = () => {
    calls++;
  };
  const other = item(buildNodeContextMenu(view, node, 10, 20), 'Other').submenu;
  view.nodeById.delete(node.id);
  await item(other, 'Open local GraphFrontier').callback();
  assert.equal(calls, 0);
});

test('quick-open arrays keep per-node selection scope, exact targets and stale action guards', async (t) => {
  const { view, app, node, plugin } = setup(t);
  const opened = [];
  const frontmatter = {
    url: ['[Dashboard](https://example.com/a_(b))', 'https://example.org/report'],
    path: ['[Schema](Schemas/my schema (v2).sql)', 'Other/schema.sql'],
  };
  app.metadataCache.getFileCache = () => ({ frontmatter });
  view.contentEl.win.open = (target) => opened.push(target);
  app.workspace.getLeaf = () => ({ openFile: async (file) => opened.push(file.path) });
  app.vault.getAbstractFileByPath = (target) => ({ path: target, extension: 'sql' });
  view.selectedNodeIds = new Set([node.id, 'linked.md']);
  const selection = buildNodeContextMenu(view, node, 10, 20);
  assert.equal(item(selection, 'Open URL'), undefined, 'never open every selected note');
  const only = selection.items.find((entry) => entry.title?.startsWith('Only for ')).submenu;
  const urls = item(only, 'Open URL').submenu;
  const paths = item(only, 'Open path').submenu;
  assert.deepEqual(titles(urls), ['Dashboard', 'example.org/report']);
  assert.deepEqual(titles(paths), ['Schema', 'schema.sql']);
  assert.equal(paths.items[0].dom.attributes.title, 'Schemas/my schema (v2).sql');
  frontmatter.url[0] = 'https://different.example';
  await urls.items[0].callback();
  await paths.items[0].callback();
  assert.deepEqual(opened, ['https://example.com/a_(b)', 'Schemas/my schema (v2).sql']);
  view.nodeById.delete(node.id);
  await urls.items[1].callback();
  assert.equal(opened.length, 2);
  view.nodeById.set(node.id, node);
  plugin.data.active_layout_name = 'other.json';
  await urls.items[1].callback();
  assert.equal(opened.length, 2, 'switching layouts invalidates existing choices');
});

test('navigation aliases starting with Pin or Unpin never dispatch position actions', async (t) => {
  const { view, app, node, writes } = setup(t);
  const opened = [];
  const longTarget = `https://example.com/${'report'.repeat(20)}`;
  app.metadataCache.getFileCache = () => ({
    frontmatter: {
      url: [
        '[Pin dashboard](https://example.com/dashboard)',
        '[Unpin project](https://example.com/project)',
        '[<img src=x onerror=alert(1)>](https://example.com/plain)',
        longTarget,
      ],
    },
  });
  view.contentEl.win.open = (target) => opened.push(target);
  view.runPositionAction = () => assert.fail('A label is not a position command');
  view.kickLayoutSearch = () => assert.fail('Navigation must not wake physics');
  const urls = item(buildNodeContextMenu(view, node, 10, 20), 'Open URL').submenu;
  assert.equal(urls.items[2].title, '<img src=x onerror=alert(1)>');
  assert.equal(urls.items[2].dom.innerHTML, undefined);
  assert.ok(urls.items[3].title.endsWith('...'));
  assert.equal(urls.items[3].dom.attributes.title, longTarget);
  for (const entry of urls.items) await entry.callback();
  assert.deepEqual(opened, [
    'https://example.com/dashboard',
    'https://example.com/project',
    'https://example.com/plain',
    longTarget,
  ]);
  assert.equal(writes.length, 0);
});

test('single URL and path aliases remain visible in submenus for scalars and lists', async (t) => {
  const { view, app, node } = setup(t);
  const opened = [];
  view.contentEl.win.open = (target) => opened.push(target);
  app.vault.getAbstractFileByPath = (target) => ({ path: target, extension: 'md' });
  app.workspace.getLeaf = () => ({ openFile: async (file) => opened.push(file.path) });
  for (const array of [false, true]) {
    const wrap = (value) => (array ? [value] : value);
    app.metadataCache.getFileCache = () => ({
      frontmatter: {
        url: wrap('[grafana](https://example.com/dashboard)'),
        path: wrap('[Project](Projects/my project.md)'),
      },
    });
    const menu = buildNodeContextMenu(view, node, 10, 20);
    for (const [title, label, target] of [
      ['Open URL', 'grafana', 'https://example.com/dashboard'],
      ['Open path', 'Project', 'Projects/my project.md'],
    ]) {
      const parent = item(menu, title);
      assert.equal(parent.callback, undefined, 'parent never opens the only target');
      assert.deepEqual(titles(parent.submenu), [label]);
      const choice = parent.submenu.items[0];
      assert.equal(choice.dom.attributes.title, target);
      await choice.callback();
      assert.equal(opened.at(-1), target);
    }
  }
  assert.equal(opened.length, 4);
});

test('Combine linked sits beside Select linked nodes; selection menus start with Combine', async (t) => {
  const { view, node, menu } = setup(t);
  const titlesList = titles(menu);
  const index = titlesList.indexOf('Select linked nodes');
  assert.equal(titlesList[index + 1], 'Combine linked');
  const combine = item(menu, 'Combine linked');
  assert.equal(combine.icon, 'group');
  let opened;
  t.mock.method(view, 'editSubgraph', (_, snapshot) => (opened = snapshot.ids));
  combine.callback();
  assert.deepEqual(opened, [node.id, 'linked.md'], 'the node and its links');

  view.selectedNodeIds = new Set([node.id, 'linked.md']);
  const selection = buildNodeContextMenu(view, node, 10, 20);
  assert.equal(titles(selection)[0], 'Combine into subgraph');
  assert(!titles(selection).some((title) => / · \d+ nodes/.test(title)), 'no node counts');

  view.selectedNodeIds = new Set();
  view.neighborsById = new Map();
  const lonely = buildNodeContextMenu(view, node, 10, 20);
  assert(!titles(lonely).some((title) => /Combine/.test(title)), 'nothing to combine with');
});

test('Add URL or path writes an empty YAML property and opens the note on that line', async (t) => {
  const { app, view, file } = setup(t);
  const frontmatter = { tags: ['x'] };
  app.metadataCache.getFileCache = () => ({ frontmatter });
  app.fileManager.processFrontMatter = async (_, change) => change(frontmatter);
  app.vault.read = async () => '---\ntags: [x]\nurl:\n---\nbody';
  let opened;
  const cursor = {};
  let source = true;
  app.workspace.getLeaf = () => ({
    openFile: async (target, state) => (opened = [target.path, state]),
    getViewState: () => ({ state: { source } }),
    view: {
      editor: {
        getLine: () => 'url:',
        setCursor: (position) => Object.assign(cursor, position),
        focus() {},
      },
    },
  });
  const menu = buildNodeContextMenu(view, view.nodeById.get(file.path), 10, 20);
  const addMenu = item(menu, 'Add URL or path').submenu;
  assert.deepEqual(titles(addMenu), ['URL', 'Folder path']);
  assert.match(item(addMenu, 'URL').dom.attributes.title, /'\[Label\]\(target\)'/);
  await item(addMenu, 'URL').callback();
  assert.equal(frontmatter.url, null);
  assert.deepEqual(opened, [file.path, { eState: { line: 2 } }], "the reader's own view mode");
  assert.deepEqual(cursor, { line: 2, ch: 4 }, 'source mode puts the cursor on the line');
  source = false;
  delete cursor.line;
  await item(addMenu, 'Folder path').callback();
  assert.equal(frontmatter.path, null);
  assert.equal(cursor.line, undefined, 'Live Preview and Reading leave the cursor alone');

  frontmatter.url = 'https://example.com';
  frontmatter.path = '/project';
  const full = buildNodeContextMenu(view, view.nodeById.get(file.path), 10, 20);
  assert.equal(item(full, 'Add URL or path'), undefined);
  assert.deepEqual(titles(item(full, 'Open URL').submenu).at(-1), 'Edit');
  assert.match(item(item(full, 'Open URL').submenu, 'Edit').dom.attributes.title, /Alias/);
});
