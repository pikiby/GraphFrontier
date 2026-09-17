const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, loadSource } = require('./helpers/obsidian.cjs');
const { getLabelFontSize, getLabelMinimumSize } = loadSource('render.js');
const { getLabelAppearance } = loadSource('theme.js');

test('individual sizes remain different below the global minimum font threshold', (t) => {
  const { plugin, view } = fixture(t);
  plugin.setNodeLabelSize('a.md', 20);
  for (const zoom of [0.5, 1, 2, 8]) {
    const globalSize = getLabelFontSize(view);
    const individualSize = getLabelFontSize(view, 'a.md');
    const regular = getLabelAppearance(zoom, 0, globalSize).fontSize;
    const individual = getLabelAppearance(
      zoom,
      0,
      individualSize,
      1,
      false,
      getLabelMinimumSize(view, 'a.md')
    ).fontSize;
    assert.ok(individual > regular);
    assert.ok(Math.abs(individual / regular - 20 / 9) < 0.0001);
  }
});

test('global size cannot change an overridden label at any zoom', (t) => {
  const { plugin, view } = fixture(t);
  plugin.setNodeLabelSize('a.md', 15);
  for (const zoom of [0.5, 1, 2, 8, 12]) {
    const renderedSize = (id) =>
      getLabelAppearance(
        zoom,
        0,
        getLabelFontSize(view, id),
        1,
        false,
        getLabelMinimumSize(view, id)
      ).fontSize;
    const individual = renderedSize('a.md');
    for (const globalSize of [5, 9, 15, 20]) {
      plugin.data.settings.label_font_size = globalSize;
      assert.equal(renderedSize('a.md'), individual);
      assert.equal(getLabelFontSize(view, 'b.md'), globalSize / 5);
      assert.equal(getLabelMinimumSize(view, 'b.md'), (10 * (globalSize / 5)) / (9 / 5));
    }
  }
});

test('node text size is isolated, survives normalization, and resets to global size', (t) => {
  const { plugin, view } = fixture(t);
  plugin.setNodeLabelSize('a.md', 20);
  assert.equal(getLabelFontSize(view, 'a.md'), 4);
  assert.equal(getLabelFontSize(view, 'b.md'), 9 / 5);
  plugin.data = plugin.normalizeData(JSON.parse(JSON.stringify(plugin.data)));
  assert.equal(plugin.getNodeLabelSize('a.md'), 20);
  plugin.data.settings.label_font_size = 15;
  assert.equal(getLabelFontSize(view, 'a.md'), 4);
  assert.equal(getLabelFontSize(view, 'b.md'), 3);
  plugin.setNodeLabelSize('a.md', null);
  assert.equal(getLabelFontSize(view, 'a.md'), 3);
  assert.equal(plugin.getNodeLabelSize('a.md'), null);
});

test('invalid saved sizes are discarded and numeric sizes are bounded', (t) => {
  const { plugin } = fixture(t, { node_label_sizes: { a: 'bad', b: null, c: 100, d: 0 } });
  assert.deepEqual(plugin.data.node_label_sizes, { c: 20, d: 5 });
  plugin.setNodeLabelSize('a', NaN);
  assert.equal(plugin.getNodeLabelSize('a'), null);
});
