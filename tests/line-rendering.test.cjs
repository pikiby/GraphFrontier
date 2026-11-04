const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, loadSource } = require('./helpers/obsidian.cjs');
const { EXTENDED_TOOLS } = require('../src/api-tools');
const render = loadSource('render.js');
const {
  getNodeScreenRadius,
  getNodeWorldRadius,
  getEdgeCssWidth,
  setCrispStroke,
  getCrispCoordinate,
  getFocusEdgeWidth,
  getFocusEdgeColor,
  getLowDegreeAlpha,
  getLinkArrowSegments,
} = loadSource('render-metrics.js');
const { getNodeVisualSetting } = loadSource('node-visuals.js');

function strokeRecorder() {
  const strokes = [];
  const segments = [];
  const arcs = [];
  const ctx = {
    lineWidth: 1,
    globalAlpha: 1,
    strokeStyle: '',
    fillStyle: '',
    save() {},
    restore() {},
    beginPath() {
      this.segments = 0;
    },
    moveTo() {
      this.segments = (this.segments || 0) + 1;
    },
    lineTo() {},
    arc(x, y, radius) {
      arcs.push(radius);
    },
    fill() {},
    fillText() {},
    fillRect() {},
    setLineDash() {},
    stroke() {
      strokes.push({ width: this.lineWidth, alpha: this.globalAlpha, style: this.strokeStyle });
      segments.push(this.segments || 0);
    },
    strokeRect() {
      this.stroke();
    },
  };
  return { ctx, strokes, segments, arcs };
}

function edgeView(t, settings = {}) {
  const { view, plugin } = fixture(t, { settings });
  view.nodes = [
    { id: 'a', x: 0, y: 0, degree: 1 },
    { id: 'b', x: 50, y: 0, degree: 1 },
  ];
  view.nodeById = new Map(view.nodes.map((node) => [node.id, node]));
  view.edges = [{ source: 'a', target: 'b' }];
  view.viewWidth = 400;
  view.viewHeight = 400;
  return { view, plugin };
}

test('low-degree dimming uses established degree and highlights restore full opacity', (t) => {
  const { view, plugin } = edgeView(t, { dim_low_degree_nodes: true });
  view.nodes[0].degree = 0;
  view.nodes[1].degree = 2;
  const { ctx } = strokeRecorder();
  const alphas = [];
  ctx.fill = function () {
    alphas.push(this.globalAlpha);
  };
  render.drawNodes(view, ctx);
  assert.deepEqual(alphas, [0.65, 1]);
  alphas.length = 0;
  view.hoverNodeId = 'a';
  render.drawNodes(view, ctx);
  assert.equal(alphas[0], 1);
  alphas.length = 0;
  view.hoverNodeId = null;
  view.selectedNodeIds.add('a');
  render.drawNodes(view, ctx);
  assert.equal(alphas[0], 1);
  view.selectedNodeIds.clear();
  view.searchMode = 'find';
  view.searchMatchedNodeIds = new Set(['a']);
  alphas.length = 0;
  render.drawNodes(view, ctx);
  assert.equal(alphas[0], 1);
  plugin.data.settings.dim_low_degree_nodes = false;
  for (const degree of [0, 1, 2]) assert.equal(getLowDegreeAlpha(false, degree, false), 1);
});

test('arrows follow stored source, reverse only visuals and reciprocal links draw both heads', (t) => {
  const forward = getLinkArrowSegments(0, 0, 100, 0, 5, 7, false, false, 1);
  const reverse = getLinkArrowSegments(0, 0, 100, 0, 5, 7, true, false, 1);
  assert.equal(forward[2], 91);
  assert.equal(reverse[2], 7);
  assert.equal(getLinkArrowSegments(0, 0, 100, 0, 5, 7, false, true, 1).length, 16);
  assert.deepEqual(getLinkArrowSegments(0, 0, 2, 0, 5, 7, false, true, 1), []);
  const { view, plugin } = edgeView(t, { show_arrows: true });
  const original = JSON.stringify(view.edges);
  for (const [reciprocal, expected] of [
    [false, 3],
    [true, 5],
  ]) {
    view.edges[0].bidirectional = reciprocal;
    const { ctx, segments } = strokeRecorder();
    render.drawEdges(view, ctx);
    assert.deepEqual(segments, [expected]);
  }
  delete view.edges[0].bidirectional;
  plugin.data.settings.reverse_arrows = true;
  const { ctx } = strokeRecorder();
  render.drawEdges(view, ctx);
  assert.equal(JSON.stringify(view.edges), original);
});

