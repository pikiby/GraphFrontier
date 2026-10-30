const test = require('node:test');
const { mobileVault } = require('./helpers/mobile-vault.cjs');
const assert = require('node:assert/strict');
const { fixture, loadSource, deferred } = require('./helpers/obsidian.cjs');
const { GraphFrontierApi } = loadSource('api.js');
const { EXTENDED_TOOLS } = require('../src/api-tools');
const { DEFAULT_DATA } = require('../src/constants');
const { GraphFrontierView } = loadSource('view.js');
const { darkEnergyNodes } = require('../src/dark-energy');

function setup(t) {
  const f = fixture(t, { settings: { hide_orphans: false, hide_attachments: false } });
  const dirs = new Set();
  f.adapter.mkdir = async (name) => {
    dirs.add(name);
  };
  f.adapter.exists = async (name) => f.files.has(name) || dirs.has(name);
  f.adapter.remove = async (name) => {
    assert.ok(f.files.has(name));
    f.files.delete(name);
  };
  f.adapter.list = async (name) => ({
    files: [...f.files.keys()].filter(
      (p) => p.startsWith(`${name}/`) && !p.slice(name.length + 1).includes('/')
    ),
    folders: [],
  });
  f.app.vault.getName = () => 'Test';
  f.app.vault.getAbstractFileByPath = (id) => ({ path: id, extension: 'md' });
  f.app.vault.cachedRead = async () => '# PRIVATE NOTE';
  f.graph.nodes = ['alpha', 'beta', 'gamma'].map((n, i) => ({
    id: `${n}.md`,
    label: n,
    x: i * 100,
    y: 0,
    meta: {
      path: `${n}.md`,
      fileName: `${n}.md`,
      tags: i < 2 ? ['#keep'] : ['#other'],
      properties: new Map(),
      lines: ['hello'],
      sections: ['heading'],
    },
  }));
  f.graph.edges = [
    { source: 'alpha.md', target: 'beta.md' },
    { source: 'beta.md', target: 'gamma.md' },
  ];
  f.plugin.collectGraphData = () => ({
    ...f.graph,
    nodes: [...f.graph.nodes, ...darkEnergyNodes(f.plugin.data.dark_energy)],
  });
  f.view.refreshFromVault({ keepCamera: true });
  f.view.viewWidth = 800;
  f.view.viewHeight = 600;
  f.putLayout(f.plugin.data);
  f.api = new GraphFrontierApi(f.plugin);
  f.ref = () => {
    const v = f.api.listViews().views[0];
    return { viewId: v.viewId, contextToken: v.contextToken };
  };
  return f;
}

test('export locations describe the vault without accessing the desktop filesystem', async (t) => {
  const f = setup(t);
  Object.defineProperty(f.view.contentEl.win, 'require', {
    get() {
      return assert.fail('Location discovery must not use Node');
    },
  });
  assert.deepEqual(await f.api.getExportLocations(f.ref()), {
    vault: 'Test',
    home: null,
    desktop: null,
    vaultRelative: true,
  });
});

test('every current global setting has a typed MCP field; invalid patches are atomic', (t) => {
  const f = setup(t),
    definition = EXTENDED_TOOLS.find((t) => t.name === 'update_settings');
  assert.deepEqual(
    Object.keys(definition.schema.shape.settings.shape).sort(),
    Object.keys(DEFAULT_DATA.settings).sort()
  );
  const before = structuredClone(f.plugin.data);
  for (const settings of [
    { node_color: 'red' },
    { attachment_node_color: 'red' },
    { damping: 2 },
    { layout_autosave: 'false' },
    { unknown: 1 },
    { attachment_size_multiplier: 0.8 },
    { attachment_link_distance_multiplier: 14 },
    { attachments_on_orbits: false },
    JSON.parse('{"__proto__":{}}'),
  ])
    assert.throws(() => f.api.updateSettings({ ...f.ref(), settings }), {
      code: 'INVALID_ARGUMENT',
    });
  assert.deepEqual(f.plugin.data, before);
  f.api.updateSettings({
    ...f.ref(),
    settings: { node_color: '#aabbcc', damping: 0.5, layout_autosave: true, repel_strength: 15 },
  });
  assert.equal(f.plugin.data.settings.node_color, '#aabbcc');
  f.api.updateSettings({ ...f.ref(), settings: { attachment_node_color: '#123456' } });
  assert.equal(f.plugin.data.settings.attachment_node_color, '#123456');
  f.api.updateSettings({ ...f.ref(), settings: { attachment_node_color: null } });
  assert.equal(f.plugin.data.settings.attachment_node_color, null);
  assert.equal(f.view.layoutPaused, false);
  assert.equal(f.view.layoutAutosaveDirty, true);
  f.api.updateSettings({ ...f.ref(), settings: { layout_autosave: false } });
  assert.equal(f.plugin.data.settings.layout_autosave, false);
  assert.equal(f.writes.length, 0, 'No implicit layout writes when patching settings');
});

