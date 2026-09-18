const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture, deferred, element, notices, loadSource } = require('./helpers/obsidian.cjs');

function holdWrite(t, adapter) {
  const entered = deferred();
  const release = deferred();
  const original = adapter.write.bind(adapter);
  t.mock.method(adapter, 'write', async (...args) => {
    entered.resolve();
    await release.promise;
    return original(...args);
  });
  return { entered: entered.promise, release: release.resolve };
}

test('successful file write propagates true through persistActiveLayoutFile', async (t) => {
  const { plugin, writes } = fixture(t);
  assert.equal(await plugin.persistActiveLayoutFile(), true);
  assert.equal(writes.length, 1);
  assert.equal(JSON.parse(writes[0].contents).active_layout_name, 'data.json');
});

test('file write failure propagates false, retaining dirty state and old snapshots for retry', async (t) => {
  const { plugin, view, adapter, writes } = fixture(t, {
    saved_positions: { 'alpha.md': { x: 1, y: 2 }, hidden: { x: 7, y: 8 } },
    saved_layout_settings: { grid_step: 10 },
  });
  const original = structuredClone(plugin.data);
  const write = t.mock.method(adapter, 'write', async () => {
    throw new Error('Read-only adapter');
  });
  assert.equal(await plugin.persistActiveLayoutFile(), false);
  assert.equal(await view.saveCurrentLayout(), false);
  assert.deepEqual(plugin.data, original);
  assert.equal(view.layoutAutosaveDirty, true);
  assert.equal(view.nodes[0].vx, 1);
  assert.equal(writes.length, 0);
  assert.match(notices.at(-1), /Failed to save/);
  assert.ok(!notices.some((message) => message.startsWith('Layout saved')));
  write.mock.restore();
  assert.equal(await view.saveCurrentLayout(), true);
  assert.equal(view.layoutAutosaveDirty, false);
  assert.deepEqual(plugin.data.saved_positions.hidden, { x: 7, y: 8 });
});

test('successful save commits only after write and stores a complete normalized snapshot', async (t) => {
  const { plugin, view, adapter, writes } = fixture(t, {
    pins: { anchor: { x: 0, y: 0, mode: 'grid' } },
    orbit_pins: { moon: { anchor_id: 'anchor', radius: 30, angle: 1 } },
    saved_positions: { hidden: { x: 77, y: 88 } },
    view_state: { side_panel_sections: { groups: true } },
    groups: [{ id: 'g', query: 'name:alpha', color: '#123456' }],
  });
  const before = structuredClone(plugin.data);
  const gate = holdWrite(t, adapter);
  const saving = view.saveCurrentLayout();
  await gate.entered;
  assert.deepEqual(plugin.data, before);
  assert.equal(view.layoutAutosaveDirty, true);
  gate.release();
  assert.equal(await saving, true);
  const written = JSON.parse(writes[0].contents);
  for (const key of [
    'saved_positions',
    'saved_layout_settings',
    'saved_layout_pins',
    'saved_layout_orbit_pins',
  ]) {
    assert.deepEqual(plugin.data[key], written[key]);
  }
  assert.deepEqual(written.groups, plugin.data.groups);
  assert.deepEqual(written.view_state.side_panel_sections, {});
  assert.deepEqual(plugin.data.view_state.side_panel_sections, { groups: true });
  assert.equal(view.layoutAutosaveDirty, false);
  assert.equal(view.nodes[0].vx, 0);
});

test('edits during a save remain dirty; committed snapshots match disk, not newer edits', async (t) => {
  const { plugin, view, adapter, writes } = fixture(t);
  const gate = holdWrite(t, adapter);
  const saving = view.saveCurrentLayout();
  await gate.entered;
  view.nodes[0].x = 900;
  view.nodes[0].vx = 8;
  plugin.data.settings.grid_step = 35;
  plugin.data.groups.push({ id: 'g', query: 'name:new', color: '#ffffff', enabled: true });
  view.kickLayoutSearch();
  gate.release();
  assert.equal(await saving, true);
  const written = JSON.parse(writes[0].contents);
  assert.equal(written.saved_positions['alpha.md'].x, 25);
  assert.equal(plugin.data.saved_positions['alpha.md'].x, 25);
  assert.equal(view.nodes[0].x, 900);
  assert.equal(view.nodes[0].vx, 8);
  assert.equal(plugin.data.settings.grid_step, 35);
  assert.equal(plugin.data.saved_layout_settings.grid_step, written.settings.grid_step);
  assert.equal(plugin.data.groups.length, 1);
  assert.equal(view.layoutAutosaveDirty, true);
  assert.equal(await view.saveCurrentLayout({ silent: true }), true);
  assert.equal(plugin.data.saved_positions['alpha.md'].x, 900);
  assert.equal(view.layoutAutosaveDirty, false);
});

