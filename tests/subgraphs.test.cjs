const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, loadSource, deferred, notices } = require('./helpers/obsidian.cjs');
const {
  SUBGRAPH_PREFIX: P,
  LOCAL_COORDINATES,
  normalizeSubgraphs,
  descendants,
  projectSubgraphs,
} = require('../src/subgraphs');
const { GraphFrontierView } = loadSource('view.js');
const { GraphFrontierApi } = loadSource('api.js');
const { buildNodeContextMenu } = loadSource('node-context-menu.js');
const { darkEnergyNodes, getDarkEnergyTargets } = loadSource('dark-energy.js');
const render = loadSource('render.js');
const { mobileVault } = require('./helpers/mobile-vault.cjs');
const group = (id, members, position = {}) => ({
  id: P + id,
  name: id,
  members,
  x: 0,
  y: 0,
  ...position,
});
const ids = (view) => view.nodes.map((node) => node.id).sort();
const point = (node) => ({ x: node.x, y: node.y });

function setup(t, data = {}) {
  const f = fixture(t, {
    subgraph_coordinates: LOCAL_COORDINATES,
    saved_positions: Object.fromEntries(
      ['a', 'b', 'c', 'd'].map((name, index) => [`${name}.md`, { x: index * 100, y: index * 20 }])
    ),
    ...data,
    settings: {
      hide_orphans: false,
      hide_attachments: false,
      layout_autosave: false,
      ...data.settings,
    },
  });
  f.graph.nodes = ['a', 'b', 'c', 'd'].map((name) => ({
    id: `${name}.md`,
    label: name,
    meta: {
      path: `${name}.md`,
      fileName: name,
      tags: [name === 'b' ? '#red' : '#green'],
      properties: new Map(),
    },
  }));
  f.graph.edges = [
    { source: 'a.md', target: 'b.md' },
    { source: 'a.md', target: 'c.md' },
    { source: 'b.md', target: 'c.md' },
    { source: 'c.md', target: 'd.md' },
  ];
  f.plugin.collectGraphData = () => ({
    ...f.graph,
    nodes: [...f.graph.nodes, ...darkEnergyNodes(f.plugin.data.dark_energy)],
  });
  f.app.vault.getAbstractFileByPath = () => null;
  f.view.refreshFromVault({ keepCamera: true, forceSavedPositions: true, skipLayoutKick: true });
  f.makeGroup = (members = ['a.md', 'b.md'], id = 'one', view = f.view) =>
    view.setSubgraph(group(id, members));
  f.child = async (id = P + 'one') => {
    const child = new GraphFrontierView({ app: f.app }, f.plugin);
    child.render = () => {};
    child.buildSidePanel = () => {};
    child.isOpen = true;
    f.app.workspace.getLeavesOfType().push({ view: child });
    await child.setState({ subgraph: { id, layout: f.plugin.getActiveLayoutFileName() } });
    return child;
  };
  return f;
}

function children(el) {
  return [el, ...el.children.flatMap(children)];
}

test('normalization retains missing members and settings, rejects duplicate parents/cycles, drops expansion state', (t) => {
  const { plugin } = setup(t);
  assert.deepEqual(plugin.normalizeData({}).subgraphs, []);
  const data = plugin.normalizeData({
    subgraphs: [
      null,
      group('one', ['missing.md', P + 'two', 'a.md', 'a.md'], { expanded: true }),
      group('two', [P + 'one', 'a.md', 'b.md']),
      group('two', ['d.md']),
      { id: 'note.md' },
    ],
    pins: { 'missing.md': { x: 1, y: 2 } },
    node_visual_settings: { 'missing.md': { node_size_scale: 2 } },
  });
  assert.deepEqual(
    data.subgraphs.map((item) => item.members),
    [['missing.md', P + 'two', 'a.md'], ['b.md']]
  );
  assert(!('expanded' in data.subgraphs[0]));
  assert.equal(descendants(data.subgraphs, P + 'one').size, 4);
  assert.equal(data.node_visual_settings['missing.md'].node_size_scale, 2);
  assert.equal(data.pins['missing.md'].x, 1);
  assert.equal(normalizeSubgraphs([group('self', [P + 'self'])])[0].members.length, 0);
});

test('legacy global coordinates migrate once into immediate-parent local coordinates, including pins and gravity fallback', (t) => {
  const { plugin } = setup(t);
  const gravity = {
    id: 'graphfrontier:dark-energy:test',
    name: 'Gravity',
    queries: ['tag:green'],
    strength: 10,
    x: 1120,
    y: 890,
  };
  const data = plugin.normalizeData({
    subgraphs: [
      group('outer', [P + 'inner'], { x: 1000, y: 800 }),
      group('inner', ['a.md', 'b.md', gravity.id], { x: 1100, y: 850 }),
    ],
    saved_positions: {
      [P + 'outer']: { x: 1000, y: 800 },
      [P + 'inner']: { x: 1100, y: 850 },
      'a.md': { x: 1110, y: 880 },
      'b.md': { x: 1120, y: 880 },
    },
    pins: { 'a.md': { x: 1110, y: 880, mode: 'grid' } },
    orbit_pins: { 'b.md': { anchor_id: 'a.md', radius: 10, angle: 0 } },
    dark_energy: [gravity],
    subgraph_cameras: { [P + 'inner']: { x: 1100, y: 850, zoom: 1 } },
  });
  assert.equal(data.subgraph_coordinates, LOCAL_COORDINATES);
  assert.deepEqual(data.saved_positions[P + 'inner'], { x: 100, y: 50 });
  assert.deepEqual(data.saved_positions['a.md'], { x: 10, y: 30 });
  assert.equal(data.pins['a.md'].mode, 'grid');
  assert.equal(data.pins['a.md'].x, 10);
  assert.equal(data.orbit_pins['b.md'].anchor_id, 'a.md');
  assert.deepEqual(data.saved_positions[gravity.id], { x: 20, y: 40 });
  assert.deepEqual(data.subgraph_cameras, {});
  assert.deepEqual(plugin.normalizeData(data), data);
});

