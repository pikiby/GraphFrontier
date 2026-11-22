const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, loadSource, element, notices } = require('./helpers/obsidian.cjs');
const { PREFIX, GRAVITY_CORE_RADIUS, darkEnergyNodes, getDarkEnergyTargets, applyDarkEnergyForce } =
  loadSource('dark-energy.js');
const { DarkEnergyModal } = loadSource('dark-energy-modal.js');
const { buildNodeContextMenu } = loadSource('node-context-menu.js');

const center = (overrides = {}) => ({
  id: `${PREFIX}one`,
  name: 'Center',
  queries: ['tag:database'],
  strength: 10,
  repulsion: 0,
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
  for (const [repulsion, expected] of [
    [undefined, 0],
    [Infinity, 0],
    [-5, 0],
    [120, 100],
    [30, 30],
  ]) {
    assert.equal(
      plugin.normalizeData({ dark_energy: [center({ repulsion })] }).dark_energy[0].repulsion,
      expected
    );
  }
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

test('pins and active drag block dark energy forces, but attachment classification does not', (t) => {
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
  const attachmentX = node.x;
  assert(attachmentX > 0);
  Object.assign(node, { x: 0, y: 0, vx: 0, vy: 0 });
  node.meta.isAttachment = false;
  view.kickLayoutSearch();
  view.stepSimulation();
  assert.equal(node.x, attachmentX);
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
  const query = els.find((el) => el.cls === 'graphfrontier-group-query' && el.value === 'tag:');
  const save = els.find((el) => el.text === 'Save');
  assert.equal(query.value, 'tag:');
  save.events.click();
  assert.equal(saved.length, 0);
  assert.match(notices.at(-1), /complete every query/);
  query.value = 'path:Folder/';
  save.events.click();
  assert.deepEqual(saved[0].queries, ['path:Folder/']);
});

test('gravity well attracts outside core radius, balances at rim, and pushes outward inside', (t) => {
  const { view, node } = setup(t);
  const centerNode = view.nodeById.get(center().id);

  centerNode.x = 0;
  const zeroA = { ax: 0, ay: 0 };
  applyDarkEnergyForce(view, node, zeroA, getDarkEnergyTargets(view));
  const zeroB = { ax: 0, ay: 0 };
  applyDarkEnergyForce(view, node, zeroB, getDarkEnergyTargets(view));
  assert(Math.hypot(zeroA.ax, zeroA.ay) > 0, 'coincident node gets deterministic outward push');
  assert.deepEqual(zeroA, zeroB);

  centerNode.x = 10;
  const inside = { ax: 0, ay: 0 };
  applyDarkEnergyForce(view, node, inside, getDarkEnergyTargets(view));
  assert(inside.ax < 0 && inside.ay === 0, 'inside core radius force pushes away from center');

  centerNode.x = GRAVITY_CORE_RADIUS;
  const rim = { ax: 0, ay: 0 };
  applyDarkEnergyForce(view, node, rim, getDarkEnergyTargets(view));
  assert.equal(rim.ax, 0);
  assert.equal(rim.ay, 0);

  for (const distance of [200, 100000]) {
    centerNode.x = distance;
    const accel = { ax: 0, ay: 0 };
    applyDarkEnergyForce(view, node, accel, getDarkEnergyTargets(view));
    const previousForce = Math.min(1.6, (distance - GRAVITY_CORE_RADIUS) * 10 * 0.00015);
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
  const repelSlider = els.filter((el) => el.type === 'range')[1];
  assert.equal(repelSlider.cls, slider.cls);
  assert.equal(repelSlider.value, '0');
  assert.equal(repelSlider.min, '0');
  assert.equal(repelSlider.max, '100');
  repelSlider.value = '40';
  repelSlider.events.input();
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
  assert.equal(saved[0].repulsion, 40);
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

test('repulsion affects only nonmatching nodes, fades with distance and reuses matching cache', (t) => {
  const { view, node } = setup(t, [center({ repulsion: 50 })]);
  const targets = getDarkEnergyTargets(view);
  const match = t.mock.method(view, 'nodeMatchesParsedGroup');
  const other = view.nodeById.get('other.md');
  const acceleration = (target) => {
    const accel = { ax: 0, ay: 0 };
    applyDarkEnergyForce(view, target, accel, getDarkEnergyTargets(view));
    return accel;
  };
  assert.equal(acceleration(node).ax, ((200 - GRAVITY_CORE_RADIUS) * 10 * 0.00015) / 2);
  const near = acceleration(other).ax;
  assert.ok(near < 0);
  assert.equal(near, (-0.004 * 50 * (1 - 400 / 1000) ** 2) / 2);
  other.x = -600;
  assert.ok(acceleration(other).ax > near);
  for (const x of [-800, -1000]) {
    other.x = x;
    assert.equal(acceleration(other).ax, 0);
  }
  other.x = 200;
  const coincident = acceleration(other);
  assert.ok(Math.hypot(coincident.ax, coincident.ay) > 0);
  assert.deepEqual(acceleration(other), coincident);
  assert.equal(getDarkEnergyTargets(view), targets);
  assert.equal(match.mock.callCount(), 0);
  assert.equal(targets.has(center().id), false);
});

test('repulsion runs with attraction disabled but respects pins, orbits, drag and visibility, equally for attachments', (t) => {
  const { view, plugin } = setup(t, [center({ strength: 0, repulsion: 50 })]);
  const other = view.nodeById.get('other.md');
  plugin.setPin(other.id, { x: -200, y: 0 });
  view.stepSimulation();
  assert.equal(other.x, -200);
  plugin.removePin(other.id);
  view.dragNodeId = other.id;
  view.stepSimulation();
  assert.equal(other.x, -200);
  view.dragNodeId = null;
  other.meta.isAttachment = true;
  view.kickLayoutSearch();
  view.stepSimulation();
  const attachmentX = other.x;
  assert(attachmentX < -200);
  Object.assign(other, { x: -200, y: 0, vx: 0, vy: 0 });
  other.meta.isAttachment = false;
  view.kickLayoutSearch();
  view.stepSimulation();
  assert.equal(other.x, attachmentX);
  plugin.setOrbitPin(other.id, { anchor_id: center().id, radius: 20, angle: 0 });
  view.stepSimulation();
  assert.equal(other.x, 220);
  plugin.removeOrbitPin(other.id);
  plugin.data.blacklist = [{ id: 'hidden', query: 'name:Other', enabled: true }];
  view.markQueryRuleVisibilityDirty();
  view.kickLayoutSearch();
  view.stepSimulation();
  assert.equal(other.x, 220);
  plugin.data.blacklist = [];
  view.markQueryRuleVisibilityDirty();
  view.kickLayoutSearch();
  view.stepSimulation();
  assert.ok(other.x > 220);
});

test('layout save and reload preserve repulsion', async (t) => {
  const { view, plugin } = setup(t, [center({ repulsion: 35 })]);
  assert.equal(await view.saveCurrentLayout({ silent: true }), true);
  plugin.data.dark_energy = [center({ repulsion: 0 })];
  assert.equal(await view.loadSavedLayout(), true);
  assert.equal(plugin.data.dark_energy[0].repulsion, 35);
});

test('legacy field shapes load as ordinary point attractors', (t) => {
  const { plugin } = fixture(t);
  for (const shape of ['line', 'area']) {
    const item = center({ repulsion: 35 });
    const data = plugin.normalizeData({
      dark_energy: [{ ...item, shape, angle: 30, radius: 500, rotation: 2 }],
    });
    assert.deepEqual(data.dark_energy, [item]);
  }
});

test('creating a gravity node renders it immediately before rules are configured and stays after closing editor', (t) => {
  const { view, plugin } = setup(t, []);
  plugin.collectGraphData = Object.getPrototypeOf(plugin).collectGraphData.bind(plugin);
  view.wrapEl = element();
  view.camera = { x: 0, y: 0, zoom: 1 };
  view.editDarkEnergy(null, { x: 75, y: -40 });
  assert.equal(plugin.data.dark_energy.length, 1);
  const created = plugin.data.dark_energy[0];
  assert.equal(created.x, 75);
  assert.equal(created.y, -40);
  assert.deepEqual(created.queries, []);
  assert.ok(view.nodeById.has(created.id), 'gravity node is immediately visible in view');
  assert.ok(view.floatingEditorEl, 'floating editor opens beside the visible gravity node');
  const all = (el) => [el, ...el.children.flatMap(all)];
  const els = all(view.floatingEditorEl);
  const nameInput = els.find((el) => el.attributes?.['aria-label'] === 'Gravity node name');
  nameInput.value = 'Cluster Hub';
  nameInput.events.input();
  assert.equal(plugin.data.dark_energy[0].name, 'Cluster Hub');
  const queryInput = els.find((el) => el.attributes?.['aria-label'] === 'Gravity node query');
  assert.equal(queryInput.value, 'tag:');
  queryInput.value = 'tag:database';
  queryInput.events.input();
  assert.deepEqual(plugin.data.dark_energy[0].queries, ['tag:database']);
  view.closeFloatingEditor();
  assert.equal(plugin.data.dark_energy.length, 1);
  assert.ok(view.nodeById.has(created.id));
});

test('gravity well holds single and clustered nodes in an open halo without overlapping the center or each other', (t) => {
  const single = setup(t, [center({ strength: 30, repulsion: 0 })]);
  for (let i = 0; i < 300 && !single.view.layoutPaused; i++) single.view.stepSimulation();
  const singleDist = Math.hypot(single.node.x - 200, single.node.y);
  assert(
    singleDist > 35 && singleDist < 55,
    `expected single node halo near GRAVITY_CORE_RADIUS=45, got ${singleDist.toFixed(1)}`
  );

  const cluster = fixture(t, {
    dark_energy: [center({ strength: 100, repulsion: 0 })],
    settings: {
      repel_strength: 116,
      repel_radius: 535,
      center_strength: 0,
      base_link_strength: 0,
      damping: 0.1,
      layout_autosave: false,
    },
  });
  Object.assign(cluster.plugin.data.settings, {
    repel_strength: 116,
    repel_radius: 535,
    center_strength: 0,
    base_link_strength: 0,
    damping: 0.1,
  });
  cluster.graph.nodes = [
    ...Array.from({ length: 30 }, (_, i) => ({
      id: `m${i}.md`,
      label: `M${i}`,
      meta: { path: `m${i}.md`, fileName: `M${i}`, tags: ['database'], properties: new Map() },
    })),
    ...darkEnergyNodes(cluster.plugin.data.dark_energy),
  ];
  cluster.view.refreshFromVault({ keepCamera: true });
  const members = Array.from({ length: 30 }, (_, i) => {
    const n = cluster.view.nodeById.get(`m${i}.md`);
    n.x = 180 + (i % 6) * 8;
    n.y = -20 + Math.floor(i / 6) * 8;
    n.vx = 0;
    n.vy = 0;
    return n;
  });
  for (let i = 0; i < 400; i++) cluster.view.stepSimulation();

  let minDistToGravity = Infinity;
  let minPairDist = Infinity;
  for (let i = 0; i < members.length; i++) {
    minDistToGravity = Math.min(minDistToGravity, Math.hypot(members[i].x - 200, members[i].y));
    for (let j = i + 1; j < members.length; j++) {
      minPairDist = Math.min(
        minPairDist,
        Math.hypot(members[i].x - members[j].x, members[i].y - members[j].y)
      );
    }
  }
  assert(
    minDistToGravity > 20,
    `expected clustered nodes to stay outside gravity core (min=${minDistToGravity.toFixed(1)})`
  );
  assert(
    minPairDist > 12,
    `expected clustered nodes not to collapse on each other (minPair=${minPairDist.toFixed(1)})`
  );
});