test('settings changed and reverted while writing still count as edits', async (t) => {
  const { plugin, view, adapter } = fixture(t);
  const gate = holdWrite(t, adapter);
  const saving = view.saveCurrentLayout();
  await gate.entered;
  const old = plugin.data.settings.show_grid;
  plugin.data.settings.show_grid = !old;
  plugin.schedulePersist();
  plugin.data.settings.show_grid = old;
  plugin.schedulePersist();
  gate.release();
  assert.equal(await saving, true);
  assert.equal(view.layoutAutosaveDirty, true);
});

test('overlapping saves serialize and the later snapshot includes newer coordinates', async (t) => {
  const { plugin, view, adapter, writes } = fixture(t);
  const gate = holdWrite(t, adapter);
  const first = view.saveCurrentLayout();
  await gate.entered;
  view.nodes[0].x = 600;
  const second = view.saveCurrentLayout();
  assert.equal(writes.length, 0);
  gate.release();
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(writes.length, 2);
  assert.equal(JSON.parse(writes[0].contents).saved_positions['alpha.md'].x, 25);
  assert.equal(JSON.parse(writes[1].contents).saved_positions['alpha.md'].x, 600);
  assert.equal(plugin.data.saved_positions['alpha.md'].x, 600);
  assert.equal(view.layoutAutosaveDirty, false);
});

test('switch waits for an older save and cannot receive its saved snapshots', async (t) => {
  const { plugin, view, adapter, putLayout, writes } = fixture(t);
  putLayout({ saved_positions: { 'alpha.md': { x: -70, y: -80 } }, groups: [] }, 'next.json');
  const gate = holdWrite(t, adapter);
  const saving = view.saveCurrentLayout();
  await gate.entered;
  const switching = view.selectActiveLayoutFileByName('next.json');
  assert.equal(plugin.getActiveLayoutFileName(), 'data.json');
  gate.release();
  assert.equal(await saving, true);
  assert.equal(await switching, true);
  assert.equal(plugin.getActiveLayoutFileName(), 'next.json');
  assert.equal(plugin.data.saved_positions['alpha.md'].x, -70);
  assert.equal(view.nodeById.get('alpha.md').x, -70);
  assert.ok(writes[0].name.endsWith('/data.json'));
});

test('save queued behind a layout switch is discarded rather than writing into the new layout', async (t) => {
  const { plugin, view, adapter, putLayout, writes } = fixture(t);
  putLayout({ saved_positions: { 'alpha.md': { x: -70, y: -80 } } }, 'next.json');
  const entered = deferred();
  const release = deferred();
  const original = adapter.read.bind(adapter);
  t.mock.method(adapter, 'read', async (name) => {
    entered.resolve();
    await release.promise;
    return original(name);
  });
  const switching = plugin.setActiveLayoutFile('next.json');
  await entered.promise;
  const saving = view.saveCurrentLayout();
  release.resolve();
  assert.equal(await switching, true);
  assert.equal(await saving, false);
  assert.equal(writes.length, 0);
  assert.equal(plugin.data.saved_positions['alpha.md'].x, -70);
});

test('older save never commits snapshots or dirty state into a replaced data object', async (t) => {
  const { plugin, view, adapter } = fixture(t);
  const gate = holdWrite(t, adapter);
  const saving = view.saveCurrentLayout();
  await gate.entered;
  plugin.data = plugin.normalizeData({
    active_layout_name: 'new.json',
    saved_positions: { other: { x: 5, y: 8 } },
  });
  view.layoutAutosaveDirty = true;
  gate.release();
  assert.equal(await saving, true);
  assert.equal(plugin.getActiveLayoutFileName(), 'new.json');
  assert.deepEqual(plugin.data.saved_positions, { other: { x: 5, y: 8 } });
  assert.equal(view.layoutAutosaveDirty, true);
});

