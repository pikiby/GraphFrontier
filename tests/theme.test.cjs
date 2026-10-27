const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { fixture, loadSource, obsidian, notices } = require('./helpers/obsidian.cjs');
const { mobileVault } = require('./helpers/mobile-vault.cjs');
const { readGraphTheme } = require('../src/theme');
const render = require('../src/render');
const { GraphFrontierView } = loadSource('view.js');

test('graph height excludes floating navigation and the keyboard viewport', () => {
  const style = {};
  const viewport = { offsetTop: 0, height: 851 };
  const navbar = { left: 30, right: 360, top: 770, height: 52 };
  const view = {
    wrapEl: { style },
    contentEl: {
      getBoundingClientRect: () => ({ left: 0, right: 393, top: 101, bottom: 851 }),
      ownerDocument: {
        defaultView: { visualViewport: viewport },
        querySelector: () => ({ getBoundingClientRect: () => navbar }),
      },
    },
  };
  GraphFrontierView.prototype.updateWrapHeightForKeyboard.call(view);
  assert.equal(style.maxHeight, '661px');
  viewport.height = 500;
  GraphFrontierView.prototype.updateWrapHeightForKeyboard.call(view);
  assert.equal(style.maxHeight, '399px');
  navbar.height = 0;
  viewport.height = 851;
  GraphFrontierView.prototype.updateWrapHeightForKeyboard.call(view);
  assert.equal(style.maxHeight, '750px');
});

function themeElement(scheme, variables = {}) {
  const el = {};
  const doc = {
    events: {},
    body: { classList: { contains: (name) => name === `theme-${scheme}` } },
    documentElement: { classList: { contains: () => false } },
    defaultView: {
      getComputedStyle(target) {
        assert.equal(target, el, 'read inherited colours on the graph, not html');
        return { getPropertyValue: (name) => variables[name] || '' };
      },
    },
  };
  Object.assign(el, { ownerDocument: doc, win: doc.defaultView });
  return el;
}

function recordingCanvas() {
  const calls = [];
  const stack = [];
  const ctx = {
    globalAlpha: 1,
    fillStyle: '',
    strokeStyle: '',
    font: '',
    createRadialGradient() {
      return {
        addColorStop(offset, color) {
          calls.push({ kind: 'gradient', offset, color });
        },
      };
    },
    save() {
      stack.push({
        alpha: this.globalAlpha,
        fill: this.fillStyle,
        stroke: this.strokeStyle,
        font: this.font,
      });
    },
    restore() {
      const saved = stack.pop();
      Object.assign(this, {
        globalAlpha: saved.alpha,
        fillStyle: saved.fill,
        strokeStyle: saved.stroke,
        font: saved.font,
      });
    },
    fillText(text) {
      calls.push({
        kind: 'text',
        text,
        color: this.fillStyle,
        alpha: this.globalAlpha,
        font: this.font,
      });
    },
    stroke() {
      calls.push({ kind: 'stroke', color: this.strokeStyle, alpha: this.globalAlpha });
    },
    fillRect() {
      calls.push({ kind: 'fill', color: this.fillStyle, alpha: this.globalAlpha });
    },
    strokeRect() {
      this.stroke();
    },
    measureText: (text) => ({ width: text.length * 7 }),
    beginPath() {},
    arc() {},
    arcTo() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    fill() {},
    clearRect() {},
    setLineDash() {},
    setTransform() {},
  };
  return { ctx, calls };
}

function graph(t, scheme, variables) {
  const f = fixture(t);
  const { view, app } = f;
  view.contentEl = themeElement(scheme, variables);
  view.updateCanvasBackgroundColor = GraphFrontierView.prototype.updateCanvasBackgroundColor;
  view.updateCanvasBackgroundColor();
  view.viewWidth = 600;
  view.viewHeight = 400;
  view.camera = { x: 0, y: 0, zoom: render.getLabelZoomThreshold(view) * 1.035 };
  view.nodes = [
    { id: 'alpha.md', label: 'Alpha', x: 0, y: 0, degree: 0, meta: { path: 'alpha.md' } },
  ];
  view.nodeById = new Map(view.nodes.map((node) => [node.id, node]));
  view.getFilterVisibleNodeIds = () => null;
  view.getSearchHighlightNodeIds = () => null;
  const recorded = recordingCanvas();
  view.ctx = recorded.ctx;
  view.canvasEl = { clientWidth: 600, clientHeight: 400, events: {} };
  app.vault.getAbstractFileByPath = () => null;
  return { ...f, ...recorded };
}

