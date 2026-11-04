const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, loadSource } = require('./helpers/obsidian.cjs');
const render = loadSource('render.js');
const { NODE_VISUAL_SETTINGS, getEdgeVisualSetting } = loadSource('node-visuals.js');
const { LocalGraphFrontierView } = loadSource('local-view.js');
const { GraphFrontierApi } = loadSource('api.js');

function setup(t, data = {}) {
  const f = fixture(t, data);
  f.view.nodes = ['a', 'b', 'c'].map((id, i) => ({
    id,
    label: id,
    degree: 2,
    x: i * 35,
    y: 0,
    meta: { path: id, fileName: id, tags: ['#test'] },
  }));
  f.view.nodeById = new Map(f.view.nodes.map((node) => [node.id, node]));
  f.view.nodeMetaById = new Map(f.view.nodes.map((node) => [node.id, node.meta]));
  f.view.edges = [
    { source: 'a', target: 'b' },
    { source: 'b', target: 'c' },
  ];
  f.view.viewWidth = 500;
  f.view.viewHeight = 500;
  f.view.layoutPaused = true;
  const calls = { fills: [], arcs: [], labels: [], gradients: 0 };
  f.view.ctx = new Proxy(
    {
      arc(x, y, radius) {
        calls.arcs.push(radius);
      },
      fill() {
        calls.fills.push({ color: this.fillStyle, alpha: this.globalAlpha });
      },
      fillText(text) {
        calls.labels.push({ text, font: this.font, alpha: this.globalAlpha });
      },
      createRadialGradient() {
        calls.gradients++;
        return { addColorStop() {} };
      },
    },
    { get: (target, key) => (key in target ? target[key] : () => {}) }
  );
  const draw = () => {
    render.renderFrame(f.view);
    return f.view.appearanceCache;
  };
  return { ...f, calls, draw };
}

test('appearance cache survives repeated renders, camera and physics movement without group/workspace scans', (t) => {
  const f = setup(t, { groups: [{ query: 'tag:test', color: '#123456' }] });
  const groups = t.mock.method(f.plugin, 'getGroupVisualSettings');
  const leaves = t.mock.method(f.app.workspace, 'getLeavesOfType');
  const cached = f.draw();
  assert.equal(cached.nodeStyles.get('a').color, '#123456');
  for (let i = 0; i < 4; i++) {
    f.view.nodes[0].x += 5;
    f.view.nodes[0].vx = 0.1;
    f.view.camera.x += 2;
    f.view.camera.zoom *= 1.01;
    assert.equal(f.draw(), cached);
  }
  assert.equal(groups.mock.callCount(), 0);
  assert.equal(leaves.mock.callCount(), 0);
  assert.equal(cached.auraNodes.length, 0);
  assert.equal(f.calls.gradients, 0);
  assert.equal(cached.edgeStyles[0], cached.defaultLink);
  assert.equal(cached.edgeStyles[1], cached.defaultLink);
});

test('every sparse individual setting detects raw in-place mutation and deletion on the next render', (t) => {
  const f = setup(t);
  let before = f.draw();
  for (const spec of NODE_VISUAL_SETTINGS) {
    const value = spec.type === 'boolean' ? false : spec.type === 'color' ? '#abcdef' : spec.max;
    if (spec.key === 'label_font_size') f.plugin.data.node_label_sizes.a = value;
    else {
      f.plugin.data.node_visual_settings.a ||= {};
      f.plugin.data.node_visual_settings.a[spec.key] = value;
    }
    const after = f.draw();
    assert.notEqual(after, before, `${spec.key} mutation`);
    assert.equal(after.nodeStyles.get('a').individual[spec.key], value);
    if (spec.key === 'label_font_size') delete f.plugin.data.node_label_sizes.a;
    else delete f.plugin.data.node_visual_settings.a[spec.key];
    before = f.draw();
    assert.notEqual(before, after, `${spec.key} deletion`);
    assert.equal(before.nodeStyles.get('a').individual[spec.key], null);
  }
  f.plugin.data.painted_edge_colors.a = '#112233';
  assert.equal(f.draw().edgeStyles[0].edge_color, '#112233');
  f.plugin.data.painted_edge_colors.a = '#334455';
  assert.equal(f.draw().edgeStyles[0].edge_color, '#334455');
  delete f.plugin.data.painted_edge_colors.a;
  assert.equal(f.draw().edgeStyles[0].painted, false);
  assert.equal(f.view.layoutPaused, true);
});