test('every projection is a separate graph: no expanded flag, outer handle or external links in inner panes', () => {
  const groups = [
    group('one', ['a', P + 'two'], { expanded: true }),
    group('two', ['b', 'c'], { expanded: true }),
  ];
  const graph = {
    nodes: ['a', 'b', 'c', 'd'].map((id) => ({ id })),
    edges: [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'd' },
      { source: 'c', target: 'd' },
    ],
  };
  assert.deepEqual(
    projectSubgraphs(graph, groups)
      .nodes.map((node) => node.id)
      .sort(),
    ['d', P + 'one'].sort()
  );
  assert.deepEqual(projectSubgraphs(graph, groups).edges, [{ source: P + 'one', target: 'd' }]);
  const inner = projectSubgraphs(graph, groups, P + 'one');
  assert.deepEqual(inner.nodes.map((node) => node.id).sort(), ['a', P + 'two'].sort());
  assert.deepEqual(inner.edges, [{ source: 'a', target: P + 'two' }]);
  assert.deepEqual(
    projectSubgraphs(graph, groups, P + 'two')
      .nodes.map((node) => node.id)
      .sort(),
    ['b', 'c']
  );
  assert.deepEqual(projectSubgraphs(graph, groups, 'missing'), { nodes: [], edges: [] });
});

test('creation converts positions and exact/grid pins to local coordinates; internal orbit settings survive', (t) => {
  const f = setup(t);
  f.plugin.setPin('a.md', { x: 0, y: 0 }, { mode: 'grid' });
  f.plugin.setOrbitPin('b.md', {
    anchor_id: 'a.md',
    radius: Math.hypot(100, 20),
    angle: Math.atan2(20, 100),
  });
  f.plugin.setNodeVisualSetting('a.md', 'node_size_scale', 2);
  f.makeGroup();
  assert.deepEqual(ids(f.view), [P + 'one', 'c.md', 'd.md'].sort());
  assert.deepEqual(point(f.view.nodeById.get(P + 'one')), { x: 50, y: 10 });
  assert.deepEqual(f.plugin.data.saved_positions['a.md'], { x: -50, y: -10 });
  assert.equal(f.plugin.getPin('a.md').x, -50);
  assert.equal(f.plugin.getPinMode('a.md'), 'grid');
  assert.equal(f.plugin.getOrbitPin('b.md').anchor_id, 'a.md');
  assert.equal(f.plugin.data.node_visual_settings['a.md'].node_size_scale, 2);
});

test('cross-space orbit pins become exact local pins rather than silently free nodes', (t) => {
  const f = setup(t);
  f.plugin.setOrbitPin('a.md', { anchor_id: 'c.md', radius: 200, angle: Math.PI });
  f.makeGroup();
  assert.equal(f.plugin.getOrbitPin('a.md'), null);
  assert.deepEqual(f.plugin.getPin('a.md'), { x: -50, y: -10, mode: 'exact' });
});

test('moving the ordinary parent container does not translate child runtime coordinates, local pins or saved offsets', async (t) => {
  const f = setup(t);
  f.plugin.setPin('a.md', { x: 0, y: 0 });
  f.makeGroup();
  const child = await f.child();
  const before = JSON.stringify({
    positions: f.plugin.data.saved_positions['a.md'],
    pin: f.plugin.getPin('a.md'),
    live: point(child.nodeById.get('a.md')),
  });
  const handle = f.view.nodeById.get(P + 'one');
  handle.x = 4000;
  handle.y = -900;
  assert.equal(
    JSON.stringify({
      positions: f.plugin.data.saved_positions['a.md'],
      pin: f.plugin.getPin('a.md'),
      live: point(child.nodeById.get('a.md')),
    }),
    before
  );
  assert('value' in Object.getOwnPropertyDescriptor(handle, 'x'));
  assert.equal(f.plugin.subgraphRuntime, undefined);
});

test('creation and Ungroup wake a sleeping parent before any pointer event; container uses external link physics', (t) => {
  const f = setup(t, {
    settings: { repel_strength: 0, center_strength: 0, base_link_strength: 100, link_distance: 10 },
  });
  assert.equal(f.view.layoutPaused, true);
  f.makeGroup();
  assert.equal(f.view.layoutPaused, false);
  assert.equal(f.view.layoutAutosaveDirty, true);
  const handle = f.view.nodeById.get(P + 'one');
  const before = handle.x;
  f.view.stepSimulation();
  assert(handle.x > before);
  f.view.layoutPaused = true;
  f.view.ungroupSubgraph(handle.id);
  assert.equal(f.view.layoutPaused, false);
  const a = f.view.nodeById.get('a.md');
  const initial = a.x;
  f.view.stepSimulation();
  assert.notEqual(a.x, initial);
});

