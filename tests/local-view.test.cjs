const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, loadSource } = require('./helpers/obsidian.cjs');
const { LocalGraphFrontierView } = loadSource('local-view.js');
const { LOCAL_GRAPHFRONTIER_VIEW_TYPE, GRAPHFRONTIER_VIEW_TYPE } = require('../src/constants');

function setup(t) {
  const f = fixture(t, { settings: { hide_orphans: true, layout_autosave: false } });
  let active = { path: 'one/a.md', extension: 'md' };
  let saves = 0;
  const localLeaves = [];
  const globalLeaves = [{ view: f.view }];
  f.app.workspace.getLeavesOfType = (type) =>
    type === LOCAL_GRAPHFRONTIER_VIEW_TYPE
      ? localLeaves
      : type === GRAPHFRONTIER_VIEW_TYPE
        ? globalLeaves
        : [];
  f.app.workspace.getActiveFile = () => active;
  f.app.workspace.requestSaveLayout = () => {
    saves++;
  };
  f.graph.nodes = ['one/a.md', 'two/a.md', 'b.md', 'c.md', 'd.md'].map((id) => ({
    id,
    label: id.split('/').pop(),
    meta: {},
  }));
  f.graph.edges = [
    { source: 'one/a.md', target: 'b.md' },
    { source: 'c.md', target: 'one/a.md' },
    { source: 'b.md', target: 'c.md' },
    { source: 'two/a.md', target: 'd.md' },
  ];
  const leaf = { app: f.app, getViewState: () => ({ state: {} }) };
  const view = new LocalGraphFrontierView(leaf, f.plugin);
  leaf.view = view;
  localLeaves.push(leaf);
  view.render = () => {};
  view.buildSidePanel = () => {};
  view.isOpen = true;
  view.followFile(active);
  view.refreshFromVault({ keepCamera: true, skipLayoutKick: true });
  return {
    ...f,
    local: view,
    leaf,
    localLeaves,
    globalLeaves,
    setActive: (file) => {
      active = file;
    },
    saves: () => saves,
  };
}

test('local graph uses exact path, inbound and outbound neighbors and induced edges', (t) => {
  const f = setup(t);
  assert.deepEqual(f.local.nodes.map((n) => n.id).sort(), ['b.md', 'c.md', 'one/a.md']);
  assert.equal(f.local.edges.length, 3);
  f.plugin.followLocalGraphFile({ path: 'two/a.md', extension: 'md' });
  assert.deepEqual(f.local.nodes.map((n) => n.id).sort(), ['d.md', 'two/a.md']);
  f.plugin.followLocalGraphFile(null);
  f.plugin.followLocalGraphFile({ path: 'x.pdf', extension: 'pdf' });
  assert.equal(f.local.localPath, 'two/a.md');
});

test('facade isolates settings, pins, visual actions, saves and workspace snapshot from global views', async (t) => {
  const f = setup(t);
  const before = structuredClone(f.plugin.data);
  f.local.plugin.setPin('b.md', { x: 55, y: 77 });
  f.local.plugin.setNodeVisualSetting('b.md', 'node_size_scale', 2);
  f.local.plugin.data.settings.show_grid = false;
  f.local.plugin.data.settings.search_mode = 'filter';
  f.local.searchMode = 'filter';
  f.local.nodes[0].x = 999;
  await f.local.saveCurrentLayout({ silent: true });
  assert.deepEqual(f.plugin.data, before);
  assert.equal(f.writes.length, 0);
  assert.equal(f.preferences.length, 0);
  assert.ok(f.saves() > 0);
  const globalSnapshot = f.view.captureLayoutSnapshot('data.json');
  assert.notEqual(globalSnapshot.saved_positions[f.local.nodes[0].id]?.x, 999);
  const state = f.local.getState();
  assert.equal(state.local.data.pins['b.md'].x, 55);
  f.local.plugin.data.settings.show_grid = true;
  f.local.searchMode = 'find';
  await f.local.loadSavedLayout({ silent: true });
  assert.equal(f.local.plugin.data.settings.show_grid, false);
  assert.equal(f.local.searchMode, 'filter');
  assert.deepEqual(f.plugin.data, before);
  assert.equal(f.writes.length, 0);
});

