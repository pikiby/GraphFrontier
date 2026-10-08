const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, loadSource, element, notices } = require('./helpers/obsidian.cjs');
const { PREFIX, darkEnergyNodes, getDarkEnergyTargets, applyDarkEnergyForce } =
  loadSource('dark-energy.js');
const { DarkEnergyModal } = loadSource('dark-energy-modal.js');
const { buildNodeContextMenu } = loadSource('node-context-menu.js');

const center = (overrides = {}) => ({
  id: `${PREFIX}one`,
  name: 'Center',
  queries: ['tag:database'],
  strength: 10,
  x: 200,
  y: 0,
  ...overrides,
});

function setup(t, items = [center()]) {
  const f = fixture(t, {
    dark_energy: items,
    settings: {
      repel_strength: 0,
      center_strength: 0,
      base_link_strength: 0,
      layout_autosave: false,
    },
  });
  Object.assign(f.plugin.data.settings, {
    repel_strength: 0,
    center_strength: 0,
    base_link_strength: 0,
  });
  f.graph.nodes = [
    {
      id: 'one.md',
      label: 'One',
      meta: {
        path: 'Folder/one.md',
        fileName: 'One',
        tags: ['database'],
        lines: ['select one'],
        sections: ['Introduction'],
        properties: new Map([['status', ['active']]]),
      },
    },
    { id: 'other.md', label: 'Other', meta: { path: 'other.md', tags: [] } },
    ...darkEnergyNodes(f.plugin.data.dark_energy),
  ];
  f.view.refreshFromVault({ keepCamera: true });
  const node = f.view.nodeById.get('one.md');
  Object.assign(node, { x: 0, y: 0, vx: 0, vy: 0 });
  Object.assign(f.view.nodeById.get('other.md'), { x: -200, y: 0, vx: 0, vy: 0 });
  return { ...f, node };
}

test('dark energy normalization preserves valid settings and rejects invalid identities/rules', (t) => {
  const { plugin } = fixture(t);
  assert.deepEqual(plugin.normalizeData({}).dark_energy, []);
  const data = plugin.normalizeData({
    dark_energy: [
      center({ strength: Infinity, x: NaN }),
      center(),
      center({ id: 'note.md' }),
      center({ id: `${PREFIX}bad`, queries: ['tag:', 'untyped'] }),
      null,
    ],
  });
  assert.equal(data.dark_energy.length, 1);
  assert.equal(data.dark_energy[0].strength, 10);
  assert.equal(data.dark_energy[0].x, 0);
});

test('all search query types use the existing matcher and union rules without duplicate forces', (t) => {
  const { view, plugin, node } = setup(t);
  for (const query of [
    'name:One',
    'path:Folder/',
    'file:One',
    'tag:database',
    'line:select',
    'section:Intro',
    '[status]:active',
  ]) {
    plugin.data.dark_energy = [center({ queries: [query] })];
    assert.equal(getDarkEnergyTargets(view).get(node.id).length, 1, query);
    assert.equal(getDarkEnergyTargets(view).has('other.md'), false, query);
  }
  plugin.data.dark_energy = [center({ queries: ['name:One', 'tag:database'] })];
  assert.equal(getDarkEnergyTargets(view).get(node.id).length, 1);
});

test('matching is cached across movement, invalidated by metadata, rules and graph replacement', (t) => {
  const { view, plugin, node } = setup(t);
  const first = getDarkEnergyTargets(view);
  const match = t.mock.method(view, 'nodeMatchesParsedGroup');
  node.x += 10;
  view.nodeById.get(center().id).x += 10;
  assert.equal(getDarkEnergyTargets(view), first);
  assert.equal(match.mock.callCount(), 0);
  view.markGraphVisibilityDirty();
  assert.notEqual(getDarkEnergyTargets(view), first);
  assert.ok(match.mock.callCount() > 0);
  plugin.data.dark_energy = [center({ queries: ['name:Other'] })];
  assert.equal(getDarkEnergyTargets(view).has(node.id), false);
  view.nodes = [...view.nodes, { id: 'new.md', label: 'Other', meta: {} }];
  assert.equal(getDarkEnergyTargets(view).has('new.md'), true);
});

test('energy moves only matching free nodes and leaves the center stationary', (t) => {
  const { view, node } = setup(t);
  view.stepSimulation();
  assert.ok(node.x > 0);
  assert.equal(view.nodeById.get('other.md').x, -200);
  assert.equal(view.nodeById.get(center().id).x, 200);
});

test('pins, active drag and isolated attachments do not receive dark energy forces', (t) => {
  const { view, plugin, node } = setup(t);
  plugin.setPin(node.id, { x: 0, y: 0 });
  view.stepSimulation();
  assert.equal(node.x, 0);
  plugin.removePin(node.id);
  view.dragNodeId = node.id;
  view.stepSimulation();
  assert.equal(node.x, 0);
  view.dragNodeId = null;
  node.meta.isAttachment = true;
  view.kickLayoutSearch();
  view.stepSimulation();
  assert.equal(node.x, 0);
});