test('save requested during switch preferences persistence cannot capture old view nodes for a new file', async (t) => {
  const { plugin, view, putLayout, writes } = fixture(t);
  putLayout({ saved_positions: { 'alpha.md': { x: -70, y: -80 } } }, 'next.json');
  const entered = deferred();
  const release = deferred();
  t.mock.method(plugin, 'saveData', async () => {
    entered.resolve();
    await release.promise;
  });
  const switching = view.selectActiveLayoutFileByName('next.json');
  await entered.promise;
  assert.equal(plugin.getActiveLayoutFileName(), 'data.json');
  const saving = view.saveCurrentLayout();
  release.resolve();
  assert.equal(await switching, true);
  assert.equal(await saving, false);
  assert.equal(writes.length, 0);
  assert.equal(plugin.data.saved_positions['alpha.md'].x, -70);
  assert.equal(view.nodeById.get('alpha.md').x, -70);
});

test('Save-As UI preserves active name on failure and changes it only after successful write', async (t) => {
  const { plugin, view, adapter, files, layoutPath } = fixture(t);
  const parent = element();
  view.addSideSaveLayoutButton(parent);
  const row = parent.children[0].children[0];
  const saveButton = row.children[1].children[0];
  assert.equal(saveButton.text, 'Save layout');
  view.layoutFileSearchInputValue = 'new layout';
  const write = t.mock.method(adapter, 'write', async () => {
    throw new Error('Disk full');
  });
  await saveButton.events.click();
  assert.equal(plugin.getActiveLayoutFileName(), 'data.json');
  assert.deepEqual(plugin.data.saved_positions, {});
  assert.equal(view.layoutAutosaveDirty, true);
  assert.equal(files.has(layoutPath('new layout.json')), false);
  write.mock.restore();
  const gate = holdWrite(t, adapter);
  const saving = saveButton.events.click();
  await gate.entered;
  assert.equal(plugin.getActiveLayoutFileName(), 'data.json');
  gate.release();
  await saving;
  assert.equal(plugin.getActiveLayoutFileName(), 'new layout.json');
  assert.equal(files.has(layoutPath('new layout.json')), true);
  assert.equal(view.layoutAutosaveDirty, false);
});

test('nonempty search still forbids save without mutating layout state', async (t) => {
  const { plugin, view, writes } = fixture(t);
  view.searchInputValue = 'alpha';
  view.layoutAutosaveDirty = true;
  const before = structuredClone(plugin.data);
  assert.equal(await view.saveCurrentLayout({ layoutFileName: 'other.json' }), false);
  assert.deepEqual(plugin.data, before);
  assert.equal(writes.length, 0);
  assert.equal(view.layoutAutosaveDirty, true);
  assert.equal(notices.at(-1), 'Clear search field to save');
});

test('bootstrap creates a layout only when its absence is confirmed', async (t) => {
  const { plugin, writes } = fixture(t);
  assert.deepEqual(await plugin.readLayoutFileData('data.json'), { status: 'missing' });
  assert.equal(await plugin.bootstrapActiveLayoutData(), true);
  assert.equal(writes.length, 1);
});

for (const raw of ['{broken', '', 'null', '[]', 'false', '42']) {
  test(`bootstrap preserves an existing invalid layout: ${JSON.stringify(raw)}`, async (t) => {
    const { plugin, view, files, writes, layoutPath, preferences } = fixture(t);
    files.set(layoutPath(), raw);
    const before = structuredClone(plugin.data);
    assert.equal((await plugin.readLayoutFileData('data.json')).status, 'error');
    assert.equal(await plugin.bootstrapActiveLayoutData(), false);
    assert.equal(files.get(layoutPath()), raw);
    assert.deepEqual(plugin.data, before);
    assert.equal(writes.length, 0);
    assert.equal(preferences.length, 0);
    assert.match(notices.at(-1), /Cannot read layout/);
    assert.equal(await view.saveCurrentLayout({ silent: true }), false);
    assert.equal(writes.length, 0);
  });
}

for (const failingMethod of ['read', 'exists']) {
  test(`bootstrap never creates over a ${failingMethod} error`, async (t) => {
    const { plugin, adapter, putLayout, writes } = fixture(t);
    putLayout({ settings: { grid_step: 45 } });
    t.mock.method(adapter, failingMethod, async () => {
      throw new Error('Access denied');
    });
    assert.equal(await plugin.bootstrapActiveLayoutData(), false);
    assert.equal(writes.length, 0);
  });
}