test('new child starts physics immediately and never wakes or rearranges a paused parent', async (t) => {
  const f = setup(t, {
    settings: { repel_strength: 0, center_strength: 0, base_link_strength: 100, link_distance: 10 },
  });
  f.makeGroup();
  f.view.layoutPaused = true;
  const root = f.view.nodes.map((node) => ({ ...point(node), vx: node.vx, vy: node.vy }));
  const child = await f.child();
  assert.equal(child.layoutPaused, false);
  assert.deepEqual(ids(child), ['a.md', 'b.md']);
  const a = child.nodeById.get('a.md');
  const before = a.x;
  child.stepSimulation();
  assert.notEqual(a.x, before);
  assert.deepEqual(
    f.view.nodes.map((node) => ({ ...point(node), vx: node.vx, vy: node.vy })),
    root
  );
  assert.equal(f.view.layoutPaused, true);
  child.kickLayoutSearch();
  assert.equal(f.view.layoutPaused, true);
});

test('first opening waits for nonzero viewport, fits visible local coordinates and never centers the active file', async (t) => {
  const f = setup(t);
  f.makeGroup();
  const child = await f.child();
  child.nodeById.get('a.md').x = 150;
  child.nodeById.get('b.md').x = 250;
  child.nodeById.get('a.md').y = -100;
  child.nodeById.get('b.md').y = -50;
  child.cameraTarget = { x: 9000, y: 8000, zoom: 2 };
  f.app.workspace.getActiveFile = () => ({ path: 'a.md' });
  child.updateWrapHeightForKeyboard = () => {};
  child.updateCanvasBackgroundColor = () => {};
  child.canvasEl = {};
  child.ctx = { setTransform() {} };
  let size = { width: 0, height: 0 };
  child.wrapEl = { getBoundingClientRect: () => size };
  child.resizeCanvas();
  assert.equal(child.pendingSubgraphFit, true);
  assert.equal(child.cameraTarget.x, 9000);
  size = { width: 800, height: 600 };
  child.resizeCanvas();
  assert.equal(child.pendingSubgraphFit, false);
  assert.equal(child.cameraTarget.x, 200);
  assert.equal(child.cameraTarget.y, -75);
  assert.equal(child.cameraTarget.zoom, 2);
  const savedCamera = { ...child.cameraTarget };
  child.nodeById.get('a.md').x += 100;
  child.resizeCanvas();
  assert.deepEqual(child.cameraTarget, savedCamera, 'resize must not refit after first framing');
});

test('onOpen and subsequent setState do not reload the root, inherit its search, or pause a first-created inner pane', async (t) => {
  const f = setup(t, {
    view_state: { camera_saved: true, pan_x: 5000, pan_y: 4000, zoom: 2, search_query: 'name:c' },
  });
  f.makeGroup();
  f.view.layoutPaused = true;
  const leaf = { app: f.app };
  f.plugin.pendingSubgraphScopes = new WeakMap([[leaf, { id: P + 'one', layout: 'data.json' }]]);
  const child = new GraphFrontierView(leaf, f.plugin);
  child.render = () => {};
  for (const method of [
    'buildSidePanel',
    'buildQuickPreviewPanel',
    'updateCanvasBackgroundColor',
    'bindEvents',
    'installResizeObserver',
    'resizeCanvas',
    'runFrame',
  ])
    child[method] = () => {};
  t.mock.method(f.plugin, 'setActiveLayoutFile', () =>
    assert.fail('No global reload on child open')
  );
  await child.onOpen();
  await child.setState({ subgraph: { id: P + 'one', layout: 'data.json' } });
  assert.equal(child.searchInputValue, 'name:');
  assert.equal(child.layoutPaused, false);
  assert.deepEqual(ids(child), ['a.md', 'b.md']);
  assert.equal(f.view.layoutPaused, true);
});

for (const order of ['pending', 'restored', 'before-open', 'after-open']) {
  test(`saved child opens with physics and its own camera with ${order} scope initialization`, async (t) => {
    const camera = { x: 700, y: 800, zoom: 1.5 };
    const f = setup(t, {
      subgraphs: [group('one', ['a.md', 'b.md'])],
      saved_positions: { 'a.md': { x: -50, y: 0 }, 'b.md': { x: 50, y: 0 } },
      pins: { 'a.md': { x: -50, y: 0, mode: 'exact' } },
      subgraph_cameras: { [P + 'one']: camera },
      subgraph_filters: { [P + 'one']: { query: 'name:', mode: 'find' } },
      view_state: { camera_saved: true, pan_x: 5000, pan_y: 4000, zoom: 2, search_query: 'name:c' },
      settings: {
        repel_strength: 0,
        center_strength: 0,
        base_link_strength: 100,
        link_distance: 10,
      },
    });
    const root = f.view.nodes.map((node) => ({ ...point(node), vx: node.vx, vy: node.vy }));
    const scope = { id: P + 'one', layout: 'data.json' };
    const leaf = { app: f.app };
    if (order === 'pending') f.plugin.pendingSubgraphScopes = new WeakMap([[leaf, scope]]);
    if (order === 'restored') leaf.getViewState = () => ({ state: { subgraph: scope } });
    const child = new GraphFrontierView(leaf, f.plugin);
    for (const method of [
      'render',
      'buildSidePanel',
      'buildQuickPreviewPanel',
      'updateCanvasBackgroundColor',
      'bindEvents',
      'installResizeObserver',
      'resizeCanvas',
      'runFrame',
    ])
      child[method] = () => {};
    t.mock.method(f.plugin, 'setActiveLayoutFile', () =>
      assert.fail('No root reload on child entry')
    );
    if (order === 'before-open') await child.setState({ subgraph: scope });
    await child.onOpen();
    await child.setState({ subgraph: scope });
    assert.deepEqual(child.camera, camera);
    assert.deepEqual(child.cameraTarget, camera);
    assert.deepEqual(ids(child), ['a.md', 'b.md']);
    assert.equal(child.searchInputValue, 'name:');
    assert.equal(child.layoutPaused, false);
    assert.deepEqual(point(child.nodeById.get('b.md')), { x: 50, y: 0 });
    child.stepSimulation();
    const moved = point(child.nodeById.get('b.md'));
    assert.notEqual(moved.x, 50);
    assert.deepEqual(point(child.nodeById.get('a.md')), { x: -50, y: 0 });
    await child.setState({ subgraph: { ...scope } });
    assert.deepEqual(
      point(child.nodeById.get('b.md')),
      moved,
      'repeated state must not restore positions'
    );
    assert.equal(child.layoutPaused, false);
    assert.equal(f.view.layoutPaused, true);
    assert.deepEqual(
      f.view.nodes.map((node) => ({ ...point(node), vx: node.vx, vy: node.vy })),
      root
    );
    assert.equal(f.writes.length, 0);
  });
}

