const test = require('node:test');
const assert = require('node:assert/strict');
const { mobileVault } = require('./helpers/mobile-vault.cjs');
const { fixture, loadSource } = require('./helpers/obsidian.cjs');
const {
  NODE_VISUAL_SETTINGS,
  getNodeVisualSetting,
  getNodeVisualOverride,
  getEdgeVisualSetting,
  getNodeColor,
} = loadSource('node-visuals.js');
const render = loadSource('render.js');
const { buildNodeContextMenu } = loadSource('node-context-menu.js');

test('link inheritance respects priority, explicit false, source conflicts and legacy paint updates', (t) => {
  const { plugin, view } = fixture(t, {
    settings: { edge_color: '#111111', show_arrows: true, reverse_arrows: true },
    painted_edge_colors: { 'alpha.md': '#112233', target: '#abcdef' },
  });
  const styles = {
    'alpha.md': { edge_color: '#222222', edge_opacity: 0.3, show_arrows: true },
    target: { edge_color: '#333333', edge_opacity: 0.4 },
  };
  t.mock.method(plugin, 'getGroupVisualSettings', (id) => styles[id]);
  const resolve = (key) => getEdgeVisualSetting(plugin, 'alpha.md', 'target', key);
  assert.equal(resolve('edge_color'), '#112233', 'legacy paint at equal priority prefers source');
  const { obsidian } = require('./helpers/obsidian.cjs');
  const menu = new obsidian.Menu();
  view.addVisualSettingsToMenu(menu, view.nodes[0], 0, 0);
  const picker = menu.items.find((item) => item.title === 'Link color').dom.children[0].children[0];
  assert.equal(picker.value, '#112233', 'picker shows actual old paint');
  picker.value = '#445566';
  picker.events.input();
  assert.equal(plugin.data.painted_edge_colors['alpha.md'], undefined);
  assert.equal(resolve('edge_color'), '#445566', 'source new color beats target old paint');
  plugin.setPaintedEdgeColor('alpha.md', '#778899');
  assert.equal(resolve('edge_color'), '#778899', 'legacy action is the latest color');
  assert.equal(plugin.data.node_visual_settings['alpha.md']?.edge_color, undefined);
  plugin.resetNodeVisualSettings('alpha.md');
  assert.equal(resolve('edge_color'), '#abcdef', 'target individual beats source group');
  plugin.resetNodeVisualSettings('target');
  assert.equal(resolve('edge_color'), '#222222', 'source group wins equal-priority conflict');
  assert.equal(resolve('edge_opacity'), 0.3);
  plugin.setNodeVisualSetting('target', 'edge_opacity', 0);
  plugin.setNodeVisualSetting('target', 'show_arrows', false);
  plugin.setNodeVisualSetting('target', 'reverse_arrows', false);
  assert.equal(resolve('edge_opacity'), 0);
  assert.equal(resolve('show_arrows'), false);
  assert.equal(resolve('reverse_arrows'), false);
  plugin.resetNodeVisualSettings('target');
  styles['alpha.md'] = {};
  styles.target = {};
  assert.equal(resolve('edge_color'), '#111111');
});

test('shared menu toggles use existing buttons, hide Reverse and display inherited theme swatches', (t) => {
  const { plugin, view } = fixture(t);
  const { obsidian } = require('./helpers/obsidian.cjs');
  const menu = new obsidian.Menu();
  view.addVisualSettingsToMenu(menu, view.nodes[0], 0, 0);
  const row = (label) => menu.items.find((item) => item.title === label);
  const show = row('Show arrows').dom.children[0].children[0];
  assert.equal(show.tag, 'button');
  assert.equal(show.cls, 'graphfrontier-toggle-btn');
  assert.equal(row('Reverse arrows').dom.style.display, 'none');
  assert.equal(row('Link color').dom.children[0].children[0].value, view.canvasTheme.mutedText);
  assert.equal(row('Link color').dom.children[0].children.length, 1, 'no color reset button');
  view.layoutPaused = true;
  show.events.click();
  assert.equal(plugin.data.node_visual_settings['alpha.md'].show_arrows, true);
  assert.equal(show.attributes['aria-pressed'], 'true');
  assert.equal(row('Reverse arrows').dom.style.display, '');
  row('Reverse arrows').dom.children[0].children[0].events.click();
  assert.equal(plugin.data.node_visual_settings['alpha.md'].reverse_arrows, true);
  show.events.click();
  assert.equal(row('Reverse arrows').dom.style.display, 'none');
  assert.equal(view.layoutPaused, true, 'visual edits do not wake physics');
});