test('leaf state restores local settings and uses currently active note', async (t) => {
  const f = setup(t);
  f.local.plugin.setPin('b.md', { x: 10, y: 12 });
  await f.local.saveCurrentLayout({ silent: true });
  const state = f.local.getState();
  f.setActive({ path: 'two/a.md', extension: 'md' });
  const leaf = { app: f.app, getViewState: () => ({ state }) };
  const local = new LocalGraphFrontierView(leaf, f.plugin);
  leaf.view = local;
  f.localLeaves.push(leaf);
  local.render = () => {};
  local.buildSidePanel = () => {};
  local.isOpen = true;
  await local.setState(state);
  assert.equal(local.localPath, 'two/a.md');
  assert.equal(local.plugin.getPin('b.md').x, 10);
  assert.deepEqual(local.nodes.map((n) => n.id).sort(), ['d.md', 'two/a.md']);
  assert.notEqual(local.plugin.data, f.local.plugin.data);
});

test('vault refresh reaches local panes without replacing their data or touching global layout', (t) => {
  const f = setup(t);
  const localData = f.local.plugin.data;
  f.graph.edges.push({ source: 'one/a.md', target: 'd.md' });
  f.plugin.refreshLocalViews({ passive: true });
  assert.equal(f.local.plugin.data, localData);
  assert.ok(f.local.nodeById.has('d.md'));
  assert.equal(f.writes.length, 0);
});

test('active note events, metadata refresh and rename reach local view only through scoped dispatch', async (t) => {
  const f = setup(t);
  f.plugin.bootstrapActiveLayoutData = async () => true;
  await f.plugin.onload();
  f.events['file-open']({ path: 'two/a.md', extension: 'md' });
  assert.equal(f.local.localPath, 'two/a.md');
  f.events['active-leaf-change']({ view: { file: { path: 'one/a.md', extension: 'md' } } });
  assert.equal(f.local.localPath, 'one/a.md');
  f.events['active-leaf-change']({ view: {} });
  assert.equal(f.local.localPath, 'one/a.md');
  f.graph.edges.push({ source: 'one/a.md', target: 'd.md' });
  f.events.resolved();
  f.flushTimers();
  assert.ok(f.local.nodeById.has('d.md'));
  f.graph.nodes[0].id = 'renamed.md';
  for (const edge of f.graph.edges) {
    if (edge.source === 'one/a.md') edge.source = 'renamed.md';
    if (edge.target === 'one/a.md') edge.target = 'renamed.md';
  }
  f.events.rename({ path: 'renamed.md', extension: 'md' }, 'one/a.md');
  assert.equal(f.local.localPath, 'renamed.md');
  assert.ok(f.local.nodeById.has('renamed.md'));
  assert.equal(f.writes.length, 0);
});

test('global refresh and scoped save never merge local coordinates or overwrite local state', async (t) => {
  const f = setup(t);
  const local = f.local;
  local.plugin.data.settings.show_grid = false;
  local.nodes[0].x = 98765;
  const oldRefresh = local.refreshFromVault;
  local.refreshFromVault = () => assert.fail('Global refresh entered local view');
  f.plugin.refreshAllViews({ forceSavedPositions: true });
  local.refreshFromVault = oldRefresh;
  await f.view.saveCurrentLayout({ silent: true });
  assert.notEqual(f.plugin.data.saved_positions[local.nodes[0].id]?.x, 98765);
  assert.equal(local.plugin.data.settings.show_grid, false);
  assert.equal(f.preferences.length, 0);
});

test('open command captures the note before activating the separate leaf and reuses it', async (t) => {
  const f = setup(t);
  f.localLeaves.length = 0;
  let opened = 0;
  let revealed = 0;
  f.app.workspace.getLeaf = (kind) => {
    assert.equal(kind, 'split');
    return {
      app: f.app,
      async setViewState(state) {
        assert.equal(state.type, LOCAL_GRAPHFRONTIER_VIEW_TYPE);
        opened++;
        f.setActive(null);
        this.view = new LocalGraphFrontierView(this, f.plugin);
        this.view.render = () => {};
        this.view.buildSidePanel = () => {};
        f.localLeaves.push(this);
      },
    };
  };
  f.app.workspace.revealLeaf = async () => {
    revealed++;
  };
  await f.plugin.openLocalGraphFrontierView();
  assert.equal(f.localLeaves[0].view.localPath, 'one/a.md');
  f.setActive({ path: 'two/a.md', extension: 'md' });
  await f.plugin.openLocalGraphFrontierView();
  assert.equal(f.localLeaves[0].view.localPath, 'two/a.md');
  assert.equal(opened, 1);
  assert.equal(revealed, 2);
});