test('Ungroup uses current live container center plus latest local offsets, not original coordinates or stale pins', async (t) => {
  const f = setup(t);
  f.makeGroup();
  const child = await f.child();
  child.nodeById.get('a.md').x = -120;
  child.nodeById.get('a.md').y = 40;
  await child.pinNodeExact('a.md', { x: -120, y: 40 });
  f.plugin.setPin(P + 'one', { x: 50, y: 10 });
  const handle = f.view.nodeById.get(P + 'one');
  handle.x = 3000;
  handle.y = 2000;
  f.view.ungroupSubgraph(handle.id);
  assert.deepEqual(point(f.view.nodeById.get('a.md')), { x: 2880, y: 2040 });
  assert.deepEqual(f.plugin.getPin('a.md'), { x: 2880, y: 2040, mode: 'exact' });
  assert.deepEqual(point(f.view.nodeById.get('b.md')), { x: 3050, y: 2010 });
  assert.equal(f.plugin.data.subgraphs.length, 0);
  assert.deepEqual(ids(child), []);
  assert.equal(f.writes.length, 0);
});

test('nested grouping and Ungroup move immediate containers only; deeper local spaces and their cameras are unchanged', async (t) => {
  const f = setup(t);
  f.makeGroup();
  const one = await f.child();
  f.makeGroup([P + 'one', 'c.md'], 'outer');
  const outer = await f.child(P + 'outer');
  assert.deepEqual(ids(outer), [P + 'one', 'c.md'].sort());
  assert.deepEqual(ids(one), ['a.md', 'b.md']);
  one.cameraTarget = { x: 12, y: 34, zoom: 2 };
  const before = point(one.nodeById.get('a.md'));
  const container = f.view.nodeById.get(P + 'outer');
  container.x = 1000;
  container.y = 2000;
  f.view.ungroupSubgraph(container.id);
  assert.deepEqual(point(one.nodeById.get('a.md')), before);
  assert.deepEqual(one.cameraTarget, { x: 12, y: 34, zoom: 2 });
  assert.deepEqual(ids(outer), []);
  assert(f.view.nodeById.has(P + 'one'));
  assert(!f.view.nodeById.has('a.md'));
});

test('creation modal has exactly one name input and no membership UI; captured selection supplies members', (t) => {
  const f = setup(t);
  f.view.setNodeSelection(['a.md', 'b.md']);
  const modal = f.view.editSubgraph();
  const all = children(modal.contentEl);
  assert.equal(all.filter((el) => el.tag === 'input').length, 1);
  assert(
    !all.some(
      (el) => /Add selected|Remove/.test(el.text || '') || el.cls === 'graphfrontier-gravity-rules'
    )
  );
  all.find((el) => el.tag === 'input').value = 'Named group';
  f.view.setNodeSelection(['c.md']);
  all.find((el) => el.text === 'Save').events.click();
  assert.deepEqual(f.plugin.data.subgraphs[0].members, ['a.md', 'b.md']);
  assert.equal(f.plugin.data.subgraphs[0].name, 'Named group');
});

test('stale creation modal cannot write to a replacement layout', (t) => {
  const f = setup(t);
  f.view.setNodeSelection(['a.md']);
  const modal = f.view.editSubgraph();
  f.plugin.data = f.plugin.normalizeData({});
  children(modal.contentEl)
    .find((el) => el.text === 'Save')
    .events.click();
  assert.equal(f.plugin.data.subgraphs.length, 0);
  assert.match(notices.at(-1), /Layout changed/);
});

test('container context retains ordinary node actions and offers pane/rename/Ungroup, never expansion or membership UI', (t) => {
  const f = setup(t);
  f.makeGroup();
  const node = f.view.nodeById.get(P + 'one');
  const menu = buildNodeContextMenu(f.view, node, 0, 0);
  const titles = menu.items.map((item) => item.title || '');
  for (const title of [
    'Pin node',
    'Pin to grid',
    'Pin linked',
    'Visual settings',
    'Open subgraph in pane',
    'Rename subgraph',
    'Ungroup subgraph',
  ])
    assert(titles.includes(title), title);
  assert(!titles.some((title) => /expand|collapse|Add selected|Remove from|Dissolve/i.test(title)));
  const visual = menu.items.find((item) => item.title === 'Visual settings').submenu;
  assert(visual.items.some((item) => item.title === 'Strong pull'));
  assert(visual.items.some((item) => /edge/i.test(item.title)));
  assert.equal(f.view.toggleSubgraph, undefined);
});