test('multiple centers combine their influence and strength zero disables attraction', (t) => {
  const { view, node, plugin } = setup(t, [center(), center({ id: `${PREFIX}two`, x: -200 })]);
  view.stepSimulation();
  assert.equal(node.x, 0);
  plugin.data.dark_energy = [center({ strength: 0 })];
  view.kickLayoutSearch();
  view.stepSimulation();
  assert.equal(node.x, 0);
});

test('centers remain accessible with whitelist and are collected even when orphans are hidden', (t) => {
  const { plugin, view, app } = setup(t);
  plugin.data.whitelist = [{ id: 'none', query: 'name:absent', enabled: true }];
  view.markQueryRuleVisibilityDirty();
  const visible = view.getFilterVisibleNodeIds();
  assert.ok(visible.has(center().id));
  assert.ok(!visible.has('one.md'));
  app.vault.getMarkdownFiles = () => [];
  plugin.data.settings.hide_orphans = true;
  const graph = Object.getPrototypeOf(plugin).collectGraphData.call(plugin);
  assert.deepEqual(
    graph.nodes.map((node) => node.id),
    [center().id]
  );
  assert.deepEqual(graph.edges, []);
});

test('layout save/load preserves center settings and moved coordinates, old layouts remove centers', async (t) => {
  const { plugin, view, files, layoutPath, putLayout } = setup(t);
  view.nodeById.get(center().id).x = 345;
  assert.equal(await view.saveCurrentLayout({ silent: true }), true);
  const saved = JSON.parse(files.get(layoutPath()));
  assert.deepEqual(saved.dark_energy, [center()]);
  assert.equal(saved.saved_positions[center().id].x, 345);
  plugin.data.dark_energy = [];
  assert.equal(await plugin.setActiveLayoutFile('data.json'), true);
  const runtime = view.createRuntimeNode(darkEnergyNodes(plugin.data.dark_energy)[0], null, 0, {
    forceSavedPositions: true,
  });
  assert.equal(runtime.x, 345);
  putLayout({}, 'old.json');
  assert.equal(await plugin.setActiveLayoutFile('old.json'), true);
  assert.deepEqual(plugin.data.dark_energy, []);
});

test('delete center removes its state and releases orbit children without deleting notes', (t) => {
  const { view, plugin, graph } = setup(t);
  plugin.data.saved_positions[center().id] = { x: 200, y: 0 };
  plugin.data.orbit_pins['one.md'] = { anchor_id: center().id, radius: 20, angle: 0 };
  plugin.collectGraphData = () => ({
    nodes: graph.nodes.filter((node) => !node.meta?.darkEnergy),
    edges: [],
  });
  view.removeDarkEnergy(view.nodeById.get(center().id));
  assert.deepEqual(plugin.data.dark_energy, []);
  assert.equal(plugin.data.orbit_pins['one.md'], undefined);
  assert.equal(plugin.data.saved_positions[center().id], undefined);
  assert.ok(view.nodeById.has('one.md'));
});

test('right-click background creates at pointer coordinates and center menu offers edit/delete', (t) => {
  const { view, app } = setup(t);
  app.vault.getAbstractFileByPath = () => null;
  view.canvasEl = { getBoundingClientRect: () => ({ left: 10, top: 20 }) };
  view.getNodeAtScreen = () => null;
  view.screenToWorld = (x, y) => ({ x: x * 2, y: y * 2 });
  let menu;
  view.showMenuAtPointer = (next) => {
    menu = next;
  };
  view.onContextMenu({ preventDefault() {}, clientX: 30, clientY: 40 });
  const edit = t.mock.method(view, 'editDarkEnergy', () => {});
  menu.items[0].callback();
  assert.deepEqual(edit.mock.calls[0].arguments, [null, { x: 40, y: 40 }]);
  menu = buildNodeContextMenu(view, view.nodeById.get(center().id), 0, 0);
  assert.equal(menu.items[0].title, 'Edit gravity node');
  assert.equal(menu.items[1].title, 'Delete gravity node');
});

test('editor starts with typed query and rejects incomplete rules before saving', (t) => {
  const { view } = setup(t);
  const saved = [];
  const modal = new DarkEnergyModal(view, center({ queries: [] }), (item) => saved.push(item));
  modal.contentEl = element();
  modal.close = () => modal.onClose();
  modal.onOpen();
  const descendants = (el) => [el, ...el.children.flatMap(descendants)];
  const els = descendants(modal.contentEl);
  const query = els.find((el) => el.cls === 'graphfrontier-group-query' && el.value === 'name:');
  const save = els.find((el) => el.text === 'Save');
  assert.equal(query.value, 'name:');
  save.events.click();
  assert.equal(saved.length, 0);
  assert.match(notices.at(-1), /complete every query/);
  query.value = 'path:Folder/';
  save.events.click();
  assert.deepEqual(saved[0].queries, ['path:Folder/']);
});