test('adapter without existence support may read but cannot infer absence from failure', async (t) => {
  const { plugin, adapter, putLayout, writes } = fixture(t);
  delete adapter.exists;
  assert.equal(await plugin.bootstrapActiveLayoutData(), false);
  assert.equal(writes.length, 0);
  putLayout({ settings: { grid_step: 45 } });
  assert.equal(await plugin.bootstrapActiveLayoutData(), true);
  assert.equal(plugin.data.settings.grid_step, 45);
});

test('bootstrap write failure reports failure without claiming creation', async (t) => {
  const { plugin, adapter, preferences } = fixture(t);
  t.mock.method(adapter, 'write', async () => {
    throw new Error('Disk full');
  });
  assert.equal(await plugin.bootstrapActiveLayoutData(), false);
  assert.equal(preferences.length, 0);
  assert.match(notices.at(-1), /Failed to create layout/);
});

test('Load reads full active file, including groups, rules and settings; side-panel state stays global', async (t) => {
  const { plugin, view, putLayout, reads } = fixture(t, {
    saved_positions: { 'alpha.md': { x: 1, y: 2 } },
    saved_layout_settings: { grid_step: 5 },
    groups: [{ id: 'old', query: 'name:old', color: '#000000' }],
    view_state: { side_panel_sections: { groups: false, display: true } },
  });
  const disk = {
    settings: { grid_step: 45, search_mode: 'filter' },
    saved_positions: { 'alpha.md': { x: 800, y: 900 } },
    groups: [{ id: 'disk', query: 'name:alpha', color: '#abcdef' }],
    blacklist: [{ id: 'b', query: 'name:exclude' }],
    whitelist: [{ id: 'w', query: 'name:alpha' }],
    pins: { anchor: { x: 4, y: 5, mode: 'grid' } },
    orbit_pins: { moon: { anchor_id: 'anchor', radius: 30, angle: 0 } },
    node_force_multipliers: { 'alpha.md': 3 },
    painted_edge_colors: { 'alpha.md': '#123456' },
    view_state: { side_panel_sections: { groups: true }, pan_x: 30 },
  };
  putLayout(disk);
  view.layoutAutosaveDirty = true;
  let rebuilt = 0;
  view.buildSidePanel = () => {
    rebuilt += 1;
  };
  assert.equal(await view.loadSavedLayout(), true);
  const expected = plugin.normalizeData(disk);
  expected.view_state.side_panel_sections = { groups: false, display: true };
  assert.deepEqual(plugin.data, expected);
  assert.equal(view.searchMode, 'filter');
  assert.deepEqual(view.sidePanelSectionState, expected.view_state.side_panel_sections);
  assert.equal(view.nodeById.get('alpha.md').x, 800);
  assert.equal(view.layoutAutosaveDirty, false);
  assert.equal(view.layoutPaused, true);
  assert.equal(reads.length, 1);
  assert.equal(rebuilt, 1);
});

test('failed reload retains current data and dirty state and never writes the file', async (t) => {
  const { plugin, view, files, layoutPath, writes } = fixture(t);
  files.set(layoutPath(), '{bad JSON');
  const data = plugin.data;
  view.layoutAutosaveDirty = true;
  assert.equal(await view.loadSavedLayout(), false);
  assert.equal(plugin.data, data);
  assert.equal(view.layoutAutosaveDirty, true);
  assert.equal(writes.length, 0);
  assert.match(notices.at(-1), /Cannot read layout/);
});

test('autosave-off close reloads all fields even without dirty and reopen uses disk positions', async (t) => {
  const { plugin, view, putLayout, preferences, flushTimers, writes } = fixture(t);
  const saved = plugin.normalizeData({ saved_positions: { 'alpha.md': { x: 15, y: 25 } } });
  putLayout(saved);
  plugin.data.groups = [{ id: 'g', query: 'name:unsaved', color: '#ffffff' }];
  plugin.data.blacklist = [{ id: 'b', query: 'name:unsaved' }];
  plugin.data.settings.show_grid = false;
  view.layoutAutosaveDirty = false;
  await view.onClose();
  flushTimers();
  assert.deepEqual(plugin.data, saved);
  assert.deepEqual(preferences.at(-1), saved);
  await view.onOpen();
  assert.deepEqual(plugin.data, saved);
  assert.equal(view.nodeById.get('alpha.md').x, 15);
  assert.equal(view.layoutPaused, true);
  assert.equal(view.layoutAutosaveDirty, false);
  assert.equal(writes.length, 0);
});