test('prepared link styles avoid group/workspace lookups and refresh on mutable settings', (t) => {
  const { view, plugin } = edgeView(t, { show_arrows: true });
  view.nodes.push({ id: 'c', x: 100, y: 0, degree: 2 });
  view.nodeById.set('c', view.nodes[2]);
  view.edges.push({ source: 'b', target: 'c' }, { source: 'a', target: 'c' });
  const groups = t.mock.method(plugin, 'getGroupVisualSettings');
  const leaves = t.mock.method(plugin.app.workspace, 'getLeavesOfType');
  render.drawEdges(view, strokeRecorder().ctx);
  assert.equal(groups.mock.callCount(), 0);
  assert.equal(leaves.mock.callCount(), 0);
  const cached = view.appearanceCache;
  render.drawEdges(view, strokeRecorder().ctx);
  assert.equal(view.appearanceCache, cached);
  plugin.data.settings.edge_opacity = 0.25;
  const mutationLookups = leaves.mock.callCount();
  const next = strokeRecorder();
  render.drawEdges(view, next.ctx);
  assert.equal(groups.mock.callCount(), 0);
  assert.equal(
    leaves.mock.callCount(),
    mutationLookups,
    'only mutation notification may enumerate views'
  );
  assert.notEqual(view.appearanceCache, cached);
  assert(next.strokes.every((stroke) => stroke.alpha <= 0.25));
});

test('grid preserves theme opacity by default and uses optional color, opacity and thickness 2', (t) => {
  const { view, plugin } = edgeView(t);
  view.canvasTheme = { ...view.canvasTheme, grid: '#223344', gridOpacity: 0.17 };
  const first = strokeRecorder();
  render.drawGrid(view, first.ctx);
  assert.equal(first.strokes[0].style, '#223344');
  assert.equal(first.strokes[0].alpha, 0.17);
  Object.assign(plugin.data.settings, {
    grid_color: '#abcdef',
    grid_opacity: 0,
    grid_line_width: 2,
  });
  const next = strokeRecorder();
  render.drawGrid(view, next.ctx);
  assert.equal(next.strokes[0].style, '#abcdef');
  assert.equal(next.strokes[0].alpha, 0);
  assert.equal(next.strokes[0].width, 2);
});

test('line and edge-color settings normalize; removed settings are dropped', (t) => {
  const legacy = fixture(t, { settings: { edge_width_scale: 1 } }).plugin.getSettings();
  assert.equal(legacy.edge_width_scale, 1, 'stored widths keep their number');
  assert.equal(legacy.edge_opacity, 1);
  assert.equal(legacy.edge_color, null);

  const { plugin } = fixture(t, {
    settings: {
      edge_width_scale: 0.05,
      painted_edge_width: 9,
      edge_opacity: 2,
      edge_color: '#ABCDEF',
      render_resolution_scale: 2,
      node_size_scale: 30,
    },
    saved_layout_settings: { painted_edge_width: 1, render_resolution_scale: 2 },
    node_visual_settings: { a: { edge_width_scale: 0.05, painted_edge_width: 7 } },
  });
  const settings = plugin.getSettings();
  assert.equal(settings.edge_width_scale, 0.1);
  assert.equal(settings.edge_opacity, 1);
  assert.equal(settings.edge_color, '#abcdef');
  assert.equal(settings.node_size_scale, 2);
  for (const key of ['painted_edge_width', 'render_resolution_scale']) {
    assert(!(key in settings), `${key} removed from settings`);
    assert(!(key in plugin.data.saved_layout_settings), `${key} removed from saved settings`);
  }
  assert.equal(getNodeVisualSetting(plugin, 'a', 'edge_width_scale'), 0.1);
  assert(!('painted_edge_width' in plugin.data.node_visual_settings.a));

  const invalid = fixture(t, {
    settings: { edge_color: 'red', edge_opacity: -1 },
  }).plugin.getSettings();
  assert.equal(invalid.edge_color, null);
  assert.equal(invalid.edge_opacity, 0);
});