test('attachment labels show real filenames without changing note labels or appearance', (t) => {
  const { view, ctx, calls } = graph(t, 'dark');
  const cases = [
    ['assets/diagram.pdf', 'diagram', { fileName: 'diagram', fileType: 'pdf' }, 'diagram.pdf'],
    ['assets/diagram.pdf', 'diagram.pdf', { fileType: 'pdf' }, 'diagram.pdf'],
    ['assets/archive.tar.gz', 'archive.tar', { fileType: 'gz' }, 'archive.tar.gz'],
    ['assets/IMAGE.PNG', 'IMAGE', { fileType: 'png' }, 'IMAGE.PNG'],
    ['assets.v1/README', 'README', { fileType: 'attachment' }, 'README'],
    ['assets/README', 'README', { fileType: 'pdf' }, 'README'],
    ['assets/.env', '.env', { fileType: 'env' }, '.env'],
    ['old.pdf', 'old', { path: 'assets/actual.svg', fileType: 'pdf' }, 'actual.svg'],
    ['', 'diagram', { fileName: 'diagram', fileType: 'pdf' }, 'diagram.pdf'],
    ['', 'diagram', { fileName: 'diagram.PDF', fileType: 'pdf' }, 'diagram.PDF'],
    ['', 'README', { fileType: 'attachment' }, 'README'],
    ['', 'README', { fileType: 'file' }, 'README'],
    ['', 'README', {}, 'README'],
  ];
  const note = view.nodes[0];
  for (const [id, label, meta, expected] of cases) {
    const attachment = { id, label, meta: { isAttachment: true, ...meta }, x: 30, y: 0, degree: 0 };
    view.nodes = [note, attachment];
    for (const zoom of [0.5, render.getLabelZoomThreshold(view) * 1.035, 12]) {
      view.camera.zoom = zoom;
      calls.length = 0;
      render.drawNodes(view, ctx);
      const labels = calls.filter((call) => call.kind === 'text');
      if (!labels.length) continue;
      assert.equal(labels.length, 2);
      assert.equal(labels[0].text, 'Alpha');
      assert.equal(labels[1].text, expected);
      assert.deepEqual({ ...labels[1], text: 'Alpha' }, labels[0]);
      assert.equal(attachment.label, label, 'display must not mutate graph labels');
    }
  }
});

test('hovered attachments show one ordinary filename label and retain highlighting', (t) => {
  const { view, ctx, calls } = graph(t, 'dark');
  view.nodes = [
    {
      id: 'assets/diagram.pdf',
      label: 'diagram',
      x: 0,
      y: 0,
      degree: 0,
      meta: { isAttachment: true, fileType: 'pdf' },
    },
  ];
  view.nodeById = new Map(view.nodes.map((node) => [node.id, node]));
  view.hoverNodeId = 'assets/diagram.pdf';
  view.camera.zoom = render.getLabelZoomThreshold(view) * 0.2;
  render.drawNodes(view, ctx);
  assert.deepEqual(
    calls.filter((call) => call.kind === 'text').map((call) => call.text),
    ['diagram.pdf']
  );
  assert(calls.some((call) => call.kind === 'stroke' && call.color === view.canvasTheme.selection));
});

test('Find keeps all matching nodes bright while another node has hover focus', (t) => {
  const { view, ctx } = graph(t, 'dark');
  view.nodes = ['Grafana', 'GraphFrontier', 'NATS'].map((label, index) => ({
    id: label,
    label,
    x: index * 20,
    y: 0,
    degree: 0,
  }));
  view.getSearchHighlightNodeIds = () => new Set(['Grafana', 'GraphFrontier']);
  view.hoverFocusNodeId = 'NATS';
  view.hoverFocusProgress = 1;
  const alphas = [];
  ctx.fill = function () {
    alphas.push(this.globalAlpha);
  };
  render.drawNodes(view, ctx);
  assert.equal(alphas[0], 1);
  assert.equal(alphas[1], 1);
  assert.equal(alphas[2], 1);
});