test('autosave-on close flushes dirty state before eight idle frames', async (t) => {
  const { plugin, view, writes } = fixture(t, { settings: { layout_autosave: true } });
  view.layoutAutosaveDirty = true;
  view.layoutPaused = true;
  view.stepSimulation();
  view.stepSimulation();
  assert.equal(view.layoutStillFrames, 2);
  assert.equal(writes.length, 0);
  await view.onClose();
  assert.equal(writes.length, 1);
  assert.equal(JSON.parse(writes[0].contents).saved_positions['alpha.md'].x, 25);
  assert.equal(plugin.data.saved_positions['alpha.md'].x, 25);
  assert.equal(view.layoutAutosaveDirty, false);
});

test('close flush queues behind an in-flight save and persists newer edits', async (t) => {
  const { plugin, view, adapter, writes } = fixture(t, { settings: { layout_autosave: true } });
  const gate = holdWrite(t, adapter);
  const saving = view.saveCurrentLayout({ silent: true });
  await gate.entered;
  view.nodes[0].x = 1000;
  const closing = view.onClose();
  gate.release();
  assert.equal(await saving, true);
  await closing;
  assert.equal(writes.length, 2);
  assert.equal(JSON.parse(writes[1].contents).saved_positions['alpha.md'].x, 1000);
  assert.equal(plugin.data.saved_positions['alpha.md'].x, 1000);
  assert.equal(view.layoutAutosaveDirty, false);
});

test('close-time write failure keeps dirty and old snapshots and surfaces a notice', async (t) => {
  const { plugin, view, adapter } = fixture(t, { settings: { layout_autosave: true } });
  view.layoutAutosaveDirty = true;
  t.mock.method(adapter, 'write', async () => {
    throw new Error('Disk full');
  });
  await view.onClose();
  assert.deepEqual(plugin.data.saved_positions, {});
  assert.equal(view.layoutAutosaveDirty, true);
  assert.match(notices.at(-1), /Failed to save layout on close/);
});

test('autosave-on close respects the nonempty-search restriction', async (t) => {
  const { view, writes } = fixture(t, { settings: { layout_autosave: true } });
  view.layoutAutosaveDirty = true;
  view.searchInputValue = 'alpha';
  await view.onClose();
  assert.equal(writes.length, 0);
  assert.equal(view.layoutAutosaveDirty, true);
});

test('onOpen synchronizes search mode from disk before building controls', async (t) => {
  const { view, putLayout } = fixture(t);
  assert.equal(view.searchMode, 'find');
  putLayout({ settings: { search_mode: 'filter' } });
  const modesAtBuild = [];
  view.buildSidePanel = () => modesAtBuild.push(view.searchMode);
  await view.onOpen();
  assert.deepEqual(modesAtBuild, ['filter']);
});

test('topology-neutral metadata/vault refresh preserves pause, coordinates and dirty state', async (t) => {
  const { plugin, view, putLayout, events, flushTimers } = fixture(t);
  putLayout({ saved_positions: { 'alpha.md': { x: 15, y: 25 }, hidden: { x: 70, y: 80 } } });
  await plugin.onload();
  await view.onOpen();
  assert.equal(view.layoutPaused, true);
  for (const dirty of [false, true]) {
    view.layoutAutosaveDirty = dirty;
    view.layoutStillFrames = 5;
    events.resolved();
    events.modify({ path: 'alpha.md' });
    flushTimers();
    assert.equal(view.layoutPaused, true);
    assert.equal(view.layoutAutosaveDirty, dirty);
    assert.equal(view.layoutStillFrames, 5);
    assert.equal(view.nodeById.get('alpha.md').x, 15);
    view.stepSimulation();
    assert.equal(view.nodeById.get('alpha.md').x, 15);
    assert.deepEqual(plugin.data.saved_positions.hidden, { x: 70, y: 80 });
  }
});

test('adding a node through a passive vault refresh wakes settled physics', async (t) => {
  const { plugin, view, putLayout, events, flushTimers, graph } = fixture(t);
  putLayout({ saved_positions: { 'alpha.md': { x: 15, y: 25 } } });
  await plugin.onload();
  await view.onOpen();
  assert.equal(view.layoutPaused, true);

  graph.nodes.push({ id: 'late.md', label: 'late' });
  plugin.data.saved_positions['late.md'] = { x: 600, y: 700 };
  events.create({ path: 'late.md' });
  flushTimers();
  assert.equal(view.nodeById.get('late.md').x, 600);
  assert.equal(view.layoutPaused, false);
  assert.equal(view.layoutAutosaveDirty, true);
  assert.equal(view.layoutStillFrames, 0);
});