test('Strong pull slider targets eligible selection, synchronizes actions and visual reset preserves forces', async (t) => {
  const { plugin, view } = fixture(t);
  const { obsidian } = require('./helpers/obsidian.cjs');
  const nodes = [
    { id: 'a' },
    { id: 'b' },
    { id: 'gravity', meta: { darkEnergy: true } },
    { id: 'other' },
  ];
  view.nodes = nodes;
  view.nodeById = new Map(nodes.map((node) => [node.id, node]));
  view.selectedNodeIds = new Set(['a', 'b', 'gravity']);
  const menu = new obsidian.Menu();
  view.addVisualSettingsToMenu(menu, null, 0, 0, view.captureNodeActionTargets(null), {
    basicOnly: true,
  });
  const input = menu.items.find((item) => item.title === 'Strong pull x').dom.children[0]
    .children[0];
  assert.equal(input.max, '20');
  input.value = '20';
  input.events.input();
  assert.equal(plugin.getNodeMultiplier('a'), 20);
  assert.equal(plugin.getNodeMultiplier('b'), 20);
  assert.equal(plugin.getNodeMultiplier('gravity'), 1);
  assert.equal(plugin.getNodeMultiplier('other'), 1);
  assert.equal(plugin.getSettings().strong_pull_multiplier, 5);
  const single = new obsidian.Menu();
  view.addVisualSettingsToMenu(single, nodes[0], 0, 0, {
    ...view.captureNodeActionTargets(nodes[0]),
    ids: ['a'],
  });
  const slider = single.items.find((item) => item.title === 'Strong pull x').dom.children[0]
    .children[0];
  single.items.find((item) => item.title === 'Reset visual settings').callback();
  assert.equal(plugin.getNodeMultiplier('a'), 20);
  await single.items.find((item) => item.title === 'Clear strong pull').callback();
  assert.equal(slider.value, '1');
});

test('group multiplier uses existing force resolver and survives only-visual reset', (t) => {
  const { plugin, view } = fixture(t, {
    groups: [{ id: 'g', query: 'name:alpha', color: '#123456' }],
  });
  const { obsidian } = require('./helpers/obsidian.cjs');
  view.nodes[0].meta = { path: 'alpha.md', fileName: 'alpha.md', tags: [] };
  const row = { id: 'g', settings: {}, colorInput: { value: '#123456' } };
  view.groupEditorRows = [row];
  const menu = new obsidian.Menu();
  view.addVisualSettingsToMenu(menu, null, 0, 0, { ids: [] }, { group: row });
  const slider = menu.items.find((item) => item.title === 'Strong pull x').dom.children[0]
    .children[0];
  slider.value = '20';
  slider.events.input();
  assert.deepEqual(plugin.data.groups[0].settings, {
    strong_pull: true,
    strong_pull_multiplier: 20,
  });
  assert.equal(plugin.getNodeMultiplier('alpha.md'), 20);
  assert.equal(plugin.getSettings().strong_pull_multiplier, 5);
  menu.items.find((item) => item.title === 'Reset visual settings').callback();
  assert.equal(plugin.getNodeMultiplier('alpha.md'), 20);
  plugin.setNodeMultiplier('alpha.md', 8);
  assert.equal(plugin.getNodeMultiplier('alpha.md'), 8, 'individual overrides group force');
  const individual = new obsidian.Menu();
  view.addVisualSettingsToMenu(individual, view.nodes[0], 0, 0);
  const one = individual.items.find((item) => item.title === 'Strong pull x').dom.children[0]
    .children[0];
  one.value = '1';
  one.events.input();
  assert.equal(one.value, '1');
  assert.equal(plugin.getNodeMultiplier('alpha.md'), 1, 'explicit one overrides group twenty');
  assert.equal(plugin.normalizeData(plugin.data).node_force_multipliers['alpha.md'], 1);
  plugin.clearNodeMultiplier('alpha.md');
  assert.equal(plugin.getNodeMultiplier('alpha.md'), 20, 'clear returns to group inheritance');
});