test('single click selects and double click opens a normal split pane without ever expanding the root', async (t) => {
  const f = setup(t);
  f.makeGroup();
  const calls = [];
  f.app.workspace.openPopoutLeaf = () => assert.fail('Never open an OS window');
  f.app.workspace.getLeaf = (kind) => {
    calls.push(kind);
    return {
      async setViewState(state) {
        this.view = await f.child(state.state.subgraph.id);
      },
      view: null,
    };
  };
  f.app.workspace.revealLeaf = async () => {};
  f.view.canvasEl = { removeClass() {} };
  f.view.dragNodeId = P + 'one';
  f.view.onMouseUp({ button: 0, detail: 1 });
  assert(f.view.selectedNodeIds.has(P + 'one'));
  await f.view.openNodeFile(P + 'one');
  assert.deepEqual(calls, ['split']);
  assert(!f.view.nodeById.has('a.md'));
  await f.view.openSubgraphSeparately(P + 'one');
  assert.equal(calls.length, 1, 'reuse the existing pane');
});

test('closing an autosave-off inner pane keeps local edits but never reloads, expands, rearranges or wakes the parent', async (t) => {
  const f = setup(t);
  f.makeGroup();
  const child = await f.child();
  f.view.layoutPaused = true;
  child.nodeById.get('a.md').x = 777;
  child.cameraTarget = { x: 22, y: 33, zoom: 2 };
  const root = f.view.nodes.map(point);
  t.mock.method(child, 'loadSavedLayout', () => assert.fail('No child close reload'));
  await child.onClose();
  assert.deepEqual(f.view.nodes.map(point), root);
  assert.equal(f.view.layoutPaused, true);
  assert.equal(f.plugin.data.saved_positions['a.md'].x, 777);
  assert.equal(f.plugin.data.subgraph_cameras[P + 'one'].x, 22);
  assert.equal(f.writes.length, 0);
  assert(!f.view.nodeById.has('a.md'));
});

test('save from inner pane merges all local spaces and independent cameras/filters; explicit restoration stays paused', async (t) => {
  const f = setup(t);
  f.makeGroup();
  const child = await f.child();
  f.view.nodeById.get(P + 'one').x = 5000;
  f.view.cameraTarget = { x: 11, y: 22, zoom: 0.8 };
  f.view.apiVisibleNodeIds = new Set(['a.md', 'c.md']);
  child.nodeById.get('a.md').x = -123;
  child.cameraTarget = { x: 999, y: 888, zoom: 2 };
  child.searchMode = 'filter';
  child.searchInputValue = 'tag:green';
  child.apiVisibleNodeIds = new Set(['a.md']);
  assert(await child.saveCurrentLayout({ silent: true, allowSearch: true }));
  const saved = JSON.parse(f.files.get(f.layoutPath()));
  assert.equal(saved.saved_positions['a.md'].x, -123);
  assert.equal(saved.saved_positions[P + 'one'].x, 5000);
  assert.equal(saved.saved_positions['d.md'].x, 300);
  assert.equal(saved.view_state.pan_x, 11);
  assert.deepEqual(saved.view_state.node_filter, ['a.md', 'c.md']);
  assert.equal(saved.subgraph_cameras[P + 'one'].x, 999);
  assert.deepEqual(saved.subgraph_filters[P + 'one'], {
    query: 'tag:green',
    mode: 'filter',
    node_filter: ['a.md'],
  });
  await child.loadSavedLayout({ silent: true });
  assert.equal(child.layoutPaused, true);
  assert.equal(f.view.layoutPaused, true);
  assert.equal(child.cameraTarget.x, 999);
  assert.equal(f.view.cameraTarget.x, 11);
  assert.equal(child.searchInputValue, 'tag:green');
  assert.deepEqual([...child.apiVisibleNodeIds], ['a.md']);
  assert(!f.view.nodeById.has('a.md'));
  f.plugin.refreshAllViews({ passive: true });
  assert.equal(f.view.layoutPaused, true);
  assert.equal(child.layoutPaused, true);
});

test('autosave off remains off for independently running scopes; failed save retains dirty state', async (t) => {
  const f = setup(t);
  f.makeGroup();
  const child = await f.child();
  for (let index = 0; index < 20; index++) {
    f.view.stepSimulation();
    child.stepSimulation();
  }
  assert.equal(f.writes.length, 0);
  assert.equal(f.plugin.data.settings.layout_autosave, false);
  t.mock.method(f.plugin, 'persistActiveLayoutFile', async () => false);
  assert.equal(await child.saveCurrentLayout({ silent: true }), false);
  assert.equal(child.layoutAutosaveDirty, true);
});

test('a child closing during an outstanding save cannot lose its newer local coordinates', async (t) => {
  const f = setup(t);
  f.makeGroup();
  const child = await f.child();
  const gate = deferred();
  t.mock.method(f.plugin, 'persistActiveLayoutFile', async () => {
    await gate.promise;
    return true;
  });
  const pending = f.view.saveCurrentLayout({ silent: true });
  await new Promise((resolve) => setImmediate(resolve));
  child.nodeById.get('a.md').x = 987;
  await child.onClose();
  f.app.workspace.getLeavesOfType().splice(1);
  gate.resolve();
  assert(await pending);
  assert.equal(f.plugin.data.saved_positions['a.md'].x, 987);
  assert.equal(f.view.layoutAutosaveDirty, true);
});