test('canvas global text size changes ordinary labels but not individual overrides', (t) => {
  const { plugin, view, ctx, calls } = graph(t, 'dark');
  view.nodes.push({ id: 'beta.md', label: 'Beta', x: 30, y: 0, degree: 0 });
  view.nodeById = new Map(view.nodes.map((node) => [node.id, node]));
  view.getSearchHighlightNodeIds = () => new Set(['alpha.md', 'beta.md']);
  plugin.setNodeLabelSize('alpha.md', 15);
  for (const zoom of [0.5, 1, 2, 8, 12]) {
    view.camera.zoom = zoom;
    let fixedSize;
    let previousGlobalSize = 0;
    for (const size of [5, 9, 15, 20]) {
      plugin.data.settings.label_font_size = size;
      calls.length = 0;
      render.drawNodes(view, ctx);
      const fonts = new Map(
        calls
          .filter((call) => call.kind === 'text')
          .map((call) => [call.text, parseFloat(call.font)])
      );
      assert.ok(fonts.has('Alpha') && fonts.has('Beta'));
      fixedSize ??= fonts.get('Alpha');
      assert.equal(fonts.get('Alpha'), fixedSize, `override at zoom ${zoom}`);
      assert.ok(fonts.get('Beta') > previousGlobalSize, `global ${size} at zoom ${zoom}`);
      previousGlobalSize = fonts.get('Beta');
    }
  }
  plugin.setNodeLabelSize('alpha.md', null);
  calls.length = 0;
  render.drawNodes(view, ctx);
  const fonts = calls.filter((call) => call.kind === 'text').map((call) => call.font);
  assert.equal(fonts[0], fonts[1], 'reset returns to global size');
});

for (const scheme of ['light', 'dark']) {
  test(`${scheme}: readable labels near threshold, themed grid and selection, no opacity leak`, (t) => {
    const { view, ctx, calls } = graph(t, scheme);
    render.drawNodes(view, ctx);
    const label = calls.find((call) => call.kind === 'text');
    assert.equal(label.color, scheme === 'light' ? '#222222' : '#e6e8ed');
    assert(label.alpha >= 0.65);
    assert(parseFloat(label.font) >= 10);

    ctx.globalAlpha = 0.7;
    render.drawGrid(view, ctx);
    const grid = calls.at(-1);
    assert.equal(grid.color, view.canvasTheme.mutedText);
    assert.equal(grid.alpha, 0.2);
    assert.equal(ctx.globalAlpha, 0.7);

    view.boxSelectDrag = { startX: 10, startY: 10, currentX: 30, currentY: 30 };
    render.drawSelectionBox(view, ctx);
    assert.equal(calls.at(-1).color, view.canvasTheme.selection);
    assert.equal(ctx.globalAlpha, 0.7);
  });

  test(`${scheme}: selected and hovered labels survive zoom and unrelated focus dimming`, (t) => {
    const { view, ctx, calls } = graph(t, scheme);
    view.camera.zoom = render.getLabelZoomThreshold(view) * 0.2;
    render.drawNodes(view, ctx);
    assert.equal(
      calls.filter((call) => call.kind === 'text').length,
      0,
      'ordinary labels obey zoom threshold'
    );
    view.selectedNodeIds.add('alpha.md');
    view.focusNodeId = 'other';
    view.focusProgress = 1;
    render.drawNodes(view, ctx);
    assert.equal(calls.at(-1).alpha, 1);
    assert.equal(parseFloat(calls.at(-1).font), 10);
    assert.equal(calls.find((call) => call.kind === 'stroke').color, view.canvasTheme.selection);
    view.selectedNodeIds.clear();
    view.hoverNodeId = 'alpha.md';
    calls.length = 0;
    render.drawNodes(view, ctx);
    const labels = calls.filter((call) => call.kind === 'text');
    assert.equal(labels[0].alpha, 1);
    assert.equal(labels[0].color, view.canvasTheme.text);
    assert.equal(labels.length, 1, 'hover does not draw a duplicate title');
    view.hoverNodeId = null;
    view.camera.zoom = render.getLabelZoomThreshold(view) * 2;
    calls.length = 0;
    render.drawNodes(view, ctx);
    assert(calls.at(-1).alpha >= 0.45, 'unrelated labels remain readable');
    assert(calls.at(-1).alpha < 1, 'focus dimming is retained');
  });
}