test('node visuals inherit, override, reset and validate the entire batch before applying', (t) => {
  const f = setup(t);
  const nodeIds = ['alpha.md', 'beta.md'];
  f.api.updateNodeSettings({
    ...f.ref(),
    nodeIds,
    settings: {
      node_color: '#ff0000',
      aura_radius: 1500,
      aura_brightness: 40,
      label_font_size: 15,
    },
    edgeColor: '#00ff00',
    strongPull: true,
  });
  let result = f.api.getNodeSettings({ ...f.ref(), nodeIds });
  assert.equal(result.nodes[0].effective.node_color, '#ff0000');
  assert.equal(result.nodes[1].effective.label_font_size, 15);
  assert.equal(result.nodes[0].strongPull, true);
  assert.throws(
    () =>
      f.api.updateNodeSettings({
        ...f.ref(),
        nodeIds: ['alpha.md', 'missing'],
        settings: { node_color: '#000000' },
      }),
    { code: 'NODE_NOT_FOUND' }
  );
  assert.equal(f.plugin.data.node_visual_settings['alpha.md'].node_color, '#ff0000');
  f.api.updateNodeSettings({ ...f.ref(), nodeIds, settings: {}, reset: true, strongPull: false });
  result = f.api.getNodeSettings({ ...f.ref(), nodeIds });
  assert.equal(result.nodes[0].effective.node_color, f.plugin.getSettings().node_color);
  assert.equal(result.nodes[0].edgeColor, null);
  assert.equal(result.nodes[0].multiplier, 1);
});

test('blacklist/whitelist/group CRUD invalidates visibility and preserves untouched rows', (t) => {
  const f = setup(t);
  let r = f.api.editRules({
    ...f.ref(),
    list: 'blacklist',
    action: 'add',
    rules: [{ query: 'name:alpha' }],
  });
  assert.deepEqual(
    f.api.getGraph(f.ref()).items.map((n) => n.id),
    ['beta.md', 'gamma.md']
  );
  f.api.editRules({
    ...f.ref(),
    list: 'blacklist',
    action: 'update',
    rules: [{ ...r.rules[0], enabled: false }],
  });
  assert.equal(f.api.getGraph(f.ref()).items.length, 3);
  f.api.editRules({
    ...f.ref(),
    list: 'whitelist',
    action: 'replace',
    rules: [{ query: 'tag:keep' }],
  });
  assert.equal(f.api.getGraph(f.ref()).items.length, 2);
  f.api.editRules({ ...f.ref(), list: 'blacklist', action: 'remove', ids: [r.rules[0].id] });
  f.api.editRules({ ...f.ref(), list: 'whitelist', action: 'clear' });
  r = f.api.editRules({
    ...f.ref(),
    list: 'groups',
    action: 'add',
    rules: [{ query: 'name:alpha', color: '#112233' }],
  });
  assert.equal(f.view.getGroupColorForNode(f.view.nodes[0]), '#112233');
  assert.throws(
    () =>
      f.api.editRules({
        ...f.ref(),
        list: 'groups',
        action: 'add',
        rules: [{ query: 'invalid', color: '#ffffff' }],
      }),
    { code: 'INVALID_ARGUMENT' }
  );
  assert.equal(f.plugin.data.groups.length, 1);
  assert.ok(r.rules[0].id);
});