test('individual setters, label changes, paint actions and visual reset invalidate without waking physics', (t) => {
  const f = setup(t);
  f.draw();
  f.plugin.setNodeVisualSetting('a', 'aura_radius', 250);
  assert.deepEqual(
    f.draw().auraNodes.map((node) => node.id),
    ['a']
  );
  assert(f.calls.gradients > 0);
  f.plugin.setNodeLabelSize('a', 18);
  assert.equal(f.draw().nodeStyles.get('a').fontSize, 3.6);
  f.plugin.setPaintedEdgeColor('a', '#445566');
  assert.equal(f.draw().edgeStyles[0].edge_color, '#445566');
  f.plugin.clearPaintedEdgeColor('a');
  assert.equal(f.draw().edgeStyles[0].painted, false);
  f.plugin.setNodeVisualSetting('a', 'edge_color', '#abcdef');
  assert.equal(f.draw().edgeStyles[0].edge_color, '#abcdef');
  f.plugin.resetNodeVisualSettings('a');
  const reset = f.draw();
  assert.equal(reset.auraNodes.length, 0);
  assert.equal(reset.nodeStyles.get('a').fontSize, f.plugin.getSettings().label_font_size / 5);
  assert.equal(reset.edgeStyles[0], reset.defaultLink);
  assert.equal(f.view.layoutPaused, true);
});

test('global scalars, nested group settings and list membership invalidate while preserving endpoint precedence', (t) => {
  const f = setup(t, {
    groups: [
      {
        id: 'g',
        query: 'list:L',
        color: '#123456',
        settings: { edge_color: '#222222', show_arrows: true },
      },
    ],
  });
  f.plugin.nodeListStore = { lists: [{ id: 'L', nodeIds: ['a', 'b'] }] };
  f.draw();
  f.plugin.data.groups[0].settings.edge_opacity = 0.4;
  f.plugin.data.groups[0].settings.aura_radius = 100;
  let after = f.draw();
  assert.equal(after.edgeStyles[0].edge_opacity, 0.4);
  assert.equal(after.auraNodes.length, 2);
  f.plugin.data.node_visual_settings.b = {
    edge_color: '#abcdef',
    show_arrows: false,
    reverse_arrows: false,
    edge_width_scale: 3,
  };
  f.plugin.data.node_visual_settings.a = { edge_color: '#fedcba', edge_width_scale: 1 };
  after = f.draw();
  for (const key of [
    'edge_color',
    'edge_width_scale',
    'edge_opacity',
    'show_arrows',
    'reverse_arrows',
  ])
    assert.equal(after.edgeStyles[0][key], getEdgeVisualSetting(f.plugin, 'a', 'b', key));
  assert.equal(after.edgeStyles[0].edge_color, '#fedcba');
  assert.equal(after.edgeStyles[0].edge_width_scale, 3);
  assert.equal(after.edgeStyles[0].show_arrows, false);
  f.plugin.nodeListStore.lists[0].nodeIds.splice(0, 2, 'c');
  after = f.draw();
  assert.deepEqual(
    after.auraNodes.map((node) => node.id),
    ['c']
  );
  f.plugin.data.settings.node_color = '#998877';
  assert.equal(f.draw().nodeStyles.get('a').color, '#998877');
  f.plugin.data.settings.label_font_size = 15;
  assert.equal(f.draw().nodeStyles.get('a').fontSize, 3);
  f.plugin.data.settings.edge_opacity = 0.2;
  f.plugin.updateGroups([]);
  assert.equal(f.draw().edgeStyles[0].edge_opacity, 0.2);
});

test('degree, hover, selection, label text and theme remain dynamic with prepared styles', (t) => {
  const f = setup(t, { settings: { dim_low_degree_nodes: true } });
  f.view.camera.zoom = 5;
  const cached = f.draw();
  const radius = f.calls.arcs[0];
  f.calls.arcs.length = 0;
  f.calls.fills.length = 0;
  f.view.nodes[0].degree = 0;
  f.view.nodes[0].label = 'new label';
  assert.equal(f.draw(), cached);
  assert(f.calls.arcs[0] < radius);
  assert.equal(f.calls.fills[0].alpha, 0.65);
  assert(f.calls.labels.some((label) => label.text === 'new label'));
  f.view.selectedNodeIds.add('a');
  f.calls.fills.length = 0;
  assert.equal(f.draw(), cached);
  assert.equal(f.calls.fills[0].alpha, 1);
  f.view.selectedNodeIds.clear();
  f.view.hoverNodeId = 'a';
  f.calls.fills.length = 0;
  assert.equal(f.draw(), cached);
  assert.equal(f.calls.fills[0].alpha, 1);
  f.view.canvasTheme = { ...f.view.canvasTheme, mutedText: '#778899' };
  assert.equal(f.draw().defaultLink.edge_color, '#778899');
});