test('node radius has no ceiling and keeps proportions between degrees', (t) => {
  const { view, plugin } = fixture(t);
  const small = { id: 'small', x: 0, y: 0, degree: 0 };
  const hub = { id: 'hub', x: 0, y: 0, degree: 200 };
  // Values below the former ceiling are unchanged: (3 + 1.4 log2(degree + 2)) * size / 2.
  plugin.data.settings.node_size_scale = 1;
  assert.equal(view.getNodeRadius(small), 2.2);
  assert(view.getNodeRadius(hub) > 4, 'the former radius ceiling of 4 no longer clips hubs');
  const ratio = view.getNodeRadius(hub) / view.getNodeRadius(small);
  for (const size of [0.5, 1.5, 2]) {
    plugin.data.settings.node_size_scale = size;
    const current = view.getNodeRadius(hub) / view.getNodeRadius(small);
    assert(Math.abs(current - ratio) < 1e-9, `ratio kept at size ${size}`);
  }
  plugin.data.settings.node_size_scale = 2;
  assert.equal(view.getNodeRadius(small), 4.4);
});

test('nodes follow the square root of zoom on screen and in hit testing', (t) => {
  assert.equal(getNodeScreenRadius(3, 4), 6);
  assert.equal(getNodeScreenRadius(3, 0.25), 1.5);
  assert.equal(getNodeScreenRadius(0.1, 0.25), 0.6, 'minimum visible radius stays');
  assert.equal(getNodeWorldRadius(3, 4), 1.5);

  const { view } = fixture(t);
  const node = { id: 'a', x: 0, y: 0, degree: 3 };
  view.nodes = [node];
  view.nodeById = new Map([[node.id, node]]);
  view.viewWidth = 400;
  view.viewHeight = 400;
  const base = view.getNodeRadius(node);
  for (const zoom of [0.25, 1, 4]) {
    view.camera = { x: 0, y: 0, zoom };
    // Hit radius on screen: square-root-scaled radius plus the 2 px pick margin.
    const screenReach = base * Math.sqrt(zoom) + 2;
    assert.equal(view.getNodeAtScreen(200 + screenReach - 0.1, 200), node, `inside at ${zoom}`);
    assert.equal(view.getNodeAtScreen(200 + screenReach + 0.1, 200), null, `outside at ${zoom}`);

    const { ctx, arcs } = strokeRecorder();
    render.drawNodes(view, ctx);
    assert.equal(arcs[0], getNodeScreenRadius(base, zoom));
  }
});

test('hit testing reaches large nodes and prefers the node actually under the cursor', (t) => {
  const { view, plugin } = fixture(t);
  const big = { id: 'big', x: 0, y: 0, degree: 50 };
  const small = { id: 'small', x: 15, y: 0, degree: 0 };
  view.nodes = [big, small];
  view.nodeById = new Map(view.nodes.map((node) => [node.id, node]));
  view.viewWidth = 400;
  view.viewHeight = 400;
  view.camera = { x: 0, y: 0, zoom: 1 };
  plugin.data.node_visual_settings = { big: { node_size_scale: 2 } };
  const bigRadius = view.getNodeRadius(big);
  assert(bigRadius > 10);
  view.render?.();
  // 9 units right of the big centre: inside it, and nearer the small node's centre.
  assert.equal(view.getNodeAtScreen(209, 200), big);
  assert.equal(view.getNodeAtScreen(200 + bigRadius - 1, 200), big);
  assert.equal(view.getNodeAtScreen(215, 200), small);
});

test('sub-pixel strokes become one backing pixel with proportional opacity', () => {
  const ctx = {};
  setCrispStroke(ctx, 0.25, 0.8, 2);
  assert.deepEqual(ctx, { lineWidth: 0.5, globalAlpha: 0.4 });
  setCrispStroke(ctx, 2, 0.8, 1);
  assert.deepEqual(ctx, { lineWidth: 2, globalAlpha: 0.8 });
  setCrispStroke(ctx, 0.5, 1, 2);
  assert.deepEqual(ctx, { lineWidth: 0.5, globalAlpha: 1 }, 'exactly one pixel is not dimmed');

  assert.equal(getEdgeCssWidth(3, 2), 1.5);
  assert.equal(getCrispCoordinate(10.2, 1, 1), 10.5);
  assert.equal(getCrispCoordinate(10.2, 2, 1), 10, 'two backing pixels sit on a boundary');
  assert.equal(getCrispCoordinate(10.2, 2, 0.5), 10.25, 'one backing pixel sits on a centre');
});