test('layout switches and removed containers leave stale child panes empty and unable to save', async (t) => {
  const f = setup(t);
  f.makeGroup();
  const child = await f.child();
  f.plugin.data = f.plugin.normalizeData({
    active_layout_name: 'other.json',
    subgraph_coordinates: LOCAL_COORDINATES,
    subgraphs: [group('one', ['c.md'])],
  });
  child.refreshFromVault({ keepCamera: true, skipLayoutKick: true });
  assert.deepEqual(ids(child), []);
  assert.equal(await child.saveCurrentLayout({ silent: true }), false);
  child.persistViewState();
  assert.deepEqual(f.plugin.data.subgraph_cameras, {});
});

test('canonical whitelist/API filtering keeps matching handles, never resurrects notes or excluded links', async (t) => {
  const f = setup(t);
  f.plugin.data.whitelist = [{ id: 'green', query: 'tag:green', enabled: true }];
  f.view.apiVisibleNodeIds = new Set(['a.md', 'b.md', 'c.md']);
  f.makeGroup();
  assert(f.view.getFilterVisibleNodeIds().has(P + 'one'));
  const child = await f.child();
  const visible = child.getFilterVisibleNodeIds();
  assert(visible.has('a.md'));
  assert(!visible.has('b.md'));
  assert.equal(child.edges.length, 0);
  f.view.apiVisibleNodeIds = new Set(['b.md', 'c.md']);
  assert(!f.view.getFilterVisibleNodeIds().has(P + 'one'));
  f.view.apiVisibleNodeIds = null;
  f.plugin.data.blacklist = [{ id: 'group', query: 'name:one', enabled: true }];
  assert(!f.view.getFilterVisibleNodeIds().has(P + 'one'));
});

test('name-filter neighbors update after rules change; ordinary gravity visibility still respects API filtering', (t) => {
  const gravity = {
    id: 'graphfrontier:dark-energy:test',
    name: 'Gravity',
    queries: ['tag:green'],
    strength: 10,
    x: 900,
    y: 0,
  };
  const f = setup(t, { dark_energy: [gravity] });
  f.makeGroup();
  f.view.searchMode = 'filter';
  f.view.commitSearchSelectionFromInput('name:one');
  assert(f.view.getFilterVisibleNodeIds().has('c.md'));
  assert(f.view.getFilterVisibleNodeIds().has(gravity.id));
  f.plugin.data.blacklist = [{ id: 'c', query: 'name:c', enabled: true }];
  assert(!f.view.getFilterVisibleNodeIds().has('c.md'));
  f.plugin.data.blacklist = [];
  assert(f.view.getFilterVisibleNodeIds().has('c.md'));
  f.view.apiVisibleNodeIds = new Set(['a.md']);
  assert(!f.view.getFilterVisibleNodeIds().has(gravity.id));
});

test('gravity outside an inner graph cannot pull its members; gravity created inside stays local', async (t) => {
  const external = {
    id: 'graphfrontier:dark-energy:external',
    name: 'External',
    queries: ['tag:green'],
    strength: 100,
    x: 999,
    y: 999,
  };
  const f = setup(t, {
    dark_energy: [external],
    settings: { repel_strength: 0, center_strength: 0, base_link_strength: 0 },
  });
  Object.assign(f.plugin.data.settings, {
    repel_strength: 0,
    center_strength: 0,
    base_link_strength: 0,
  });
  f.makeGroup();
  const child = await f.child();
  assert.equal(getDarkEnergyTargets(child).size, 0);
  const a = child.nodeById.get('a.md');
  const before = point(a);
  child.stepSimulation();
  assert.deepEqual(point(a), before);
  const local = { ...external, id: 'graphfrontier:dark-energy:local', name: 'Local', x: 200, y: 0 };
  f.view.layoutPaused = true;
  child.setDarkEnergy(local);
  assert(child.nodeById.has(local.id));
  assert(!f.view.nodeById.has(local.id));
  assert.equal(f.view.layoutPaused, true);
  assert(
    getDarkEnergyTargets(child)
      .get('a.md')
      .every(({ item }) => item.id === local.id)
  );
  child.stepSimulation();
  assert(child.nodeById.get('a.md').x > before.x);
});

test('inner grid occupancy, align and unpin commands do not touch pins in the parent space', async (t) => {
  const f = setup(t);
  f.makeGroup();
  const child = await f.child();
  f.plugin.setPin('c.md', { x: 0, y: 0 }, { mode: 'grid' });
  await child.pinNodeToGrid('a.md', { x: 0, y: 0 });
  assert.equal(f.plugin.getPin('a.md').x, 0);
  f.plugin.setPin('c.md', { x: 3, y: 4 }, { mode: 'exact' });
  f.plugin.setPin('a.md', { x: 3, y: 4 }, { mode: 'grid' });
  await child.alignPinsToGrid();
  assert.deepEqual(f.plugin.getPin('c.md'), { x: 3, y: 4, mode: 'exact' });
  await child.commandUnpinAllNodes();
  assert.equal(f.plugin.getPin('a.md'), null);
  assert(f.plugin.getPin('c.md'));
});