test('saved brightness clamps to 50 and text zoom supports 40 globally and individually', (t) => {
  const { plugin, view } = fixture(t, {
    settings: { aura_brightness: 100, label_zoom_steps: 40 },
    node_visual_settings: { a: { aura_brightness: 90, label_zoom_steps: 40 } },
  });
  assert.equal(plugin.getSettings().aura_brightness, 50);
  assert.equal(getNodeVisualSetting(plugin, 'a', 'aura_brightness'), 50);
  assert.equal(plugin.getSettings().label_zoom_steps, 40);
  assert.equal(getNodeVisualSetting(plugin, 'a', 'label_zoom_steps'), 40);
  const extended = render.getLabelZoomThreshold(view, 'a');
  plugin.setNodeVisualSetting('a', 'label_zoom_steps', 20);
  assert(extended < render.getLabelZoomThreshold(view, 'a'));
});

test('visual settings inherit, isolate, clamp and reset without touching physics or coordinates', (t) => {
  const { plugin, view } = fixture(t);
  const settings = JSON.parse(JSON.stringify(plugin.data.settings));
  const nodes = structuredClone(view.nodes);
  view.layoutPaused = true;
  const kick = t.mock.method(view, 'kickLayoutSearch', () => assert.fail('No physics wake'));
  for (const definition of NODE_VISUAL_SETTINGS) {
    const spec =
      definition.type === 'color'
        ? { ...definition, min: '#112233', max: '#abcdef' }
        : definition.type === 'boolean'
          ? { ...definition, min: false, max: true }
          : definition;
    assert.equal(getNodeVisualSetting(plugin, 'a', spec.key), settings[spec.key]);
    plugin.setNodeVisualSetting('a', spec.key, spec.max);
    assert.equal(getNodeVisualSetting(plugin, 'a', spec.key), spec.max);
    assert.equal(getNodeVisualSetting(plugin, 'b', spec.key), settings[spec.key]);
    plugin.data.settings[spec.key] = spec.min;
    assert.equal(getNodeVisualSetting(plugin, 'a', spec.key), spec.max);
    plugin.setNodeVisualSetting('a', spec.key, null);
    assert.equal(getNodeVisualOverride(plugin, 'a', spec.key), null);
    assert.equal(getNodeVisualSetting(plugin, 'a', spec.key), spec.min);
    plugin.data.settings[spec.key] = settings[spec.key];
  }
  plugin.setNodeVisualSetting('a', 'center_strength', 100);
  plugin.setNodeVisualSetting('a', 'node_size_scale', NaN);
  assert.deepEqual(plugin.data.node_visual_settings, {});
  assert.deepEqual(plugin.data.settings, settings);
  assert.deepEqual(view.nodes, nodes);
  assert.equal(view.layoutPaused, true);
  assert.equal(view.layoutAutosaveDirty, true);
  assert.equal(kick.mock.callCount(), 0);
});

test('normalization accepts only finite visual parameters, retaining legacy text sizes', (t) => {
  const { plugin } = fixture(t, {
    node_visual_settings: {
      a: {
        node_size_scale: 100,
        hover_dim_strength: 0,
        center_strength: 999,
        edge_width_scale: 'bad',
      },
      b: null,
    },
    node_label_sizes: { a: 16 },
  });
  assert.deepEqual(plugin.data.node_visual_settings, {
    a: { node_size_scale: 2, hover_dim_strength: 0 },
  });
  assert.equal(getNodeVisualSetting(plugin, 'a', 'label_font_size'), 16);
});

test('node size, text zoom and dimming resolve per node', (t) => {
  const { view, plugin } = fixture(t);
  const a = { id: 'a', degree: 1, meta: { isAttachment: true } };
  const b = { ...a, id: 'b' };
  const before = render.getNodeRadius(view, b);
  plugin.setNodeVisualSetting('a', 'node_size_scale', 2);
  assert(render.getNodeRadius(view, a) > before);
  assert.equal(render.getNodeRadius(view, b), before);
  plugin.setNodeVisualSetting('a', 'label_zoom_steps', 20);
  plugin.data.settings.label_zoom_steps = 1;
  assert(render.getLabelZoomThreshold(view, 'a') < render.getLabelZoomThreshold(view, 'b'));
  plugin.setNodeVisualSetting('a', 'hover_dim_strength', 0);
  plugin.data.settings.hover_dim_strength = 100;
  assert.equal(render.getHoverDimAlpha(plugin, 1, 'a'), 1);
  assert.equal(render.getHoverDimAlpha(plugin, 1, 'b'), 0.02);
});