test('CSS changes refresh cached custom colours through the graph owner window', (t) => {
  const variables = {
    '--background-primary': '#fcf8ed',
    '--background-secondary': '#ede4cf',
    '--text-normal': '#392e24',
    '--text-muted': '#79674e',
    '--text-accent': '#735a9b',
    '--background-modifier-border': '#baa889',
  };
  const { view, app } = graph(t, 'light', variables);
  assert.equal(view.canvasTheme.text, '#392e24');
  assert.equal(view.canvasTheme.grid, '#79674e');
  assert.equal(view.canvasTheme.selection, '#735a9b');
  let change;
  let rendered = 0;
  app.workspace.on = (name, callback) => {
    assert.equal(name, 'css-change');
    change = callback;
    return callback;
  };
  view.registerEvent = (ref) => assert.equal(ref, change);
  view.render = () => rendered++;
  GraphFrontierView.prototype.bindEvents.call(view);
  variables['--text-normal'] = '#eddcc8';
  variables['--background-primary'] = '#221a14';
  change();
  assert.equal(view.canvasTheme.text, '#eddcc8');
  assert.equal(view.canvasBackgroundColor, '#221a14');
  assert.equal(rendered, 1);
  // Rendering uses the cache, never resolves CSS per label/frame.
  view.contentEl.win.getComputedStyle = () => {
    throw new Error('per-frame CSS read');
  };
  render.renderFrame(view);
});

async function exportGraph(t, scheme, variables, aura = false) {
  const f = graph(t, scheme, variables);
  if (aura) {
    f.plugin.setNodeVisualSetting('alpha.md', 'node_color', '#123456');
    f.plugin.setNodeVisualSetting('alpha.md', 'aura_radius', 5000);
  }
  const { vault, contents } = mobileVault(t, false);
  Object.assign(f.app.vault, vault);
  f.view.contentEl.win.require = () => assert.fail('Export must not use Node');
  await f.view.commandExportStaticHtml({ exportPath: 'graphfrontier-test.html' });
  const html = contents.get('graphfrontier-test.html');
  assert.equal(typeof html, 'string');
  return { ...f, html };
}

for (const mobile of [false, true]) {
  test(`interactive export opens a vault modal and keeps completion visible (mobile=${mobile})`, async (t) => {
    const { view, plugin, app } = graph(t, 'light');
    const { vault, contents } = mobileVault(t, mobile);
    Object.assign(app.vault, vault);
    const open = obsidian.Modal.prototype.open;
    let modal;
    t.mock.method(obsidian.Modal.prototype, 'open', function () {
      modal = this;
      open.call(this);
    });
    plugin.data.settings.export_static_html_path = '/old/Desktop/graph.html';
    plugin.data.settings.export_static_html_mobile_path = 'Old/graph.html';
    const before = JSON.stringify(plugin.data.settings);
    const result = await view.commandExportStaticHtml();
    assert.equal(result, undefined);
    assert.equal(contents.size, 0);
    assert.equal(modal.destinationPath, 'graphfrontier-static.html');
    await modal.submit();
    assert.ok(contents.get('graphfrontier-static.html').startsWith('<!doctype html>'));
    assert.equal(modal.completed, true);
    assert.equal(modal.opened, true);
    assert.equal(modal.cancelButton.text, 'Close');
    assert.equal(notices.length, 0);
    assert.equal(modal.resultPath, 'graphfrontier-static.html');
    assert.equal(modal.openButton.hidden, false);
    assert.equal(JSON.stringify(plugin.data.settings), before);
    await view.commandExportStaticHtml();
    await modal.submit();
    assert.equal(modal.completed, false);
    assert.match(modal.errorEl.text, /Confirm replacement/);
    assert.equal(contents.size, 1);
    assert.equal(modal.submitButton.text, 'Replace file');
    await modal.submitButton.events.click();
    assert.equal(modal.completed, true);
  });
}

function runExport(html) {
  const { ctx, calls } = recordingCanvas();
  const elements = new Map();
  const canvasEvents = {};
  const windowEvents = {};
  const canvas = {
    getContext: () => ctx,
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      right: 600,
      bottom: 400,
      width: 600,
      height: 400,
    }),
    classList: { add() {}, remove() {} },
    addEventListener: (name, fn) => {
      canvasEvents[name] = fn;
    },
  };
  elements.set('graph', canvas);
  const sandbox = {
    document: {
      getElementById: (id) => {
        if (!elements.has(id)) elements.set(id, {});
        return elements.get(id);
      },
    },
    window: {
      devicePixelRatio: 2,
      addEventListener: (name, fn) => {
        windowEvents[name] = fn;
      },
    },
  };
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(script, sandbox, { timeout: 1000 });
  return { calls, canvasEvents, windowEvents, elements };
}