test('gravity attraction is halved, including its cap', (t) => {
  const { view, node } = setup(t);
  for (const distance of [10, 200, 100000]) {
    view.nodeById.get(center().id).x = distance;
    const accel = { ax: 0, ay: 0 };
    applyDarkEnergyForce(view, node, accel, getDarkEnergyTargets(view));
    const previousForce = Math.min(1.6, distance * 10 * 0.00015);
    assert.equal(accel.ax, previousForce / 2);
    assert.equal(accel.ay, 0);
  }
});

test('compact gravity editor uses sidebar slider styles and saves the slider value', (t) => {
  const { view, plugin } = setup(t);
  const saved = [];
  const modal = new DarkEnergyModal(view, center({ name: 'Dark energy' }), (item) =>
    saved.push(item)
  );
  modal.contentEl = element();
  modal.modalEl = element();
  const addClass = t.mock.method(modal.modalEl, 'addClass');
  modal.close = () => modal.onClose();
  modal.onOpen();
  assert.equal(addClass.mock.calls[0].arguments[0], 'graphfrontier-gravity-modal');
  const descendants = (el) => [el, ...el.children.flatMap(descendants)];
  const els = descendants(modal.contentEl);
  assert(els.some((el) => el.text === 'Gravity node'));
  assert.equal(
    els.some((el) => el.tag === 'p'),
    false
  );
  const slider = els.find((el) => el.type === 'range');
  assert.equal(slider.cls, 'graphfrontier-sidepanel-slider');
  assert.equal(slider.min, '0');
  assert.equal(slider.max, '100');
  const value = els.find((el) => el.cls === 'graphfrontier-sidepanel-value');
  const setText = t.mock.method(value, 'setText');
  slider.value = '25';
  slider.events.input();
  assert.equal(setText.mock.calls[0].arguments[0], '25');
  els.find((el) => el.text === 'Save').events.click();
  assert.equal(saved[0].strength, 25);
  assert.equal(saved[0].name, 'Gravity node');
  assert.equal(
    plugin.normalizeData({ dark_energy: [center({ name: 'Dark energy' })] }).dark_energy[0].name,
    'Gravity node'
  );
});

test('create, edit, save and reload use the real graph collector without creating note files', async (t) => {
  const { plugin, view, app, writes } = fixture(t);
  app.vault.getMarkdownFiles = () => [];
  plugin.collectGraphData = Object.getPrototypeOf(plugin).collectGraphData.bind(plugin);
  view.setDarkEnergy(center());
  assert.equal(view.nodeById.get(center().id).x, 200);
  view.nodeById.get(center().id).x = 456;
  view.setDarkEnergy(center({ name: 'Renamed', queries: ['path:Folder/'] }));
  assert.equal(view.nodeById.get(center().id).x, 456);
  assert.equal(view.nodeById.get(center().id).label, 'Renamed');
  assert.equal(await view.saveCurrentLayout({ silent: true }), true);
  view.removeDarkEnergy(view.nodeById.get(center().id));
  assert.equal(view.nodeById.has(center().id), false);
  assert.equal(await view.loadSavedLayout(), true);
  assert.equal(view.nodeById.get(center().id).x, 456);
  assert.equal(view.nodeById.get(center().id).label, 'Renamed');
  assert(writes.every((write) => write.name.endsWith('.json')));
});

test('autosave-off close discards unsaved center changes and failed save remains dirty', async (t) => {
  const { plugin, view, putLayout, adapter } = setup(t);
  putLayout(plugin.data);
  plugin.data.dark_energy = [center({ name: 'Unsaved' })];
  t.mock.method(adapter, 'write', async () => {
    throw new Error('Disk full');
  });
  assert.equal(await view.saveCurrentLayout({ silent: true }), false);
  assert.equal(view.layoutAutosaveDirty, true);
  await view.onClose();
  assert.equal(plugin.data.dark_energy[0].name, 'Center');
});

test('orbit-pinned and hidden nodes remain unaffected by attraction', (t) => {
  const { view, plugin, node } = setup(t);
  plugin.setOrbitPin(node.id, { anchor_id: center().id, radius: 20, angle: 0 });
  view.stepSimulation();
  assert.equal(node.x, 220);
  plugin.removeOrbitPin(node.id);
  plugin.data.blacklist = [{ id: 'hidden', query: 'name:One', enabled: true }];
  view.markQueryRuleVisibilityDirty();
  view.kickLayoutSearch();
  view.stepSimulation();
  assert.equal(node.x, 220);
});