test('edge widths prefer explicit endpoint overrides and batch differently sized edges correctly', (t) => {
  const { view, plugin } = fixture(t);
  plugin.setNodeVisualSetting('a', 'edge_width_scale', 0.15);
  plugin.data.settings.edge_width_scale = 0.8;
  assert.equal(getEdgeVisualSetting(plugin, 'a', 'b', 'edge_width_scale'), 0.15);
  plugin.setNodeVisualSetting('b', 'edge_width_scale', 0.5);
  assert.equal(getEdgeVisualSetting(plugin, 'a', 'b', 'edge_width_scale'), 0.5);
  assert.equal(getEdgeVisualSetting(plugin, 'b', 'a', 'edge_width_scale'), 0.5);
  view.nodes = ['a', 'b', 'c', 'd'].map((id, i) => ({ id, x: i * 10, y: 0, degree: 1 }));
  view.nodeById = new Map(view.nodes.map((node) => [node.id, node]));
  view.edges = [
    { source: 'a', target: 'b' },
    { source: 'c', target: 'd' },
  ];
  view.viewWidth = 500;
  view.viewHeight = 500;
  const widths = [];
  const ctx = {
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {
      widths.push([this.lineWidth, this.globalAlpha]);
    },
  };
  // Sub-pixel widths are drawn one backing pixel wide; opacity conveys the thinness,
  // so each width still needs its own batch.
  render.drawEdges(view, ctx);
  assert.deepEqual(widths, [
    [1, 0.5],
    [1, 0.8],
  ]);
  // Painted edges keep the edge width and are layered above regular edges.
  plugin.data.painted_edge_colors.a = '#112233';
  widths.length = 0;
  render.drawEdges(view, ctx);
  assert.equal(widths.length, 2);
  assert.deepEqual(widths[0], [1, 0.8]);
  assert.equal(widths[1][0], 1);
  assert(Math.abs(widths[1][1] - 0.5 * 0.65) < 1e-12);
});

test('one reset clears all visual controls, identical for notes and attachments', (t) => {
  const { view, plugin, app } = fixture(t);
  app.vault.getAbstractFileByPath = () => null;
  const node = { id: 'a', label: 'A', meta: { isAttachment: true } };
  view.nodeById.set(node.id, node);
  const menu = buildNodeContextMenu(view, node, 0, 0);
  const visual = menu.items.find((item) => item.title === 'Visual settings').submenu;
  for (const definition of NODE_VISUAL_SETTINGS) {
    const spec =
      definition.type === 'color'
        ? { ...definition, max: '#abcdef' }
        : definition.type === 'boolean'
          ? { ...definition, max: true }
          : definition;
    const row = visual.items.find((item) => item.title === spec.label).dom.children[0];
    const [input] = row.children;
    if (spec.type === 'color') {
      assert.equal(input.cls, 'graphfrontier-group-color-input');
      assert.equal(row.children.length, 1);
    }
    assert.equal(
      row.children.some((child) => child.tag === 'button'),
      spec.type === 'boolean'
    );
    input.value = String(spec.max);
    input.events[spec.type === 'boolean' ? 'click' : 'input']();
    assert.equal(getNodeVisualOverride(plugin, node.id, spec.key), spec.max);
  }
  const resets = visual.items.filter((item) => item.title === 'Reset visual settings');
  assert.equal(resets.length, 1);
  resets[0].callback();
  for (const spec of NODE_VISUAL_SETTINGS)
    assert.equal(getNodeVisualOverride(plugin, node.id, spec.key), null);
  const attachmentTitles = visual.items.map((item) => item.title);
  assert(!attachmentTitles.includes('Attachment size'));
  node.meta.isAttachment = false;
  const ordinary = buildNodeContextMenu(view, node, 0, 0).items.find(
    (item) => item.title === 'Visual settings'
  ).submenu;
  assert.deepEqual(
    ordinary.items.map((item) => item.title),
    attachmentTitles
  );
});