test('grid and edges use device-pixel backing and physical edge widths', (t) => {
  const { view, plugin } = edgeView(t, { grid_line_width: 0.1, edge_width_scale: 0.5 });
  view.devicePixelRatio = 2;
  assert.equal(render.getBackingScale(view), 2);
  view.camera = { x: 0, y: 0, zoom: 1 };
  view.screenToWorld = (x, y) => ({ x: x - 200, y: y - 200 });
  view.worldToScreen = (x, y) => ({ x: x + 200, y: y + 200 });

  const grid = strokeRecorder();
  render.drawGrid(view, grid.ctx);
  assert(grid.strokes.length > 0);
  for (const stroke of grid.strokes) {
    assert.equal(stroke.width, 1 / 2);
    assert(Math.abs(stroke.alpha - 0.2 * 0.2) < 1e-12);
  }

  // 0.5 physical pixels -> 0.25 CSS px -> 0.5 backing px: drawn as one backing pixel.
  const edges = strokeRecorder();
  render.drawEdges(view, edges.ctx);
  assert.equal(edges.strokes.length, 1);
  assert.equal(edges.strokes[0].width, 1 / 2);
  assert(Math.abs(edges.strokes[0].alpha - 0.5) < 1e-12);

  plugin.data.settings.edge_width_scale = 4;
  edges.strokes.length = 0;
  render.drawEdges(view, edges.ctx);
  assert.equal(edges.strokes[0].width, 2, 'physical width is independent of zoom');
  view.camera.zoom = 8;
  edges.strokes.length = 0;
  render.drawEdges(view, edges.ctx);
  assert.equal(edges.strokes[0].width, 2);
});

test('translucent edges of one appearance share a single stroke', (t) => {
  const { view, plugin } = edgeView(t, { edge_width_scale: 1, edge_opacity: 0.4 });
  view.nodes.push({ id: 'c', x: 25, y: -25, degree: 2 }, { id: 'd', x: 25, y: 25, degree: 2 });
  view.nodeById = new Map(view.nodes.map((node) => [node.id, node]));
  // Crossing and overlapping edges, with a painted edge and an individual width between them.
  view.edges = [
    { source: 'a', target: 'b' },
    { source: 'c', target: 'd' },
    { source: 'a', target: 'c' },
    { source: 'b', target: 'd' },
    { source: 'a', target: 'd' },
  ];
  plugin.data.painted_edge_colors.c = '#112233';
  plugin.setNodeVisualSetting('b', 'edge_width_scale', 3);
  view.camera = { x: 25, y: 0, zoom: 1 };
  const { ctx, strokes, segments } = strokeRecorder();
  render.drawEdges(view, ctx);
  const regular = strokes.findIndex((stroke) => stroke.width === 1 && stroke.style !== '#112233');
  assert.equal(segments[regular], 1, 'a-d is the only regular 1 px edge');
  const wide = strokes.findIndex((stroke) => stroke.width === 3);
  assert.equal(segments[wide], 2, 'a-b and b-d share one 3 px stroke');
  assert.equal(strokes.length, new Set(strokes.map((s) => JSON.stringify(s))).size);
  assert.equal(
    segments.reduce((sum, count) => sum + count, 0),
    view.edges.length,
    'each edge drawn once'
  );
  const painted = strokes.findIndex((stroke) => stroke.style === '#112233');
  assert.equal(segments[painted], 2, 'both painted edges share one stroke');
  assert(painted > regular, 'painted edges are layered above regular ones');
});

test('edge color and opacity apply to every edge, painted colors keep priority', (t) => {
  const { view, plugin } = edgeView(t, {
    edge_width_scale: 2,
    edge_color: '#ff0000',
    edge_opacity: 0.5,
  });
  view.camera = { x: 25, y: 0, zoom: 1 };
  const { ctx, strokes } = strokeRecorder();
  render.drawEdges(view, ctx);
  assert.deepEqual(strokes, [{ width: 2, alpha: 0.5, style: '#ff0000' }]);

  plugin.data.painted_edge_colors.a = '#112233';
  strokes.length = 0;
  render.drawEdges(view, ctx);
  assert.equal(strokes.length, 1);
  assert.equal(strokes[0].width, 2, 'painted edges use the edge width');
  assert.equal(strokes[0].style, '#112233');
  assert(Math.abs(strokes[0].alpha - 0.5 * 0.65) < 1e-12);

  delete plugin.data.painted_edge_colors.a;
  plugin.data.settings.edge_color = null;
  view.canvasTheme = { ...view.canvasTheme, mutedText: '#445566' };
  strokes.length = 0;
  render.drawEdges(view, ctx);
  assert.equal(strokes[0].style, '#445566', 'null edge color follows the theme');
});