test('typed search, highlighting and exact induced subgraph use existing matchers', (t) => {
  const f = setup(t);
  assert.deepEqual(f.api.searchNodes({ ...f.ref(), query: 'tag:keep' }).nodeIds, [
    'alpha.md',
    'beta.md',
  ]);
  f.api.setSearch({ ...f.ref(), query: 'tag:keep', mode: 'find', showConnections: true });
  assert.equal(f.view.getSearchHighlightNodeIds().size, 2);
  f.api.setVisibleNodes({ ...f.ref(), nodeIds: ['alpha.md', 'beta.md'] });
  assert.equal(f.api.getGraph({ ...f.ref(), kind: 'edges' }).items.length, 1);
  f.api.setVisibleNodes({ ...f.ref(), nodeIds: [] });
  assert.equal(f.api.getGraph(f.ref()).items.length, 0);
  f.api.setVisibleNodes({ ...f.ref(), nodeIds: null });
  assert.equal(f.api.getGraph(f.ref()).items.length, 3);
  f.api.setSearch({ ...f.ref(), query: '', mode: 'find' });
  assert.equal(f.view.isSearchFilled(), false);
});

test('camera can be restored exactly; node movement preserves pin modes and validates coordinates', async (t) => {
  const f = setup(t),
    before = { ...f.view.camera };
  f.api.setCamera({ ...f.ref(), camera: { x: 70, y: 80, zoom: 2 } });
  assert.deepEqual(f.view.camera, f.view.cameraTarget);
  f.api.setCamera({ ...f.ref(), camera: before });
  assert.deepEqual(f.view.camera, before);
  await f.api.pinNodes({ ...f.ref(), nodeIds: ['alpha.md'], mode: 'exact' });
  await f.api.moveNodes({ ...f.ref(), positions: [{ id: 'alpha.md', x: 17, y: 29 }] });
  assert.equal(f.plugin.getPin('alpha.md').x, 17);
  await assert.rejects(
    f.api.moveNodes({
      ...f.ref(),
      positions: [
        { id: 'alpha.md', x: 4, y: 5 },
        { id: 'missing', x: 0, y: 0 },
      ],
    }),
    { code: 'NODE_NOT_FOUND' }
  );
  assert.equal(f.view.nodeById.get('alpha.md').x, 17);
  await f.api.pinNodes({ ...f.ref(), anchorId: 'beta.md', mode: 'orbit' });
  assert.ok(f.plugin.getOrbitPin('alpha.md'));
  await f.api.pinNodes({ ...f.ref(), all: true, mode: 'none' });
  assert.deepEqual(f.plugin.data.orbit_pins, {});
});

test('gravity creation/edit/removal reuses runtime nodes and rejects invalid rules', (t) => {
  const f = setup(t);
  const created = f.api.gravityNodes({
    ...f.ref(),
    action: 'create',
    name: 'Keep',
    queries: ['tag:keep'],
    strength: 20,
    repulsion: 15,
    x: 50,
    y: 60,
  });
  assert.ok(f.view.nodeById.has(created.gravity.id));
  assert.throws(
    () =>
      f.api.updateNodeSettings({
        ...f.ref(),
        nodeIds: [created.gravity.id],
        settings: {},
        strongPull: true,
      }),
    { code: 'INVALID_ARGUMENT' }
  );
  f.api.gravityNodes({ ...f.ref(), action: 'update', id: created.gravity.id, strength: 2, x: 10 });
  assert.equal(f.plugin.data.dark_energy[0].strength, 2);
  assert.equal(f.view.nodeById.get(created.gravity.id).x, 10);
  f.api.gravityNodes({ ...f.ref(), action: 'delete', id: created.gravity.id });
  assert.equal(f.view.nodeById.has(created.gravity.id), false);
});