test('visual overrides survive saved layouts and are removed when loading an older layout', async (t) => {
  const { view, plugin, putLayout, files, layoutPath } = fixture(t);
  plugin.setNodeVisualSetting('alpha.md', 'node_size_scale', 1.7);
  plugin.setNodeVisualSetting('alpha.md', 'label_font_size', 16);
  plugin.setNodeVisualSetting('alpha.md', 'node_color', '#123456');
  plugin.setNodeVisualSetting('alpha.md', 'aura_radius', 4000);
  plugin.setNodeVisualSetting('alpha.md', 'aura_brightness', 70);
  assert.equal(await view.saveCurrentLayout({ silent: true }), true);
  assert.equal(
    JSON.parse(files.get(layoutPath())).node_visual_settings['alpha.md'].node_size_scale,
    1.7
  );
  plugin.setNodeVisualSetting('alpha.md', 'node_size_scale', 0.1);
  assert.equal(await view.loadSavedLayout(), true);
  assert.equal(getNodeVisualSetting(plugin, 'alpha.md', 'node_size_scale'), 1.7);
  assert.equal(getNodeVisualSetting(plugin, 'alpha.md', 'label_font_size'), 16);
  assert.equal(getNodeVisualSetting(plugin, 'alpha.md', 'node_color'), '#123456');
  assert.equal(getNodeVisualSetting(plugin, 'alpha.md', 'aura_radius'), 4000);
  assert.equal(getNodeVisualSetting(plugin, 'alpha.md', 'aura_brightness'), 50);
  putLayout({}, 'old.json');
  await plugin.setActiveLayoutFile('old.json');
  assert.deepEqual(plugin.data.node_visual_settings, {});
});

test('HTML export carries individual radii, label thresholds, dimming and edge widths', async (t) => {
  const { view, plugin, app } = fixture(t);
  view.canvasEl = { clientWidth: 600, clientHeight: 400 };
  view.ctx = {};
  view.nodes[0].label = 'Alpha';
  view.nodes.push({ id: 'b', label: 'B', x: 50, y: 50, degree: 0, meta: { isAttachment: true } });
  // Raw legacy values must be inert even before persistence normalization.
  plugin.data.settings.attachment_size_multiplier = 0.1;
  plugin.data.node_visual_settings.b = { node_size_scale: 1.7, attachment_size_multiplier: 0.1 };
  view.nodeById = new Map(view.nodes.map((node) => [node.id, node]));
  view.edges = [{ source: 'alpha.md', target: 'b' }];
  app.vault.getAbstractFileByPath = () => null;
  plugin.setNodeVisualSetting('alpha.md', 'label_zoom_steps', 20);
  plugin.setNodeVisualSetting('alpha.md', 'hover_dim_strength', 0);
  plugin.setNodeVisualSetting('alpha.md', 'edge_width_scale', 0.25);
  plugin.setNodeVisualSetting('alpha.md', 'node_color', '#123456');
  plugin.setNodeVisualSetting('alpha.md', 'aura_radius', 4000);
  const { vault, contents } = mobileVault(t, false);
  Object.assign(app.vault, vault);
  view.contentEl.win.require = () => assert.fail('Export must not use Node');
  await view.commandExportStaticHtml({ exportPath: 'node-visual-export.html' });
  const html = contents.get('node-visual-export.html');
  assert.equal(typeof html, 'string');
  const payload = JSON.parse(html.match(/const EXPORT_DATA = (.*);/)[1]);
  for (const node of view.nodes) {
    const exported = payload.nodes.find((item) => item.id === node.id);
    assert.equal(exported.radius, render.getNodeRadius(view, node));
    assert.equal(exported.labelMinZoom, render.getLabelZoomThreshold(view, node.id));
  }
  const attachment = view.nodeById.get('b');
  assert.equal(
    payload.nodes.find((item) => item.id === 'b').radius,
    render.getNodeRadius(view, { ...attachment, meta: { isAttachment: false } })
  );
  assert(html.includes('"auraRadius":400'));
  assert(html.includes('"color":"#123456"'));
  assert(html.includes('"dimAlpha":1'));
  assert(html.includes('"width":0.25'));
  assert(html.includes('"labelMinZoom":' + render.getLabelZoomThreshold(view, 'alpha.md')));
});