test('adding an edge through a passive metadata refresh wakes settled physics', (t) => {
  const { view, graph } = fixture(t);
  graph.nodes.push({ id: 'beta.md', label: 'beta' });
  view.refreshFromVault({ keepCamera: true, skipLayoutKick: true });
  view.layoutAutosaveDirty = false;
  view.layoutStillFrames = 5;

  graph.edges.push({ source: 'alpha.md', target: 'beta.md' });
  view.refreshFromVault({ keepCamera: true, passive: true, metadataResolved: true });

  assert.equal(view.layoutPaused, false);
  assert.equal(view.layoutAutosaveDirty, true);
  assert.equal(view.layoutStillFrames, 0);
});

test('passive refresh preserves an already-running layout, while deliberate settings still kick', (t) => {
  const { plugin, view } = fixture(t);
  view.layoutPaused = false;
  view.layoutAutosaveDirty = true;
  view.layoutStillFrames = 3;
  view.refreshFromVault({ passive: true, keepCamera: true });
  assert.equal(view.layoutPaused, false);
  assert.equal(view.layoutAutosaveDirty, true);
  assert.equal(view.layoutStillFrames, 3);
  view.layoutPaused = true;
  view.layoutAutosaveDirty = false;
  plugin.data.settings.hide_orphans = false;
  view.applyRefreshMode('data');
  assert.equal(view.layoutPaused, false);
  assert.equal(view.layoutAutosaveDirty, true);
  assert.equal(view.layoutStillFrames, 0);
});

test('physics setting slider still restarts a loaded layout', (t) => {
  const { view } = fixture(t);
  const parent = element();
  view.addSideSlider(parent, 'Repulsion', 'repel_strength', 0, 100, 1, 'render');
  const input = view.sideControls.get('repel_strength').input;
  view.layoutPaused = true;
  view.layoutAutosaveDirty = false;
  input.value = '65';
  input.events.input();
  assert.equal(view.layoutPaused, false);
  assert.equal(view.layoutAutosaveDirty, true);
});

test('stale hit-test buckets use current coordinates without rebuilding or altering rendering', (t) => {
  const { view } = fixture(t);
  const node = view.nodes[0];
  const index = view.getNodeSpatialIndex();
  const buildVersion = view.nodeSpatialIndexBuildVersion;
  node.x = 1200;
  node.y = -700;
  view.markNodeSpatialIndexDirty();
  t.mock.method(view, 'getNodeSpatialIndex', () => {
    throw new Error('No pointer-time rebuild');
  });
  t.mock.method(view, 'render', () => {
    throw new Error('No pointer-time render');
  });
  const point = view.worldToScreen(node.x, node.y);
  for (let i = 0; i < 20; i += 1) assert.equal(view.getNodeAtScreen(point.x, point.y), node);
  const old = view.worldToScreen(25, 40);
  assert.equal(view.getNodeAtScreen(old.x, old.y), null);
  assert.equal(view.nodeSpatialIndex, index);
  assert.equal(view.nodeSpatialIndexBuildVersion, buildVersion);
  view.getFilterVisibleNodeIds = () => new Set();
  assert.equal(view.getNodeAtScreen(point.x, point.y), null);
});

test('fresh indexed hit testing and stale scanning agree at non-default zoom', (t) => {
  const { view } = fixture(t);
  view.camera = { x: 150, y: -50, zoom: 0.3 };
  const node = view.nodes[0];
  const point = view.worldToScreen(node.x, node.y);
  view.getNodeSpatialIndex();
  assert.equal(view.getNodeAtScreen(point.x, point.y), node);
  view.markNodeSpatialIndexDirty();
  assert.equal(view.getNodeAtScreen(point.x, point.y), node);
});

test('real physics autosave consumes saveCurrentLayout boolean and retains dirty after disk failure', async (t) => {
  const { plugin, view, adapter } = fixture(t);
  plugin.data.settings.layout_autosave = true;
  view.layoutAutosaveDirty = true;
  view.layoutPaused = true;
  t.mock.method(adapter, 'write', async () => {
    throw new Error('Disk full');
  });
  const { stepSimulation } = loadSource('physics.js');
  for (let i = 0; i < 10; i += 1) stepSimulation(view);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(view.layoutAutosaveDirty, true);
  assert.deepEqual(plugin.data.saved_positions, {});
});