test('MCP accepts create/rename/open/ungroup and rejects old toggle/membership actions; child node actions wake only that scope', async (t) => {
  const f = setup(t);
  const api = new GraphFrontierApi(f.plugin);
  const ref = (view = f.view) => {
    const state = api.state(view);
    return { viewId: state.viewId, contextToken: state.contextToken };
  };
  f.view.setNodeSelection(['a.md', 'b.md']);
  const created = await api.subgraphNodes({ ...ref(), action: 'create', name: 'API group' });
  const id = created.subgraph.id;
  assert.equal(api.getGraph(ref()).items.find((node) => node.id === id).type, 'subgraph');
  for (const action of ['expand', 'collapse', 'update', 'dissolve'])
    await assert.rejects(api.subgraphNodes({ ...ref(), action, id }), /Invalid|enum|option/i);
  await assert.rejects(
    api.subgraphNodes({
      ...ref(),
      action: 'rename',
      id,
      name: 'No membership edits',
      memberIds: ['a.md'],
    }),
    /Only creation/
  );
  await api.subgraphNodes({ ...ref(), action: 'rename', id, name: 'Renamed' });
  assert.equal(f.view.nodeById.get(id).label, 'Renamed');
  const child = await f.child(id);
  f.view.layoutPaused = true;
  await api.moveNodes({ ...ref(child), positions: [{ id: 'a.md', x: -9, y: 12 }] });
  assert.equal(f.view.layoutPaused, true);
  api.updateNodeSettings({ ...ref(child), nodeIds: ['a.md'], settings: {}, strongPull: true });
  assert.equal(f.view.layoutPaused, true);
  await api.subgraphNodes({ ...ref(), action: 'ungroup', id });
  assert(f.view.nodeById.has('a.md'));
});

test('renderer and hit target retain a thick hollow ring at tiny radii', (t) => {
  const f = setup(t);
  f.makeGroup();
  f.view.apiVisibleNodeIds = new Set([P + 'one']);
  f.view.viewWidth = 800;
  f.view.viewHeight = 600;
  f.view.camera.zoom = 0.01;
  let fills = 0;
  const strokes = [];
  const radii = [];
  const ctx = {
    beginPath() {},
    arc(x, y, radius) {
      radii.push(radius);
    },
    fill() {
      fills++;
    },
    stroke() {
      strokes.push(this.lineWidth);
    },
    fillText() {},
    measureText() {
      return { width: 10 };
    },
    save() {},
    restore() {},
  };
  render.drawNodes(f.view, ctx);
  assert.equal(fills, 0);
  assert(strokes.includes(3));
  assert.equal(radii[0], 2.6);
  assert(radii[0] - 1.5 > 0);
  const handle = f.view.nodeById.get(P + 'one');
  const visible = f.view.getFilterVisibleNodeIds();
  assert.equal(
    f.view.getNodeAtWorldByScan({ x: handle.x + 400, y: handle.y }, visible, true, 0.01, 1000),
    handle
  );
});

test('exports include only projected nodes/links and never hidden inner note contents', async (t) => {
  const f = setup(t);
  f.makeGroup();
  f.view.canvasEl = { clientWidth: 800, clientHeight: 600 };
  f.view.ctx = {};
  const { vault, contents } = mobileVault(t, false);
  Object.assign(f.app.vault, vault);
  f.app.vault.getAbstractFileByPath = (id) =>
    id.endsWith('.md') ? { path: id, extension: 'md' } : null;
  const reads = [];
  f.app.vault.cachedRead = async (file) => {
    reads.push(file.path);
    return `private-${file.path}`;
  };
  await f.view.commandExportStaticHtml({ exportPath: 'subgraphs.html' });
  const html = contents.get('subgraphs.html');
  assert(html.includes('"isSubgraph":true'));
  assert(!reads.includes('a.md'));
  assert(!reads.includes('b.md'));
  assert(!html.includes('private-a.md'));
});

test('missing members keep a usable container and local saved state without phantom notes', (t) => {
  const f = setup(t, {
    subgraphs: [group('missing', ['missing.md'])],
    saved_positions: { 'missing.md': { x: 17, y: 23 } },
    pins: { 'missing.md': { x: 17, y: 23 } },
  });
  assert(f.view.getFilterVisibleNodeIds().has(P + 'missing'));
  assert(!f.view.nodeById.has('missing.md'));
  assert.equal(f.view.captureLayoutSnapshot('data.json').saved_positions['missing.md'].x, 17);
});

test('passive metadata refresh compares topology, not filtered edges, and keeps restored graphs paused', async (t) => {
  const f = setup(t);
  f.makeGroup();
  f.view.apiVisibleNodeIds = new Set(['a.md', 'c.md']);
  await f.view.saveCurrentLayout({ silent: true });
  await f.view.loadSavedLayout({ silent: true });
  f.view.getFilterVisibleNodeIds();
  assert.equal(f.view.edges.length, 1);
  assert.equal(f.view.layoutPaused, true);
  f.view.refreshFromVault({ keepCamera: true, passive: true });
  assert.equal(f.view.layoutPaused, true);
  assert.equal(f.view.layoutAutosaveDirty, false);
});