test('base color, groups and individual color have explicit priority; invalid colors are rejected', (t) => {
  const { plugin } = fixture(t);
  const node = { id: 'a' };
  plugin.data.settings.node_color = '#445566';
  assert.equal(getNodeColor(plugin, node), '#445566');
  assert.equal(getNodeColor(plugin, node, '#112233'), '#112233');
  plugin.setNodeVisualSetting('a', 'node_color', '#abcdef');
  plugin.setNodeVisualSetting('a', 'node_color', 'invalid');
  assert.equal(getNodeColor(plugin, node, '#112233'), '#abcdef');
  const attachment = { id: 'attachment.pdf', meta: { isAttachment: true } };
  assert.equal(plugin.getSettings().attachment_node_color, null);
  assert.equal(getNodeColor(plugin, attachment), '#445566');
  plugin.data.settings.attachment_node_color = '#654321';
  assert.equal(getNodeColor(plugin, attachment), '#654321');
  assert.equal(getNodeColor(plugin, { id: 'other.md' }), '#445566');
  assert.equal(getNodeColor(plugin, attachment, '#112233'), '#112233');
  plugin.setNodeVisualSetting(attachment.id, 'node_color', '#abcdef');
  assert.equal(getNodeColor(plugin, attachment, '#112233'), '#abcdef');
  for (const value of [null, '#123456', 'invalid']) {
    const normalized = plugin.normalizeData({
      settings: { attachment_node_color: value },
      saved_layout_settings: { attachment_node_color: value },
    });
    const expected = value === 'invalid' ? null : value;
    assert.equal(normalized.settings.attachment_node_color, expected);
    assert.equal(normalized.saved_layout_settings.attachment_node_color, expected);
  }
});

test('size supports two and gravity menus omit inapplicable controls', (t) => {
  const { plugin, view, app } = fixture(t, { settings: { node_size_scale: 2 } });
  assert.equal(plugin.getSettings().node_size_scale, 2);
  const node = { id: 'a', x: 0, y: 0, degree: 100, meta: { darkEnergy: true } };
  plugin.setNodeVisualSetting('a', 'node_size_scale', 1);
  const before = render.getNodeRadius(view, node);
  plugin.setNodeVisualSetting('a', 'node_size_scale', 2);
  assert.equal(render.getNodeRadius(view, node), before * 2);
  app.vault.getAbstractFileByPath = () => null;
  const menu = buildNodeContextMenu(view, node, 0, 0);
  assert(!menu.items.some((item) => item.title === 'Other'));
  const titles = menu.items
    .find((item) => item.title === 'Visual settings')
    .submenu.items.map((item) => item.title);
  for (const title of ['Strong pull', 'Paint edges', 'Edge width', 'Attachment size'])
    assert(!titles.includes(title));
  for (const title of ['Node color', 'Color aura', 'Reset visual settings'])
    assert(titles.includes(title));
});

test('auras default off, retain offscreen coverage, obey filters and do not change hit radius', (t) => {
  const { plugin, view } = fixture(t);
  const node = { id: 'a', x: -100, y: 0, degree: 1 };
  view.nodes = [node];
  view.viewWidth = 500;
  view.viewHeight = 500;
  view.camera.zoom = 1;
  view.worldToScreen = (x, y) => ({ x, y });
  const stops = [];
  let draws = 0;
  const radii = [];
  const ctx = {
    createRadialGradient(...args) {
      radii.push(args[5]);
      return { addColorStop: (...args) => stops.push(args) };
    },
    save() {},
    restore() {},
    beginPath() {},
    arc() {},
    fill() {
      draws++;
    },
  };
  render.drawNodeAuras(view, ctx);
  assert.equal(draws, 0);
  const radius = render.getNodeRadius(view, node);
  plugin.setNodeVisualSetting('a', 'aura_radius', 5000);
  plugin.setNodeVisualSetting('a', 'node_color', '#123456');
  render.drawNodeAuras(view, ctx);
  assert.equal(draws, 1);
  assert.equal(stops.length, 3);
  assert.equal(radii[0], 500);
  assert.equal(stops[0][1], render.hexToRgba('#123456', 0.22));
  assert.equal(stops[2][1], render.hexToRgba('#123456', 0));
  assert.equal(render.getNodeRadius(view, node), radius);
  plugin.setNodeVisualSetting('a', 'aura_brightness', 100);
  render.drawNodeAuras(view, ctx);
  assert.equal(stops[3][1], render.hexToRgba('#123456', 0.5));
  plugin.setNodeVisualSetting('a', 'aura_brightness', 0);
  render.drawNodeAuras(view, ctx);
  assert.equal(draws, 2);
  plugin.setNodeVisualSetting('a', 'aura_brightness', 22);
  view.getFilterVisibleNodeIds = () => new Set();
  render.drawNodeAuras(view, ctx);
  assert.equal(draws, 2);
});