test('scoped scheduled refresh does not cancel owner timer or refresh other local views', (t) => {
  const f = setup(t);
  const leaf = { app: f.app, getViewState: () => ({ state: {} }) };
  const other = new LocalGraphFrontierView(leaf, f.plugin);
  leaf.view = other;
  f.localLeaves.push(leaf);
  const calls = [];
  f.view.refreshFromVault = (opts) => calls.push(['global', opts]);
  f.local.refreshFromVault = (opts) => calls.push(['first', opts]);
  other.refreshFromVault = (opts) => calls.push(['second', opts]);
  f.plugin.scheduleRefreshAllViews({ metadataResolved: true });
  const ownerTimer = f.plugin._refreshTimer;
  f.local.plugin.scheduleRefreshAllViews({ passive: true });
  f.local.plugin.scheduleRefreshAllViews({ skipLayoutKick: true });
  assert.equal(f.plugin._refreshTimer, ownerTimer);
  assert.notEqual(f.local.plugin._refreshTimer, ownerTimer);
  assert.deepEqual(f.plugin._pendingRefreshOptions, { metadataResolved: true });
  assert.deepEqual(f.local.plugin._pendingRefreshOptions, { passive: true, skipLayoutKick: true });
  f.flushTimers();
  assert.equal(calls.filter(([id]) => id === 'global').length, 1);
  assert.equal(calls.filter(([id]) => id === 'second').length, 1);
  assert.equal(calls.filter(([id]) => id === 'first').length, 2);
  assert.deepEqual(calls.at(-1), [
    'first',
    { keepCamera: true, passive: true, skipLayoutKick: true },
  ]);
});

test('closing a local view cancels its pending refresh and ignores later scheduling', async (t) => {
  const f = setup(t);
  let refreshes = 0;
  f.local.refreshFromVault = () => {
    refreshes++;
  };
  f.local.plugin.scheduleRefreshAllViews({ passive: true });
  await f.local.onClose();
  f.local.plugin.scheduleRefreshAllViews({ passive: true });
  f.flushTimers();
  assert.equal(refreshes, 0);
  assert.equal(f.local.plugin._refreshTimer, null);
  assert.deepEqual(f.local.plugin._pendingRefreshOptions, {});
});

test('switching notes retains departing and shared node coordinates only in local state', (t) => {
  const f = setup(t);
  const ownerBefore = structuredClone(f.plugin.data);
  const departing = f.local.nodeById.get('one/a.md');
  departing.x = 345;
  departing.y = -234;
  f.local.followFile({ path: 'two/a.md', extension: 'md' });
  assert.deepEqual(f.local.plugin.data.saved_positions['one/a.md'], { x: 345, y: -234 });
  f.local.followFile({ path: 'one/a.md', extension: 'md' });
  assert.equal(f.local.nodeById.get('one/a.md').x, 345);
  assert.equal(f.local.nodeById.get('one/a.md').y, -234);
  assert.deepEqual(f.plugin.data, ownerBefore);
});

test('side panel sections and suggestion cache do not alias owner state', (t) => {
  const f = setup(t);
  f.plugin.data.view_state.side_panel_sections = { layout: true };
  f.plugin.groupSuggestionIndex = { tags: new Set(['owner']) };
  const leaf = { app: f.app, getViewState: () => ({ state: {} }) };
  const other = new LocalGraphFrontierView(leaf, f.plugin);
  assert.notEqual(
    other.plugin.data.view_state.side_panel_sections,
    f.plugin.data.view_state.side_panel_sections
  );
  other.plugin.data.view_state.side_panel_sections.layout = false;
  assert.equal(f.plugin.data.view_state.side_panel_sections.layout, true);
  assert.equal(other.plugin.groupSuggestionIndex, null);
  assert.notEqual(other.plugin.pendingSubgraphScopes, f.plugin.pendingSubgraphScopes);
});