test('highlighted edges thicken relative to their own width, within limits', () => {
  assert.equal(getFocusEdgeWidth(1, 0), 1);
  assert.equal(getFocusEdgeWidth(1, 1), 2, 'edges double');
  assert.equal(getFocusEdgeWidth(0.34, 1), 1.34, 'thin edges gain at least one physical pixel');
  assert.equal(getFocusEdgeWidth(3, 1), 6, 'thicker edges double');
  assert.equal(getFocusEdgeWidth(5, 1), 10);
  assert.equal(getFocusEdgeWidth(8, 1), 12, 'growth is capped at 12 physical pixels');
  assert.equal(getFocusEdgeWidth(20, 1), 20, 'highlight never thins an edge');
  const widths = [0, 0.25, 0.5, 0.75, 1].map((progress) => getFocusEdgeWidth(1, progress));
  for (let i = 1; i < widths.length; i++) assert(widths[i] > widths[i - 1]);
});

test('highlight color follows the edge color and changes smoothly', () => {
  assert.equal(getFocusEdgeColor('#204080', '#ffffff', 0), '#204080');
  const red = getFocusEdgeColor('#ff0000', '#ffffff', 1);
  const blue = getFocusEdgeColor('#0000ff', '#ffffff', 1);
  assert.notEqual(red, blue, 'different edge colors give different highlights');
  assert.equal(red, '#ff7373');
  assert.equal(getFocusEdgeColor('rgb(0, 0, 0)', '#ffffff', 1), '#737373');
  const channel = (progress) =>
    Number.parseInt(getFocusEdgeColor('#000000', '#ffffff', progress).slice(1, 3), 16);
  const below = channel(0.49);
  const above = channel(0.51);
  assert(above - below <= 15, 'no jump around the middle of the animation');
  for (let step = 1; step <= 8; step++) assert(channel(step / 8) >= channel((step - 1) / 8));
});

test('hovered edges use the configured edge color, not the selection color', (t) => {
  const { view, plugin } = edgeView(t, { edge_color: '#ff0000' });
  plugin.data.settings.edge_color = '#ff0000';
  view.neighborsById = new Map([
    ['a', new Set(['b'])],
    ['b', new Set(['a'])],
  ]);
  view.hoverNodeId = 'a';
  for (let frame = 0; frame < 40; frame++) render.stepFocusSmoothing(view);
  const { ctx, strokes } = strokeRecorder();
  render.drawEdges(view, ctx);
  const hovered = strokes.at(-1);
  const theme = view.canvasTheme || render.DARK_THEME || { text: '#e6e8ed' };
  assert.equal(hovered.style, getFocusEdgeColor('#ff0000', theme.text, 1));
  assert.notEqual(hovered.style, theme.selection);
});

test('API exposes physical edge widths, edge color and opacity', () => {
  const schema = EXTENDED_TOOLS.find((tool) => tool.name === 'update_settings').schema.shape
    .settings;
  const accepts = (settings) => schema.safeParse(settings).success;
  assert(accepts({ edge_width_scale: 5, node_size_scale: 2 }));
  assert(!accepts({ edge_width_scale: 5.1 }));
  assert(!accepts({ node_size_scale: 2.5 }));
  assert(accepts({ hover_highlight_color: null }));
  assert(accepts({ hover_highlight_color: '#ff8800' }));
  assert(!accepts({ hover_highlight_color: 'red' }));
  assert(!accepts({ painted_edge_width: 1 }));
  assert(!accepts({ render_resolution_scale: 1 }));
  assert(accepts({ edge_color: null }));
  assert(accepts({ edge_color: '#a1b2c3' }));
  assert(!accepts({ edge_color: '#abc' }));
  assert(accepts({ edge_opacity: 0 }));
  assert(!accepts({ edge_opacity: 1.2 }));

  const visuals = EXTENDED_TOOLS.find((tool) => tool.name === 'update_node_settings').schema.shape
    .settings;
  assert(visuals.safeParse({ edge_width_scale: 5, node_size_scale: 2 }).success);
  assert(!visuals.safeParse({ node_size_scale: 2.5 }).success);
  assert(!visuals.safeParse({ painted_edge_width: 1 }).success);
  assert(!visuals.safeParse({ edge_width_scale: 0.05 }).success);
});