for (const scale of [0.1, 0.8, 2, 4]) {
  test(
    'attachment size equals same-topology note size at scale ' + scale + ' with legacy settings',
    (t) => {
      const { plugin, view } = fixture(t, {
        settings: { node_size_scale: scale, attachment_size_multiplier: 0.8 },
        node_visual_settings: { a: { attachment_size_multiplier: 0.1 } },
      });
      assert.deepEqual(plugin.data.node_visual_settings, {});
      for (const degree of [0, 1, 4, 100]) {
        const node = { id: 'a', degree, meta: { isAttachment: false } };
        for (const override of [null, 0.1, 1.3, 4]) {
          plugin.setNodeVisualSetting('a', 'node_size_scale', override);
          const expected = render.getNodeRadius(view, node);
          plugin.data.settings.attachment_size_multiplier = 0.1;
          plugin.data.node_visual_settings.a = {
            ...plugin.data.node_visual_settings.a,
            attachment_size_multiplier: 0.1,
          };
          assert.equal(
            render.getNodeRadius(view, { ...node, meta: { isAttachment: true } }),
            expected
          );
        }
      }
    }
  );
}

test('attachment labels use the same zoom thresholds, text overrides and dimming as notes', (t) => {
  const { plugin, view } = fixture(t);
  const node = {
    id: 'a',
    label: 'diagram',
    degree: 2,
    x: 0,
    y: 0,
    meta: { path: 'assets/diagram.pdf', fileType: 'pdf' },
  };
  view.nodes = [node];
  view.nodeById = new Map([[node.id, node]]);
  view.viewWidth = 500;
  view.viewHeight = 500;
  let calls = [];
  const ctx = {
    beginPath() {},
    arc() {},
    fill() {},
    stroke() {},
    fillText(...args) {
      calls.push({ args, alpha: this.globalAlpha, font: this.font });
    },
  };
  for (const overridden of [false, true]) {
    if (overridden) {
      plugin.setNodeVisualSetting('a', 'label_zoom_steps', 30);
      plugin.setNodeVisualSetting('a', 'label_font_size', 16);
      plugin.setNodeVisualSetting('a', 'hover_dim_strength', 80);
    }
    const threshold = render.getLabelZoomThreshold(view, node.id);
    for (const zoom of [threshold / 2, threshold, threshold * 2, 8]) {
      for (const focused of [false, true]) {
        view.camera.zoom = zoom;
        view.focusNodeId = focused ? 'other' : null;
        view.focusProgress = focused ? 1 : 0;
        node.meta.isAttachment = false;
        calls = [];
        render.drawNodes(view, ctx);
        const expected = calls.map((call) => ({
          ...call,
          args: ['diagram.pdf', ...call.args.slice(1)],
        }));
        node.meta.isAttachment = true;
        calls = [];
        render.drawNodes(view, ctx);
        assert.deepEqual(calls, expected);
        if (zoom === 8)
          assert.equal(calls.length, 1, 'visible attachment label must actually draw');
      }
    }
  }
});