test('autosave-on child close saves local coordinates without moving or waking the parent', async (t) => {
  const f = setup(t, { settings: { layout_autosave: true } });
  f.makeGroup();
  const child = await f.child();
  child.nodeById.get('a.md').x = -444;
  f.view.layoutPaused = true;
  const before = f.view.nodes.map(point);
  await child.onClose();
  assert.equal(JSON.parse(f.files.get(f.layoutPath())).saved_positions['a.md'].x, -444);
  assert.deepEqual(f.view.nodes.map(point), before);
  assert.equal(f.view.layoutPaused, true);
  assert(!f.view.nodeById.has('a.md'));
});

test('a closed local gravity member retains its fallback offset when Ungroup releases it', (t) => {
  const gravity = {
    id: 'graphfrontier:dark-energy:local',
    name: 'Local',
    queries: ['tag:green'],
    strength: 10,
    x: 20,
    y: 40,
  };
  const f = setup(t, { subgraphs: [group('one', [gravity.id])], dark_energy: [gravity] });
  const container = f.view.nodeById.get(P + 'one');
  container.x = 1000;
  container.y = 2000;
  f.view.ungroupSubgraph(container.id);
  assert.deepEqual(point(f.view.nodeById.get(gravity.id)), { x: 1020, y: 2040 });
});

test('initial inner fit fills the pane above zoom one while keeping node bounds inside modest padding', async (t) => {
  const f = setup(t);
  f.makeGroup();
  const child = await f.child();
  child.viewWidth = 400;
  child.viewHeight = 300;
  Object.assign(child.nodeById.get('a.md'), { x: -100, y: 0 });
  Object.assign(child.nodeById.get('b.md'), { x: 100, y: 0 });
  assert(child.finishSubgraphFraming());
  assert(child.camera.zoom > 1 && child.camera.zoom < 2);
  for (const node of child.nodes) {
    const screen = child.worldToScreen(node.x, node.y);
    const radius = child.getNodeRadius(node) * child.camera.zoom;
    assert(screen.x - radius >= 24 && screen.x + radius <= child.viewWidth - 24);
    assert(screen.y - radius >= 24 && screen.y + radius <= child.viewHeight - 24);
  }
});

test('single-node initial inner fit has a finite capped zoom rather than magnifying without bound', async (t) => {
  const f = setup(t);
  f.makeGroup(['a.md']);
  const child = await f.child();
  child.viewWidth = 1200;
  child.viewHeight = 800;
  assert(child.finishSubgraphFraming());
  assert.deepEqual(child.cameraTarget, { x: 0, y: 0, zoom: 2 });
  assert(Object.values(child.cameraTarget).every(Number.isFinite));
});

test('reopening a saved inner camera does not apply initial fit or the zoom-two cap', async (t) => {
  const f = setup(t);
  f.makeGroup();
  const saved = { x: 733, y: -422, zoom: 3.5 };
  f.plugin.data.subgraph_cameras[P + 'one'] = { ...saved };
  const child = await f.child();
  child.viewWidth = 800;
  child.viewHeight = 600;
  assert.equal(child.finishSubgraphFraming(), false);
  assert.deepEqual(child.cameraTarget, saved);
  assert.deepEqual(child.camera, saved);
});

test('ordinary main-graph fitting retains its existing center and zoom-one ceiling', (t) => {
  const { view } = setup(t);
  view.viewWidth = 1200;
  view.viewHeight = 800;
  view.fitCameraToNodes([view.nodeById.get('a.md'), view.nodeById.get('b.md')]);
  assert.deepEqual(view.cameraTarget, { x: 50, y: 10, zoom: 1 });
  assert.equal(view.finishSubgraphFraming(), false);
});

for (const order of ['pending', 'restored', 'before-open', 'after-open']) {
  test(`inner settings start hidden with ${order} scope initialization; manual Show survives refresh and repeated state`, async (t) => {
    const f = setup(t);
    f.makeGroup();
    const scope = { id: P + 'one', layout: 'data.json' };
    const leaf = { app: f.app };
    if (order === 'pending') f.plugin.pendingSubgraphScopes = new WeakMap([[leaf, scope]]);
    if (order === 'restored') leaf.getViewState = () => ({ state: { subgraph: scope } });
    const child = new GraphFrontierView(leaf, f.plugin);
    child.render = () => {};
    for (const method of [
      'buildQuickPreviewPanel',
      'updateCanvasBackgroundColor',
      'bindEvents',
      'installResizeObserver',
      'resizeCanvas',
      'runFrame',
    ])
      child[method] = () => {};
    const builds = [];
    const build = child.buildSidePanel.bind(child);
    child.buildSidePanel = () => {
      builds.push(child.sidePanelOpen);
      if (!child.sidePanelOpen) build();
    };
    if (order === 'before-open') await child.setState({ subgraph: scope });
    await child.onOpen();
    if (order === 'after-open') {
      assert.equal(child.sidePanelOpen, true);
      await child.setState({ subgraph: scope });
      assert.deepEqual(builds, [true, false]);
    } else assert.deepEqual(builds, [false]);
    assert.equal(child.sidePanelOpen, false);
    const show = children(child.sidePanelEl).find((el) => el.text === 'Show');
    assert(show, 'the normal Show button remains available');
    show.events.click();
    assert.equal(child.sidePanelOpen, true);
    assert.equal(builds.at(-1), true);
    await child.setState({ subgraph: { ...scope } });
    child.refreshFromVault({ keepCamera: true, passive: true });
    child.restoreLayoutViewState();
    assert.equal(child.sidePanelOpen, true, 'only initialization hides settings');
    assert.equal(f.view.sidePanelOpen, true, 'main graph settings are unchanged');
  });
}