test('mobile export produces executable graph HTML through Vault without any Node access', async (t) => {
  const { view, app, plugin } = graph(t, 'light');
  const { vault, contents, file } = mobileVault(t);
  Object.assign(app.vault, vault);
  Object.defineProperty(view.contentEl.win, 'require', {
    get() {
      return assert.fail('Mobile export must not access Node/Electron');
    },
  });
  file('alpha.md', '# Mobile preview');
  plugin.data.settings.export_static_html_path = '/desktop/graph.html';
  assert.equal(plugin.data.settings.export_static_html_mobile_path, '');
  await view.commandExportStaticHtml({ exportPath: 'Exports/graph.html' });
  const html = contents.get('Exports/graph.html');
  assert.equal(typeof html, 'string');
  const { canvasEvents, windowEvents, elements } = runExport(html);
  const point = { button: 0, clientX: 300, clientY: 200 };
  canvasEvents.mousedown(point);
  windowEvents.mouseup(point);
  assert.equal(elements.get('panel-title').textContent, 'Alpha');
  assert.match(elements.get('panel-content-html').innerHTML, /Mobile preview/);
  assert.equal(plugin.data.settings.export_static_html_mobile_path, '');
  assert.equal(plugin.data.settings.export_static_html_path, '/desktop/graph.html');
  vault.create = async () => {
    throw new Error('read-only');
  };
  app.vault.create = vault.create;
  await view.commandExportStaticHtml({ exportPath: 'failed.html' });
  assert.equal(plugin.data.settings.export_static_html_mobile_path, '');
  await view.commandExportStaticHtml({ exportPath: '/desktop/invalid.html' });
  assert.equal(contents.has('/desktop/invalid.html'), false);
});

test('exported HTML executes aura drawing with the node color and transparent outer edge', async (t) => {
  const { html } = await exportGraph(t, 'dark', undefined, true);
  const { calls } = runExport(html);
  assert.deepEqual(
    calls.filter((call) => call.kind === 'gradient'),
    [
      { kind: 'gradient', offset: 0, color: '#12345638' },
      { kind: 'gradient', offset: 0.4, color: '#1234561f' },
      { kind: 'gradient', offset: 1, color: '#12345600' },
    ]
  );
});

test('exported HTML renders attachment filenames and unchanged note labels', async (t) => {
  const { view, app } = graph(t, 'dark');
  view.nodes.push(
    { id: 'assets/report.PDF', label: 'report', x: 30, y: 0, degree: 0 },
    { id: 'assets/README', label: 'README', x: 60, y: 0, degree: 0 }
  );
  view.nodeMetaById = new Map([
    ['assets/report.PDF', { isAttachment: true, path: 'assets/report.PDF', fileType: 'pdf' }],
    ['assets/README', { isAttachment: true, path: 'assets/README', fileType: 'attachment' }],
  ]);
  const { vault, contents } = mobileVault(t, false);
  Object.assign(app.vault, vault);
  await view.commandExportStaticHtml({ exportPath: 'labels.html' });
  const html = contents.get('labels.html');
  assert.equal(typeof html, 'string');
  const payload = JSON.parse(html.match(/const EXPORT_DATA = (.*);/)[1]);
  assert.deepEqual(
    payload.nodes.map((node) => node.label),
    ['Alpha', 'report.PDF', 'README']
  );
  const { calls } = runExport(html);
  assert.deepEqual(
    calls.filter((call) => call.kind === 'text').map((call) => call.text),
    ['Alpha', 'report.PDF', 'README']
  );
});