test('groups reuse the node visual menu, write group overrides and reset without changing nodes', (t) => {
  const { obsidian } = require('./helpers/obsidian.cjs');
  const { view, plugin } = fixture(t, {
    groups: [{ id: 'g', query: 'name:alpha', color: '#123456' }],
  });
  const row = { id: 'g', settings: {}, colorInput: { value: '#123456' } };
  view.groupEditorRows = [row];
  const menu = new obsidian.Menu();
  view.addVisualSettingsToMenu(menu, null, 0, 0, { ids: [] }, { group: row, basicOnly: true });
  const nodeMenu = new obsidian.Menu();
  view.addVisualSettingsToMenu(nodeMenu, view.nodes[0], 0, 0, undefined, { basicOnly: true });
  assert.deepEqual(
    menu.items.map((item) => item.title),
    nodeMenu.items.map((item) => item.title)
  );
  const before = JSON.parse(JSON.stringify(plugin.data.node_visual_settings));
  for (const spec of NODE_VISUAL_SETTINGS) {
    const item = menu.items.find((item) => item.title === spec.label);
    const controls = item.dom.children[0];
    const nodeControls = nodeMenu.items.find((item) => item.title === spec.label).dom.children[0];
    assert.deepEqual(
      controls.children.map((el) => [el.tag, el.cls]),
      nodeControls.children.map((el) => [el.tag, el.cls])
    );
    const input = controls.children[0];
    input.value = String(spec.type === 'color' ? '#abcdef' : spec.max);
    input.events[spec.type === 'boolean' ? 'click' : 'input']();
    if (spec.key === 'node_color') {
      assert.equal(plugin.data.groups[0].color, '#abcdef');
      assert.equal(row.colorInput.value, '#abcdef');
    } else
      assert.equal(
        plugin.data.groups[0].settings[spec.key],
        spec.type === 'color' ? '#abcdef' : spec.type === 'boolean' ? true : spec.max
      );
  }
  assert.deepEqual(plugin.data.node_visual_settings, before);
  const reset = menu.items.find((item) => item.title === 'Reset visual settings');
  reset.callback();
  assert.deepEqual(plugin.data.groups[0].settings, {});
  assert.equal(plugin.data.groups[0].color, '#abcdef');
  assert.deepEqual(row.settings, {});
  assert.equal(reset.disabled, true);
  const input = menu.items.find((item) => item.title === 'Color aura').dom.children[0].children[0];
  view.groupEditorRows = [];
  input.value = '2';
  input.events.input();
  assert.deepEqual(plugin.data.groups[0].settings, {});
});

test('group uses shared strong-pull and edge-color actions and preserves force on visual reset', async (t) => {
  const { obsidian } = require('./helpers/obsidian.cjs');
  const { view, plugin } = fixture(t, {
    groups: [{ id: 'g', query: 'name:alpha', color: '#123456' }],
  });
  const row = { id: 'g', settings: {}, colorInput: { value: '#123456' } };
  view.groupEditorRows = [row];
  const menu = () => {
    const m = new obsidian.Menu();
    view.addVisualSettingsToMenu(m, null, 0, 0, { ids: [] }, { group: row });
    return m;
  };
  const action = (title) =>
    menu()
      .items.find((item) => item.title === title)
      .callback();
  await action('Strong pull');
  assert.equal(plugin.data.groups[0].settings.strong_pull, true);
  const color = menu().items.find((item) => item.title === 'Link color').dom.children[0]
    .children[0];
  color.value = '#abcdef';
  color.events.input();
  assert(
    !menu().items.some((item) => item.title === 'Paint links' || item.title === 'Paint edges')
  );
  assert.equal(plugin.data.groups[0].settings.edge_color, '#abcdef');
  assert(!menu().items.some((item) => item.title === 'Clear painted edges'));
  await action('Reset visual settings');
  assert.deepEqual(plugin.data.groups[0].settings, { strong_pull: true });
  await action('Clear strong pull');
  assert.deepEqual(plugin.data.groups[0].settings, {});
  assert.deepEqual(plugin.data.node_force_multipliers, {});
  assert.deepEqual(plugin.data.painted_edge_colors, {});
  const stale = menu().items.find((item) => item.title === 'Strong pull');
  view.groupEditorRows = [];
  await stale.callback();
  assert.deepEqual(plugin.data.groups[0].settings, {});
});

test('node menu removes separate edge reset and general reset clears edge color', (t) => {
  const { obsidian } = require('./helpers/obsidian.cjs');
  const { view, plugin } = fixture(t);
  const node = view.nodes[0];
  plugin.setPaintedEdgeColor(node.id, '#abcdef');
  const menu = new obsidian.Menu();
  view.addVisualSettingsToMenu(menu, node, 0, 0);
  assert(!menu.items.some((item) => item.title === 'Clear painted edges'));
  menu.items.find((item) => item.title === 'Reset visual settings').callback();
  assert.equal(plugin.getPaintedEdgeColor(node.id), null);
});