test('HTML export carries physical edge widths, edge color and opacity', async (t) => {
  const vm = require('node:vm');
  const { mobileVault } = require('./helpers/mobile-vault.cjs');
  const { view, plugin, app } = fixture(t, {
    settings: {
      edge_width_scale: 3,
      edge_color: '#ff0000',
      edge_opacity: 0.4,
      dim_low_degree_nodes: true,
      custom_background: true,
      background_color: '#123456',
      grid_color: '#334455',
      grid_opacity: 0.3,
      grid_line_width: 2,
      show_arrows: true,
      reverse_arrows: true,
    },
  });
  view.updateCanvasBackgroundColor = Object.getPrototypeOf(view).updateCanvasBackgroundColor;
  view.canvasEl = { clientWidth: 600, clientHeight: 400 };
  view.ctx = {};
  view.nodes.push({ id: 'b', label: 'B', x: 50, y: 50, degree: 1 });
  view.nodeById = new Map(view.nodes.map((node) => [node.id, node]));
  view.edges = [{ source: 'alpha.md', target: 'b' }];
  plugin.setNodeVisualSetting('b', 'show_arrows', false);
  plugin.setNodeVisualSetting('b', 'edge_opacity', 0);
  plugin.setNodeVisualSetting('b', 'edge_color', '#abcdef');
  app.vault.getAbstractFileByPath = () => null;
  const { vault, contents } = mobileVault(t, false);
  Object.assign(app.vault, vault);
  view.contentEl.win.require = () => assert.fail('Export must not use Node');
  await view.commandExportStaticHtml({ exportPath: 'line-export.html' });
  const html = contents.get('line-export.html');
  const payload = JSON.parse(html.match(/const EXPORT_DATA = (.*);/)[1]);
  assert.equal(payload.settings.edgeWidth, 3);
  assert.equal(payload.settings.edgeColor, '#ff0000');
  assert.equal(payload.settings.edgeOpacity, 0.4);
  assert.equal(payload.theme.background, '#123456');
  assert.equal(payload.settings.gridColor, '#334455');
  assert.equal(payload.settings.gridOpacity, 0.3);
  assert.equal(payload.settings.gridLineWidth, 2);
  assert.equal(payload.settings.dimLowDegreeNodes, true);
  assert.equal(payload.edges[0].showArrows, false);
  assert.equal(payload.edges[0].reverseArrows, true);
  assert.equal(payload.edges[0].opacity, 0);
  assert.equal(payload.edges[0].color, '#abcdef');
  assert.equal(payload.nodes[0].degree, view.nodes[0].degree);
  assert(!('renderResolutionScale' in payload.settings));
  assert(!('paintedEdgeWidth' in payload.settings));
  assert(!('paintedWidth' in payload.edges[0]));
  assert.equal(payload.edges[0].width, 3);
  assert.equal(plugin.getSettings().edge_color, '#ff0000');
  // The same metric helpers are embedded and the generated script compiles.
  for (const name of [
    'getNodeScreenRadius',
    'getNodeWorldRadius',
    'setCrispStroke',
    'getLowDegreeAlpha',
    'getLinkArrowSegments',
  ])
    assert.match(html, new RegExp(`const ${name} = function ${name}\\(`));
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  assert.doesNotThrow(() => new vm.Script(script));
});

test('highlighted edges are fully opaque regardless of edge and painted opacity', (t) => {
  const { view, plugin } = edgeView(t, { edge_opacity: 0.3 });
  plugin.data.painted_edge_colors = { a: '#00ff00' };
  view.neighborsById = new Map([
    ['a', new Set(['b'])],
    ['b', new Set(['a'])],
  ]);
  const { ctx: restCtx, strokes: rest } = strokeRecorder();
  render.drawEdges(view, restCtx);
  assert(rest.at(-1).alpha < 0.3, 'painted edge at rest keeps edge opacity and painted softness');
  view.hoverNodeId = 'a';
  for (let frame = 0; frame < 40; frame++) render.stepFocusSmoothing(view);
  const { ctx, strokes } = strokeRecorder();
  render.drawEdges(view, ctx);
  assert.equal(strokes.at(-1).alpha, 1);
});

