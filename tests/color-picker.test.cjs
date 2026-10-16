const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadSource } = require('./helpers/obsidian.cjs');
const { GraphFrontierView } = loadSource('view.js');

function setup() {
  const input = {
    style: {},
    events: {},
    focus() {
      this.focused = true;
    },
    click() {
      this.clicked = true;
    },
    remove() {
      this.removed = true;
    },
  };
  const applied = [];
  const doc = { createElement: () => input, body: { appendChild() {} } };
  const view = {
    contentEl: { ownerDocument: doc, win: { innerWidth: 800, innerHeight: 600 } },
    plugin: {
      data: {},
      getPaintedEdgeColor: () => '#446688',
      setPaintedEdgeColor: (id, color) => applied.push({ id, color }),
      renderAllViews() {},
    },
    registerDomEvent: (el, event, handler) => {
      el.events[event] = handler;
    },
  };
  return { view, input, applied };
}

test('edge color opens the native color input at the pointer', async () => {
  const { view, input } = setup();
  await GraphFrontierView.prototype.promptPickPaintedEdgeColor.call(view, 'a', 120, 160);
  assert.equal(input.type, 'color');
  assert.equal(input.value, '#446688');
  assert.equal(input.style.left, '120px');
  assert.equal(input.style.top, '160px');
  assert.equal(input.clicked, true);
});

test('native color input and change apply the selected edge color', async () => {
  const { view, input, applied } = setup();
  await GraphFrontierView.prototype.promptPickPaintedEdgeColor.call(view, 'a');
  assert.equal(input.style.left, '400px');
  input.value = '#123456';
  input.events.input();
  input.events.change();
  assert.deepEqual(applied, [
    { id: 'a', color: '#123456' },
    { id: 'a', color: '#123456' },
  ]);
});

test('native edge picker rejects edits after a layout switch', async () => {
  const { view, input, applied } = setup();
  await GraphFrontierView.prototype.promptPickPaintedEdgeColor.call(view, 'a');
  view.plugin.data = {};
  input.events.input();
  assert.deepEqual(applied, []);
  assert.equal(input.removed, true);
});

test('swatches retain compact styling without a replacement color modal', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/view.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../src/static/styles.css'), 'utf8');
  assert.doesNotMatch(source, /bindColorPicker|openColorPicker/);
  assert.doesNotMatch(css, /graphfrontier-color-modal/);
  assert.match(css, /input\.graphfrontier-group-color-input\s*\{\s*width: 26px/);
});