test('fresh local pane ignores global camera and centers on active note, including early state read', async (t) => {
  const f = setup(t);
  Object.assign(f.plugin.data.view_state, {
    camera_saved: true,
    pan_x: 7000,
    pan_y: -6000,
    zoom: 3,
  });
  f.plugin.data.saved_positions = {
    'one/a.md': { x: 10, y: 20 },
    'b.md': { x: 110, y: 20 },
    'c.md': { x: 10, y: 120 },
  };
  f.plugin.metadataResolvedOnce = false;
  const leaf = { app: f.app, getViewState: () => ({ state: {} }) };
  const local = new LocalGraphFrontierView(leaf, f.plugin);
  leaf.view = local;
  f.localLeaves.push(leaf);
  for (const method of [
    'buildSidePanel',
    'buildQuickPreviewPanel',
    'updateCanvasBackgroundColor',
    'bindEvents',
    'installResizeObserver',
    'resizeCanvas',
    'runFrame',
    'render',
  ])
    local[method] = () => {};
  local.viewWidth = 400;
  local.viewHeight = 400;
  assert.equal(local.getState().local.data.view_state.camera_saved, false);
  assert.deepEqual(local.camera, { x: 0, y: 0, zoom: 1 });
  f.plugin.metadataResolvedOnce = true;
  assert.equal(local.plugin.metadataResolvedOnce, true);
  await local.onOpen();
  assert.deepEqual({ x: local.cameraTarget.x, y: local.cameraTarget.y }, { x: 10, y: 20 });
  assert.notEqual(local.cameraTarget.zoom, 3);
  assert.equal(f.plugin.data.view_state.pan_x, 7000);
  assert.equal(f.plugin.data.view_state.camera_saved, true);
});

test('restored local pane preserves its own saved camera', async (t) => {
  const f = setup(t);
  const data = structuredClone(f.local.plugin.data);
  Object.assign(data.view_state, { camera_saved: true, pan_x: 31, pan_y: -42, zoom: 1.5 });
  const leaf = { app: f.app, getViewState: () => ({ state: { local: { data } } }) };
  const local = new LocalGraphFrontierView(leaf, f.plugin);
  leaf.view = local;
  f.localLeaves.push(leaf);
  for (const method of [
    'buildSidePanel',
    'buildQuickPreviewPanel',
    'updateCanvasBackgroundColor',
    'bindEvents',
    'installResizeObserver',
    'resizeCanvas',
    'runFrame',
    'render',
  ])
    local[method] = () => {};
  await local.onOpen();
  assert.deepEqual(local.cameraTarget, { x: 31, y: -42, zoom: 1.5 });
});

test('note menu uses the native linked-view section and captures its file', async (t) => {
  const f = setup(t);
  f.plugin.bootstrapActiveLayoutData = async () => true;
  await f.plugin.onload();
  const entries = [];
  const menu = {
    addItem(build) {
      const item = {
        setSection(value) {
          this.section = value;
          return this;
        },
        setTitle(value) {
          this.title = value;
          return this;
        },
        setIcon() {
          return this;
        },
        onClick(fn) {
          this.click = fn;
          return this;
        },
      };
      build(item);
      entries.push(item);
    },
  };
  const file = { path: 'two/a.md', extension: 'md' };
  const calls = [];
  f.plugin.openLocalGraphFrontierView = (target) => calls.push(target);
  f.events['file-menu'](menu, file, 'more-options', f.leaf);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].section, 'view.linked');
  assert.equal(entries[0].title, 'Open local GraphFrontier');
  entries[0].click();
  assert.equal(calls[0], file);
  for (const source of ['graphfrontier', 'sidebar-context-menu'])
    f.events['file-menu'](menu, file, source, f.leaf);
  f.events['file-menu'](menu, { path: 'x.pdf', extension: 'pdf' }, 'more-options', f.leaf);
  f.events['file-menu'](menu, file, 'more-options', null);
  assert.equal(entries.length, 1);
});

test('explicit local-graph target wins over another active note', async (t) => {
  const f = setup(t);
  f.app.workspace.revealLeaf = async () => {};
  await f.plugin.openLocalGraphFrontierView({ path: 'two/a.md', extension: 'md' });
  assert.equal(f.local.localPath, 'two/a.md');
  assert.deepEqual(f.local.nodes.map((n) => n.id).sort(), ['d.md', 'two/a.md']);
});

test('local camera centers the explicit menu target rather than its active neighbor', (t) => {
  const f = setup(t);
  f.local.plugin.setPin('b.md', { x: 550, y: 120 });
  f.local.followFile({ path: 'b.md', extension: 'md' });
  assert.equal(f.app.workspace.getActiveFile().path, 'one/a.md');
  assert.ok(f.local.nodeById.has('one/a.md'));
  const target = f.local.nodeById.get('b.md');
  assert.deepEqual(
    { x: f.local.cameraTarget.x, y: f.local.cameraTarget.y },
    { x: target.x, y: target.y }
  );
  assert.equal(target.x, 550);
});

test('local settings start hidden without changing the global panel default', (t) => {
  const f = setup(t);
  assert.equal(f.local.sidePanelOpen, false);
  assert.equal(f.view.sidePanelOpen, true);
  f.local.sidePanelOpen = true;
  f.local.followFile({ path: 'b.md', extension: 'md' });
  assert.equal(f.local.sidePanelOpen, true);
});