test('layouts round-trip settings, positions, search, exact subset and camera; copies remain separate', async (t) => {
  const f = setup(t);
  f.api.updateSettings({ ...f.ref(), settings: { node_color: '#112233' } });
  f.api.setCamera({ ...f.ref(), camera: { x: 12, y: 34, zoom: 2 } });
  f.api.setVisibleNodes({ ...f.ref(), nodeIds: ['alpha.md', 'beta.md'] });
  f.api.setSearch({ ...f.ref(), query: 'tag:keep', mode: 'find' });
  await f.api.createLayout({ ...f.ref(), name: 'test-layout' });
  assert.equal(f.plugin.getActiveLayoutFileName(), 'test-layout.json');
  f.api.updateSettings({ ...f.ref(), settings: { node_color: '#ffffff' } });
  await f.api.saveLayout(f.ref());
  assert.equal((await f.api.listBackups({ name: 'test-layout' })).items.length, 1);
  await f.api.loadLayout({ ...f.ref(), name: 'data' });
  assert.equal(f.plugin.getSettings().node_color, DEFAULT_DATA.settings.node_color);
  assert.equal(f.view.apiVisibleNodeIds, null);
  await f.api.loadLayout({ ...f.ref(), name: 'test-layout' });
  assert.equal(f.plugin.getSettings().node_color, '#ffffff');
  assert.deepEqual(f.view.camera, { x: 12, y: 34, zoom: 2 });
  assert.equal(f.view.searchInputValue, 'tag:keep');
  assert.equal(f.view.apiVisibleNodeIds.size, 2);
  assert.equal((await f.api.listLayouts()).layouts.length, 2);
});

test('backup ensure deduplicates unchanged versions; delete and restore do not destroy backups', async (t) => {
  const f = setup(t);
  await f.api.createLayout({ ...f.ref(), name: 'copy', activate: false });
  const b = await f.api.backupLayout({ ...f.ref(), name: 'copy', ensure: true });
  assert.equal(
    (await f.api.backupLayout({ ...f.ref(), name: 'copy', ensure: true })).backupId,
    b.backupId
  );
  await f.api.deleteLayout({ ...f.ref(), name: 'copy' });
  assert.equal(f.files.has(f.layoutPath('copy.json')), false);
  await f.api.restoreLayout({ ...f.ref(), backupId: b.backupId, name: 'restored' });
  assert.equal(f.plugin.getActiveLayoutFileName(), 'restored.json');
  assert.equal((await f.api.listBackups()).items.length, 1);
  f.api.updateSettings({ ...f.ref(), settings: { node_color: '#112233' } });
  await f.api.saveLayout(f.ref());
  await f.api.restoreLayout({ ...f.ref(), backupId: b.backupId, name: 'restored' });
  assert.equal(f.plugin.getSettings().node_color, DEFAULT_DATA.settings.node_color);
  assert.ok((await f.api.listBackups({ name: 'restored' })).items.length >= 2);
});