for (const scheme of ['light', 'dark']) {
  test(`${scheme}: generated HTML executes themed drawing, hover, selection, zoom and panel updates`, async (t) => {
    const { view, html } = await exportGraph(t, scheme);
    assert(html.includes(`color-scheme: ${scheme};`));
    assert(html.includes(`background: ${view.canvasTheme.surface};`));
    assert(html.includes(`border-left: 1px solid ${view.canvasTheme.border};`));
    const { calls, canvasEvents, windowEvents, elements } = runExport(html);
    const text = calls.find((call) => call.kind === 'text');
    assert.equal(text.color, view.canvasTheme.text);
    assert(text.alpha >= 0.65);
    assert.equal(calls.find((call) => call.kind === 'stroke').color, view.canvasTheme.grid);
    assert.equal(calls.find((call) => call.kind === 'stroke').alpha, 0.2);

    const point = { button: 0, clientX: 300, clientY: 200 };
    canvasEvents.mousedown(point);
    windowEvents.mouseup(point);
    assert.equal(elements.get('panel-title').textContent, 'Alpha');
    assert.equal(calls.at(-1).color, view.canvasTheme.text);
    assert.equal(calls.at(-1).alpha, 1);
    calls.length = 0;
    for (let i = 0; i < 20; i++) {
      canvasEvents.wheel({ ...point, deltaY: 100, preventDefault() {} });
    }
    windowEvents.mousemove({ clientX: 500, clientY: 350 });
    const selectedLabels = calls.filter((call) => call.kind === 'text' && call.text === 'Alpha');
    assert.equal(selectedLabels.at(-1).alpha, 1);
    assert.equal(parseFloat(selectedLabels.at(-1).font), 10);
    assert(
      calls.some((call) => call.kind === 'stroke' && call.color === view.canvasTheme.selection)
    );
    calls.length = 0;
    windowEvents.mousemove(point);
    const hoveredLabels = calls.filter((call) => call.kind === 'text');
    assert.deepEqual(
      hoveredLabels.map((call) => call.text),
      ['Alpha']
    );
    assert.equal(hoveredLabels[0].color, view.canvasTheme.text);
    assert(
      calls.some((call) => call.kind === 'stroke' && call.color === view.canvasTheme.selection)
    );
  });
}

test('theme fallback works without a DOM and follows light mode when variables are absent', () => {
  assert.equal(readGraphTheme(null).colorScheme, 'dark');
  assert.equal(readGraphTheme(themeElement('light')).background, '#ffffff');
});

test('custom theme colours are carried into standalone HTML without Obsidian CSS', async (t) => {
  const { html } = await exportGraph(t, 'light', {
    '--text-normal': '#46342a',
    '--text-muted': '#836d5c',
    '--background-primary': '#fff8e8',
    '--background-secondary': '#f2e6cc',
  });
  const { calls } = runExport(html);
  assert.equal(calls.find((call) => call.kind === 'text').color, '#46342a');
  assert.equal(calls.find((call) => call.kind === 'stroke').color, '#836d5c');
  assert(html.includes('background: #f2e6cc;'));
});

test('special attachment filenames remain literal and safe in canvas and exported HTML', async (t) => {
  const { view, app, ctx, calls } = graph(t, 'dark');
  const names = ['雪 "quoted" <img onerror="alert(1)">.PnG', "café 'notes'", 'line\u2028break.PDF'];
  const note = {
    id: 'ordinary.md',
    label: 'Note </script> "雪"',
    x: 0,
    y: 0,
    degree: 0,
    meta: { path: 'ordinary.md' },
  };
  const nodes = names.map((name, i) => ({
    id: `assets/${name}`,
    label: `short ${i}`,
    x: 0,
    y: 0,
    degree: 0,
    meta: { isAttachment: true, path: `assets/${name}`, fileType: 'incorrect' },
  }));
  view.nodes = [note, ...nodes];
  view.nodeById = new Map(view.nodes.map((node) => [node.id, node]));
  view.nodeMetaById = new Map(view.nodes.map((node) => [node.id, node.meta]));
  render.drawNodes(view, ctx);
  const expected = [note.label, ...names];
  assert.deepEqual(
    calls.filter((call) => call.kind === 'text').map((call) => call.text),
    expected
  );
  const { vault, contents } = mobileVault(t, false);
  Object.assign(app.vault, vault);
  await view.commandExportStaticHtml({ exportPath: 'special-labels.html', includeContents: false });
  const html = contents.get('special-labels.html');
  assert.equal(typeof html, 'string');
  assert.equal((html.match(/<script>/g) || []).length, 1);
  assert.equal((html.match(/<\/script>/g) || []).length, 1);
  assert.ok(!html.includes('<img onerror='));
  const payload = JSON.parse(html.match(/const EXPORT_DATA = (.*);/)[1]);
  assert.deepEqual(
    payload.nodes.map((node) => node.label),
    expected
  );
  assert.deepEqual(
    runExport(html)
      .calls.filter((call) => call.kind === 'text')
      .map((call) => call.text),
    expected
  );
  assert.equal(nodes[0].label, 'short 0');
});