test('hover color drives highlighted edges and the hover ring', (t) => {
  const { view, plugin } = edgeView(t, { hover_highlight_color: '#FF8800' });
  assert.equal(plugin.getSettings().hover_highlight_color, '#ff8800');
  assert.equal(
    fixture(t, { settings: { hover_highlight_color: 'red' } }).plugin.getSettings()
      .hover_highlight_color,
    null
  );
  view.neighborsById = new Map([
    ['a', new Set(['b'])],
    ['b', new Set(['a'])],
  ]);
  view.hoverNodeId = 'a';
  for (let frame = 0; frame < 40; frame++) render.stepFocusSmoothing(view);
  const { ctx, strokes } = strokeRecorder();
  render.drawEdges(view, ctx);
  assert.equal(strokes.at(-1).style, '#ff8800');
  const half = getFocusEdgeColor('#000000', '#ffffff', 0.5, '#ff8800');
  assert.equal(half, '#804400', 'custom hover color is approached smoothly');

  const nodes = strokeRecorder();
  render.drawNodes(view, nodes.ctx);
  assert(
    nodes.strokes.some((stroke) => stroke.style === '#ff8800'),
    'hover ring uses hover color'
  );
});

test('legacy render settings migrate once, keeping originals', (t) => {
  const { migrateLegacyNodeSize } = loadSource('render-migration.js');
  assert.equal(migrateLegacyNodeSize(1), 1);
  // s = 3: the old cap gave radius 6, i.e. 6 / 2.2 = 2.73, clamped to the new maximum 2.
  assert.equal(migrateLegacyNodeSize(3), 2);
  assert.equal(migrateLegacyNodeSize(1.5), 1.5, 'uncapped sizes keep their value');
  assert.equal(migrateLegacyNodeSize(2), 4 / 2.2);
  assert.equal(migrateLegacyNodeSize(4), 2);
  assert.equal(migrateLegacyNodeSize(0.5), 0.5);

  const legacyData = {
    render_model: undefined,
    settings: { node_size_scale: 3, edge_width_scale: 0.6, painted_edge_width: 0.4 },
    saved_layout_settings: { node_size_scale: 4, edge_width_scale: 1 },
    node_visual_settings: { a: { node_size_scale: 4, edge_width_scale: 0.05 } },
  };
  for (const dpr of [1, 2]) {
    const { plugin } = fixture(t, structuredClone(legacyData));
    const settings = plugin.getSettings();
    assert.equal(settings.node_size_scale, 2);
    assert.equal(plugin.data.node_visual_settings.a.node_size_scale, 2);
    assert.equal(plugin.data.saved_layout_settings.node_size_scale, 2);
    assert(!('render_model' in plugin.data), 'not marked before edge widths convert');
    assert.equal(plugin.data.legacy_render_settings.pending_edge_dpr, true);
    assert.equal(plugin.data.legacy_render_settings.settings.node_size_scale, 3);

    assert.equal(plugin.applyPendingRenderMigration(dpr), true);
    assert.equal(settings.edge_width_scale, Math.min(5, 0.6 * dpr));
    assert.equal(plugin.data.saved_layout_settings.edge_width_scale, dpr);
    assert.equal(plugin.data.node_visual_settings.a.edge_width_scale, 0.1);
    assert.equal(plugin.data.render_model, 2);
    assert.equal(plugin.data.legacy_render_settings.dpr, dpr);
    assert.equal(plugin.data.legacy_render_settings.settings.edge_width_scale, 0.6);
    assert(!('painted_edge_width' in settings));

    // Once marked, neither another call nor a reload converts again.
    assert.equal(plugin.applyPendingRenderMigration(3), false);
    const reloaded = plugin.normalizeData(JSON.parse(JSON.stringify(plugin.data)));
    assert.equal(reloaded.settings.node_size_scale, 2);
    assert.equal(reloaded.settings.edge_width_scale, Math.min(5, 0.6 * dpr));
    assert.equal(reloaded.render_model, 2);
    assert.equal(reloaded.legacy_render_settings.dpr, dpr);
  }

  // A pending record survives reload without migrating node sizes twice.
  const { plugin } = fixture(t, structuredClone(legacyData));
  const again = plugin.normalizeData(JSON.parse(JSON.stringify(plugin.data)));
  assert.equal(again.settings.node_size_scale, 2);
  assert.equal(again.legacy_render_settings.pending_edge_dpr, true);

  // Fresh data is current immediately.
  assert.equal(plugin.normalizeData({}).render_model, 2);
});