test('file safety: traversal, aliases, overwrite, corrupt fallback and failed backup cannot delete layouts', async (t) => {
  const f = setup(t);
  for (const name of [
    '../x',
    '/tmp/x',
    '.',
    'a/b',
    'a\\b',
    'CON',
    '../data.json',
    '\u0413\u0440\u0430\u0444',
  ])
    await assert.rejects(f.api.createLayout({ ...f.ref(), name }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(f.api.createLayout({ ...f.ref(), name: 'data' }), { code: 'LAYOUT_EXISTS' });
  await assert.rejects(f.api.deleteLayout({ ...f.ref(), name: 'data' }), {
    code: 'LAYOUT_DELETE_FAILED',
  });
  f.files.set(f.layoutPath('broken.json'), '{');
  const original = f.files.get(f.layoutPath());
  await assert.rejects(f.api.deleteLayout({ ...f.ref(), name: 'data' }), {
    code: 'LAYOUT_DELETE_FAILED',
  });
  assert.equal(f.files.get(f.layoutPath()), original);
  await f.api.createLayout({ ...f.ref(), name: 'good', activate: false });
  const write = f.adapter.write;
  f.adapter.write = async (p, s) => {
    if (p.includes('/backups/')) throw Error('disk full');
    return write(p, s);
  };
  await assert.rejects(f.api.deleteLayout({ ...f.ref(), name: 'good' }), /disk full/);
  assert.ok(f.files.has(f.layoutPath('good.json')));
});

test('stale queued operations and unloaded API cannot modify a different layout', async (t) => {
  const f = setup(t),
    gate = deferred(),
    ref = f.ref();
  f.api.operation = gate.promise;
  const request = f.api.runTool('updateSettings', { ...ref, settings: { damping: 0.8 } }, false);
  f.plugin.data = f.plugin.normalizeData(f.plugin.data);
  gate.resolve();
  await assert.rejects(request, { code: 'STATE_CHANGED' });
  assert.equal(f.plugin.getSettings().damping, DEFAULT_DATA.settings.damping);
  f.api.close();
  assert.throws(() => f.api.updateSettings({ ...f.ref(), settings: {} }), { code: 'API_CLOSED' });
});

test('UI state/hotkeys, pause/resume and copying linked names reuse plugin functions', async (t) => {
  const f = setup(t);
  f.api.updateUi({
    ...f.ref(),
    panelOpen: false,
    sections: { physics: false },
    commandId: 'graphfrontier-clear-selection',
    hotkey: 'Ctrl+K',
  });
  assert.equal(f.view.sidePanelOpen, false);
  assert.equal(f.plugin.getSidePanelSectionsState().physics, false);
  assert.equal(f.plugin.getCommandHotkey('graphfrontier-clear-selection'), 'Mod+K');
  await f.api.graphAction({ ...f.ref(), action: 'pause' });
  assert.equal(f.view.layoutPaused, true);
  await f.api.graphAction({ ...f.ref(), action: 'resume' });
  assert.equal(f.view.layoutPaused, false);
  const copied = await f.api.nodeAction({
    ...f.ref(),
    nodeId: 'beta.md',
    action: 'copy_linked_names',
  });
  assert.equal(copied.text, 'alpha,\ngamma');
  assert.equal(copied.copied, false);
});

test('path copies require existing files and linked paths exclude non-files', async (t) => {
  const f = setup(t);
  const { vault, file, folder } = mobileVault(t, false);
  Object.assign(f.app.vault, vault);
  file('alpha.md');
  file('beta.md');
  folder('folder');
  f.app.vault.adapter.getFullPath = (path) => `/vault/${path}`;
  const gravity = 'graphfrontier:dark-energy:g';
  const subgraph = 'graphfrontier:subgraph:s';
  for (const id of [gravity, subgraph, 'missing.md', 'folder'])
    f.view.nodeById.set(id, { id, label: `label ${id}` });
  const clipboard = t.mock.method(f.view, 'copyTextToClipboard', async () => true);
  for (const [action, text] of [
    ['copy_path', 'alpha.md'],
    ['copy_system_path', '/vault/alpha.md'],
    ['copy_obsidian_url', 'obsidian://open?vault=Test%20vault&file=alpha.md'],
  ]) {
    assert.deepEqual(
      await f.api.nodeAction({ ...f.ref(), nodeId: 'alpha.md', action, clipboard: true }),
      {
        text,
        copied: true,
      }
    );
    const count = clipboard.mock.callCount();
    for (const nodeId of [gravity, subgraph, 'missing.md', 'folder', 'unknown.md']) {
      await assert.rejects(f.api.nodeAction({ ...f.ref(), nodeId, action, clipboard: true }), {
        code: 'NODE_NOT_FOUND',
      });
      assert.equal(clipboard.mock.callCount(), count);
    }
  }
  for (const nodeId of [gravity, subgraph])
    assert.equal(
      (await f.api.nodeAction({ ...f.ref(), nodeId, action: 'copy_name' })).text,
      `label ${nodeId}`
    );
  t.mock.method(f.view, 'getLinkedNodeIds', () => [
    'beta.md',
    gravity,
    subgraph,
    'missing.md',
    'folder',
  ]);
  assert.equal(
    (await f.api.nodeAction({ ...f.ref(), nodeId: 'alpha.md', action: 'copy_linked_paths' })).text,
    'beta.md'
  );
});

test('export writes a working HTML induced subgraph, excludes unrequested contents and refuses overwrite', async (t) => {
  const f = setup(t);
  const { vault, contents, file } = mobileVault(t, false);
  Object.assign(f.app.vault, vault);
  for (const node of f.view.nodes) file(node.id, '# PRIVATE NOTE');
  f.view.contentEl.win.require = () => assert.fail('Export must not use Node');
  f.view.canvasEl = { clientWidth: 800, clientHeight: 600 };
  f.view.ctx = {};
  f.view.updateCanvasBackgroundColor = GraphFrontierView.prototype.updateCanvasBackgroundColor;
  const target = 'Exports/schema.html';
  const result = await f.api.exportHtml({
    ...f.ref(),
    path: target,
    nodeIds: ['alpha.md', 'beta.md'],
    includeContents: false,
  });
  assert.equal(result.nodeCount, 2);
  assert.equal(result.edgeCount, 1);
  const html = contents.get(target);
  assert.ok(html.startsWith('<!doctype html>'));
  assert.equal(html.includes('PRIVATE NOTE'), false);
  assert.equal(html.includes('gamma.md'), false);
  await assert.rejects(f.api.exportHtml({ ...f.ref(), path: target }), { code: 'EXPORT_FAILED' });
  assert.equal(contents.get(target), html);
  await f.api.exportHtml({ ...f.ref(), path: target, overwrite: true, includeContents: true });
  assert.ok(contents.get(target).includes('PRIVATE NOTE'));
  assert.equal(f.plugin.getSettings().export_static_html_path, '');
});

test('backup failure precedes save, and save is serialized with a layout switch', async (t) => {
  const f = setup(t),
    before = f.files.get(f.layoutPath());
  const write = f.adapter.write;
  f.adapter.write = async (p, s) => {
    if (p.includes('/backups/')) throw Error('backup failed');
    return write(p, s);
  };
  await assert.rejects(f.api.saveLayout(f.ref()), /backup failed/);
  assert.equal(f.files.get(f.layoutPath()), before);
  f.adapter.write = write;
  await f.api.createLayout({ ...f.ref(), name: 'second', activate: false });
  const gate = deferred();
  f.plugin._layoutFileOperation = gate.promise;
  const loading = f.view.loadSavedLayout({ layoutFileName: 'second', silent: true });
  const pending = f.api.saveLayout(f.ref());
  gate.resolve();
  assert.equal(await loading, true);
  await assert.rejects(pending, { code: 'LAYOUT_WRITE_FAILED' });
});

test('partial rule updates and explicit multi-node highlighting preserve unrelated settings', (t) => {
  const f = setup(t);
  const created = f.api.editRules({
    ...f.ref(),
    list: 'groups',
    action: 'add',
    rules: [{ query: 'name:alpha', color: '#112233' }],
  });
  const rule = created.rules[0];
  f.api.editRules({
    ...f.ref(),
    list: 'groups',
    action: 'update',
    rules: [{ id: rule.id, color: '#ff0000' }],
  });
  assert.equal(f.plugin.data.groups[0].query, 'name:alpha');
  assert.equal(f.plugin.data.groups[0].color, '#ff0000');
  f.api.highlightNodes({ ...f.ref(), nodeIds: ['alpha.md', 'gamma.md'] });
  assert.deepEqual([...f.view.getSearchHighlightNodeIds()], ['alpha.md', 'gamma.md']);
  f.api.highlightNodes({ ...f.ref(), nodeIds: [] });
  assert.equal(f.view.getSearchHighlightNodeIds(), null);
});

test('global link-distance minimum survives save normalization and deleted active layout loads fallback', async (t) => {
  const f = setup(t);
  f.api.updateSettings({ ...f.ref(), settings: { link_distance: 1 } });
  await f.api.createLayout({ ...f.ref(), name: 'active' });
  assert.equal(f.plugin.getSettings().link_distance, 1);
  await f.api.deleteLayout({ ...f.ref(), name: 'active' });
  assert.equal(f.plugin.getActiveLayoutFileName(), 'data.json');
  assert.equal((await f.api.listBackups({ name: 'active' })).items.length, 1);
});

test('an exact subset and camera persist when the graph tab is reopened', async (t) => {
  const f = setup(t);
  f.api.setVisibleNodes({ ...f.ref(), nodeIds: ['beta.md'] });
  f.api.setCamera({ ...f.ref(), camera: { x: 15, y: 25, zoom: 1.5 } });
  f.api.setSearch({ ...f.ref(), query: 'name:beta', mode: 'filter' });
  await f.api.saveLayout(f.ref());
  f.view.apiVisibleNodeIds = null;
  f.view.searchInputValue = 'name:';
  f.view.camera = { x: 0, y: 0, zoom: 1 };
  await f.view.onOpen();
  assert.deepEqual(f.view.camera, { x: 15, y: 25, zoom: 1.5 });
  assert.deepEqual([...f.view.getFilterVisibleNodeIds()], ['beta.md']);
});

test('export checks context again before writing after an asynchronous content read', async (t) => {
  const f = setup(t);
  const { vault, contents, file } = mobileVault(t, false);
  Object.assign(f.app.vault, vault);
  for (const node of f.view.nodes) file(node.id, '# PRIVATE NOTE');
  f.view.contentEl.win.require = () => assert.fail('Export must not use Node');
  f.view.canvasEl = { clientWidth: 800, clientHeight: 600 };
  f.view.ctx = {};
  f.view.updateCanvasBackgroundColor = GraphFrontierView.prototype.updateCanvasBackgroundColor;
  f.app.vault.cachedRead = async () => {
    f.plugin.data = f.plugin.normalizeData(f.plugin.data);
    return 'changed';
  };
  const target = 'stale.html';
  await assert.rejects(f.api.exportHtml({ ...f.ref(), path: target }), { code: 'STATE_CHANGED' });
  assert.equal(contents.has(target), false);
});

test('a valid backup can recover a corrupt destination, preserving its damaged bytes separately', async (t) => {
  const f = setup(t);
  const saved = await f.api.backupLayout({ ...f.ref(), name: 'data' });
  f.files.set(f.layoutPath(), '{damaged');
  await f.api.restoreLayout({ ...f.ref(), backupId: saved.backupId });
  assert.doesNotThrow(() => JSON.parse(f.files.get(f.layoutPath())));
  const backups = (await f.api.listBackups()).items;
  assert.equal(backups.length, 2);
  const damaged = backups.find((b) => !b.validLayout);
  assert.ok(damaged);
  const item = JSON.parse(f.files.get(`${f.api.backupDir()}/${damaged.backupId}`));
  assert.equal(item.contents, '{damaged');
  await assert.rejects(f.api.restoreLayout({ ...f.ref(), backupId: damaged.backupId }), {
    code: 'BACKUP_READ_FAILED',
  });
});

test('removed individual attachment multiplier is rejected atomically by the API', (t) => {
  const f = setup(t);
  const before = structuredClone(f.plugin.data);
  assert.throws(
    () =>
      f.api.updateNodeSettings({
        ...f.ref(),
        nodeIds: ['alpha.md'],
        settings: { node_size_scale: 2, attachment_size_multiplier: 0.8 },
      }),
    { code: 'INVALID_ARGUMENT' }
  );
  assert.deepEqual(f.plugin.data, before);
});

test('attachment exclusions API validates atomically, normalizes and rebuilds graph data', (t) => {
  const f = setup(t);
  const refresh = t.mock.method(f.view, 'refreshFromVault', () => {});
  for (const value of ['png', null, [1], {}]) {
    assert.throws(() =>
      f.api.updateSettings({
        ...f.ref(),
        settings: {
          hide_attachments: true,
          excluded_attachment_extensions: value,
        },
      })
    );
    assert.equal(f.plugin.data.settings.hide_attachments, false);
    assert.deepEqual(f.plugin.data.settings.excluded_attachment_extensions, []);
  }
  f.api.updateSettings({
    ...f.ref(),
    settings: {
      excluded_attachment_extensions: ['PNG', ' png ', '', 'missing'],
    },
  });
  assert.deepEqual(f.plugin.data.settings.excluded_attachment_extensions, ['png', '', 'missing']);
  assert.equal(refresh.mock.callCount(), 1);
});

test('include unlinked attachments is a boolean API setting that rebuilds graph data', (t) => {
  const f = setup(t);
  const refresh = t.mock.method(f.view, 'refreshFromVault', () => {});
  assert.throws(() =>
    f.api.updateSettings({
      ...f.ref(),
      settings: { include_unlinked_attachments: 'true' },
    })
  );
  assert.equal(f.plugin.data.settings.include_unlinked_attachments, false);
  for (const value of [true, false]) {
    const before = refresh.mock.callCount();
    f.api.updateSettings({ ...f.ref(), settings: { include_unlinked_attachments: value } });
    assert.equal(f.plugin.data.settings.include_unlinked_attachments, value);
    assert.equal(refresh.mock.callCount(), before + 1);
  }
});

test('path actions distinguish reserved prefixes from similar real filenames and never copy on failure', async (t) => {
  const f = setup(t);
  const { vault, file, folder } = mobileVault(t, false);
  Object.assign(f.app.vault, vault);
  const valid = [
    'graphfrontier:dark-energy-other.md',
    'graphfrontier:subgraph-other.md',
    'assets/README',
  ];
  const reserved = ['graphfrontier:dark-energy:real.md', 'graphfrontier:subgraph:real.md'];
  for (const id of [...valid, ...reserved]) {
    const entry = file(id);
    if (id === 'assets/README') entry.extension = '';
    f.view.nodeById.set(id, { id, label: id });
  }
  folder('assets/folder');
  f.view.nodeById.set('assets/folder', { id: 'assets/folder', label: 'folder' });
  f.view.nodeById.set('assets/missing.md', { id: 'assets/missing.md', label: 'missing' });
  const clipboard = t.mock.method(f.view, 'copyTextToClipboard', async () => true);
  for (const id of valid) {
    assert.deepEqual(await f.api.nodeAction({ ...f.ref(), nodeId: id, action: 'copy_path' }), {
      text: id,
      copied: false,
    });
  }
  assert.equal(clipboard.mock.callCount(), 0);
  for (const id of [...reserved, 'assets/folder', 'assets/missing.md']) {
    await assert.rejects(
      f.api.nodeAction({ ...f.ref(), nodeId: id, action: 'copy_path', clipboard: true }),
      { code: 'NODE_NOT_FOUND' }
    );
    assert.equal(clipboard.mock.callCount(), 0);
  }
  t.mock.method(f.view, 'getLinkedNodeIds', () => [
    ...valid,
    ...reserved,
    'assets/folder',
    'assets/missing.md',
    'absent',
  ]);
  const result = await f.api.nodeAction({
    ...f.ref(),
    nodeId: valid[0],
    action: 'copy_linked_paths',
    clipboard: true,
  });
  assert.equal(result.text, valid.join(',\n'));
  assert.equal(result.copied, true);
  assert.equal(clipboard.mock.callCount(), 1);
  assert.equal(clipboard.mock.calls[0].arguments[0], result.text);
});

test('system path unavailability and rejected clipboard leave opt-in copy results unreported', async (t) => {
  const f = setup(t);
  const { vault, file } = mobileVault(t, false);
  Object.assign(f.app.vault, vault);
  file('alpha.md');
  delete f.app.vault.adapter.getFullPath;
  const clipboard = t.mock.method(f.view, 'copyTextToClipboard', async () => false);
  await assert.rejects(
    f.api.nodeAction({
      ...f.ref(),
      nodeId: 'alpha.md',
      action: 'copy_system_path',
      clipboard: true,
    }),
    { code: 'UNAVAILABLE' }
  );
  assert.equal(clipboard.mock.callCount(), 0);
  await assert.rejects(
    f.api.nodeAction({ ...f.ref(), nodeId: 'alpha.md', action: 'copy_path', clipboard: true }),
    { code: 'UNAVAILABLE' }
  );
  assert.equal(clipboard.mock.callCount(), 1);
  assert.deepEqual(
    await f.api.nodeAction({
      ...f.ref(),
      nodeId: 'alpha.md',
      action: 'copy_path',
      clipboard: false,
    }),
    { text: 'alpha.md', copied: false }
  );
  assert.equal(clipboard.mock.callCount(), 1);
});

test('external position API invalidates manual undo instead of recording or overwriting it', async (t) => {
  const { historyFor, replayPositionAction } = loadSource('position-history.js');
  const f = setup(t);
  f.view.applyNodePinAction(f.view.captureNodeActionTargets(f.view.nodes[0]), 'exact');
  assert.equal(historyFor(f.view).undo.length, 1);
  await f.api.moveNodes({ ...f.ref(), positions: [{ id: 'alpha.md', x: 999, y: 888 }] });
  assert.equal(replayPositionAction(f.view), 'empty');
  assert.equal(f.view.nodeById.get('alpha.md').x, 999);
});