test('graph metadata, projection edges and data/layout replacement invalidate prepared styles', (t) => {
  const f = setup(t, { groups: [{ query: 'tag:test', color: '#123456' }] });
  const before = f.draw();
  f.view.nodes[0].meta.tags = [];
  f.view.markGraphVisibilityDirty();
  assert.notEqual(f.draw(), before);
  assert.equal(f.view.appearanceCache.nodeStyles.get('a').color, f.plugin.getSettings().node_color);
  // Like subgraph filtering, visibility can project links and reset degrees at draw entry.
  const edges = [{ source: 'a', target: 'c', bidirectional: true }];
  let project = true;
  f.view.getFilterVisibleNodeIds = () => {
    if (project) {
      f.view.edges = edges;
      f.view.nodes[0].degree = 1;
      project = false;
    }
    return null;
  };
  assert.equal(f.draw().edgeStyles.length, 1);
  f.plugin.data = f.plugin.normalizeData({
    render_model: 2,
    node_visual_settings: { a: { node_color: '#abcdef' } },
    node_label_sizes: { a: 20 },
  });
  assert.equal(f.draw().nodeStyles.get('a').color, '#abcdef');
  assert.equal(f.view.appearanceCache.nodeStyles.get('a').fontSize, 4);
});

test('pending DPR migration invalidates warm per-node-only link widths', (t) => {
  const f = setup(t, { render_model: 1, node_visual_settings: { a: { edge_width_scale: 0.5 } } });
  const globalWidth = f.plugin.getSettings().edge_width_scale;
  assert.equal(f.draw().edgeStyles[0].edge_width_scale, 0.5);
  assert.equal(f.plugin.applyPendingRenderMigration(2), true);
  assert.equal(f.plugin.getSettings().edge_width_scale, globalWidth);
  assert.equal(f.draw().edgeStyles[0].edge_width_scale, 1);
});

test('API edits refresh cached global and individual styles immediately', async (t) => {
  const f = setup(t);
  const api = new GraphFrontierApi(f.plugin);
  const ref = () => {
    const row = api.listViews().views[0];
    return { viewId: row.viewId, contextToken: row.contextToken };
  };
  f.draw();
  api.updateSettings({ ...ref(), settings: { edge_opacity: 0.25, label_font_size: 17 } });
  assert.equal(f.draw().defaultLink.edge_opacity, 0.25);
  api.updateNodeSettings({
    ...ref(),
    nodeIds: ['a'],
    settings: { node_color: '#abcdef', label_font_size: 19 },
  });
  assert.equal(f.draw().nodeStyles.get('a').color, '#abcdef');
  assert.equal(f.view.appearanceCache.nodeStyles.get('a').fontSize, 3.8);
  api.updateNodeSettings({ ...ref(), nodeIds: ['a'], settings: {}, reset: true });
  assert.equal(f.draw().nodeStyles.get('a').fontSize, 3.4);
});

test('local raw edits, setters, groups and local Load invalidate without leaking owner appearance', async (t) => {
  const f = setup(t);
  const global = f.draw();
  const leaf = { app: f.app, getViewState: () => ({ state: {} }) };
  const local = new LocalGraphFrontierView(leaf, f.plugin);
  leaf.view = local;
  local.nodes = f.view.nodes;
  local.nodeById = f.view.nodeById;
  local.nodeMetaById = f.view.nodeMetaById;
  local.edges = f.view.edges;
  const get = () => render.getPreparedAppearance(local);
  get();
  local.plugin.setNodeLabelSize('a', 20);
  assert.equal(get().nodeStyles.get('a').fontSize, 4);
  local.plugin.data.node_visual_settings.a = { edge_color: '#123456' };
  assert.equal(get().edgeStyles[0].edge_color, '#123456');
  local.plugin.data.painted_edge_colors.a = '#654321';
  assert.equal(
    get().edgeStyles[0].edge_color,
    '#123456',
    'modern individual color retains priority'
  );
  delete local.plugin.data.node_visual_settings.a.edge_color;
  assert.equal(get().edgeStyles[0].edge_color, '#654321');
  local.localSaved = JSON.parse(JSON.stringify(local.plugin.data));
  local.plugin.resetNodeVisualSettings('a');
  assert.equal(get().edgeStyles[0].painted, false);
  await local.loadSavedLayout({ silent: true });
  assert.equal(get().edgeStyles[0].edge_color, '#654321');
  assert.equal(f.draw(), global);
  local.plugin.data.groups = [
    { query: 'tag:test', color: '#112233', settings: { aura_radius: 100 } },
  ];
  assert.equal(get().nodeStyles.get('a').color, '#112233');
  assert.equal(get().auraNodes.length, 3);
  assert.equal(f.draw(), global);
});