test('layout files without the render model migrate on load and save with the mark', async (t) => {
  const { plugin, view, putLayout } = fixture(t);
  putLayout(
    {
      settings: { node_size_scale: 4, edge_width_scale: 0.5 },
      saved_positions: { 'alpha.md': { x: 1, y: 2 } },
    },
    'old.json'
  );
  const read = await plugin.readLayoutFileData('old.json');
  assert.equal(read.status, 'ok');
  const loaded = plugin.normalizeData(read.data);
  assert.equal(loaded.settings.node_size_scale, 2);
  assert.equal(loaded.legacy_render_settings.pending_edge_dpr, true);
  plugin.data = loaded;
  view.contentEl = { win: { devicePixelRatio: 2 } };
  plugin.applyPendingRenderMigration(2);
  const snapshot = view.captureLayoutSnapshot('old.json');
  assert.equal(snapshot.render_model, 2);
  assert.equal(snapshot.settings.edge_width_scale, 1);
  assert.equal(snapshot.legacy_render_settings.dpr, 2);
});

test('dragging onto a hidden holder shows a faint marker and name, grid shown or not', (t) => {
  const { view } = edgeView(t, { show_grid: false });
  view.camera = { x: 0, y: 0, zoom: 1 };
  view.worldToScreen = (x, y) => ({ x: x + 200, y: y + 200 });
  const texts = [];
  const labels = [];
  const draw = () => {
    const rec = strokeRecorder();
    rec.ctx.fillText = (text, x, y) => {
      texts.push(text);
      labels.push({ x, y, baseline: rec.ctx.textBaseline });
    };
    render.drawHiddenGridMarkers(view, rec.ctx);
    return rec;
  };
  view.getDragHiddenGridHolders = () => [];
  assert.equal(draw().strokes.length, 0, 'no marker without a drag over a held cell');
  view.nodeById.get('a').label = 'alpha';
  view.getDragHiddenGridHolders = () => [{ nodeId: 'a', gx: 0, gy: 0 }];
  const rec = draw();
  assert.equal(rec.strokes.length, 1);
  assert.equal(rec.arcs.length, 1);
  assert(rec.strokes[0].alpha < 1, 'marker stays faint');
  assert.deepEqual(texts, ['Hidden: alpha']);

  // The label clears both the hidden marker and the dragged node sharing the cell.
  const markerRadius = rec.arcs[0];
  assert.equal(labels[0].baseline, 'bottom');
  assert(labels[0].y <= 200 - markerRadius - 6, 'label stays above the hidden marker');
  const dragged = view.nodeById.get('b');
  dragged.x = 0;
  dragged.y = 0;
  view.plugin.data.node_visual_settings = { b: { node_size_scale: 2 } };
  view.dragNodeId = 'b';
  labels.length = 0;
  draw();
  const draggedRadius = getNodeScreenRadius(view.getNodeRadius(dragged), 1);
  assert(draggedRadius > markerRadius, 'dragged node is larger than the marker');
  assert(labels[0].y <= 200 - draggedRadius - 6, 'label stays above the dragged node');
});

test('hidden holder label follows the global Text size like node labels', (t) => {
  const { view } = edgeView(t, { show_grid: false });
  view.camera = { x: 0, y: 0, zoom: 1 };
  view.worldToScreen = (x, y) => ({ x: x + 200, y: y + 200 });
  view.getDragHiddenGridHolders = () => [{ nodeId: 'a', gx: 0, gy: 0 }];
  const fontPx = (labelFontSize, zoom = 1) => {
    view.plugin.getSettings().label_font_size = labelFontSize;
    view.camera.zoom = zoom;
    const rec = strokeRecorder();
    let font = '';
    let rect = null;
    rec.ctx.fillText = () => {
      font = rec.ctx.font;
    };
    rec.ctx.fillRect = (x, y, w, h) => {
      rect = { y, h };
    };
    render.drawHiddenGridMarkers(view, rec.ctx);
    return { size: Number.parseFloat(font), rect };
  };
  const small = fontPx(5);
  const normal = fontPx(9);
  const large = fontPx(20);
  assert(small.size < normal.size && normal.size < large.size, 'size grows with Text size');
  assert.equal(normal.size, 10, 'default Text size matches the default node label size');
  assert(large.rect.h > normal.rect.h, 'the backdrop grows with the text');
  assert(fontPx(9, 10).size > normal.size, 'zooming in enlarges the label like node labels');
});
