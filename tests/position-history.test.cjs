const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, loadSource } = require('./helpers/obsidian.cjs');
const {
  beginPositionAction,
  finishPositionAction,
  historyFor,
  replayPositionAction,
  invalidatePositionHistory,
} = loadSource('position-history.js');

function setup(t) {
  const f = fixture(t);
  f.view.nodes.push({ id: 'beta.md', x: 80, y: 90, vx: 0, vy: 0 });
  f.view.nodeById = new Map(f.view.nodes.map((n) => [n.id, n]));
  return f;
}

test('multi-node drag is one step; simulation movement and list status are not restored', (t) => {
  const { view, plugin } = setup(t);
  const before = view.nodes.map((n) => ({ x: n.x, y: n.y }));
  const token = beginPositionAction(view, ['alpha.md', 'beta.md'], true);
  for (const n of view.nodes) n.x += 100;
  finishPositionAction(view, token);
  assert.equal(historyFor(view).undo.length, 1);
  plugin.data.groups = [{ id: 'error', query: 'list:ERROR', color: '#ff0000' }];
  view.nodes[0].x += 20;
  assert.equal(replayPositionAction(view), 'applied');
  assert.deepEqual(
    view.nodes.map((n) => ({ x: n.x, y: n.y })),
    before
  );
  assert.equal(plugin.data.groups[0].query, 'list:ERROR');
  assert.equal(replayPositionAction(view, true), 'applied');
  assert.equal(view.nodes[0].x, before[0].x + 100);
});

test('pin/grid/unpin undo restores modes and orbit without creating extra actions', (t) => {
  const { view, plugin } = setup(t);
  plugin.setOrbitPin('alpha.md', { anchor_id: 'beta.md', radius: 50, angle: 1 });
  const snapshot = view.captureNodeActionTargets(view.nodes[0]);
  view.applyNodePinAction(snapshot, 'grid');
  assert.equal(plugin.getPinMode('alpha.md'), 'grid');
  assert.equal(historyFor(view).undo.length, 1);
  assert.equal(replayPositionAction(view), 'applied');
  assert.equal(plugin.getPin('alpha.md'), null);
  assert.equal(plugin.getOrbitPin('alpha.md').radius, 50);
  assert.equal(replayPositionAction(view, true), 'applied');
  assert.equal(plugin.getPinMode('alpha.md'), 'grid');
  view.applyNodePinAction(snapshot, 'unpin');
  assert.equal(plugin.getPin('alpha.md'), null);
  assert.equal(replayPositionAction(view), 'applied');
  assert.equal(plugin.getPinMode('alpha.md'), 'grid');
});

test('new action clears redo, no-op does not, history is bounded and layout isolated', (t) => {
  const { view, plugin } = setup(t);
  const move = () =>
    view.runPositionAction(
      ['alpha.md'],
      () => {
        view.nodes[0].x += 1;
      },
      true
    );
  move();
  replayPositionAction(view);
  view.runPositionAction(['alpha.md'], () => {}, true);
  assert.equal(historyFor(view).redo.length, 1);
  move();
  assert.equal(historyFor(view).redo.length, 0);
  for (let i = 0; i < 110; i++) move();
  assert.equal(historyFor(view).undo.length, 100);
  plugin.data = plugin.normalizeData({});
  assert.equal(replayPositionAction(view), 'empty');
});

test('conflicting pin edits and API invalidation cannot overwrite newer changes', (t) => {
  const { view, plugin } = setup(t);
  view.applyNodePinAction(view.captureNodeActionTargets(view.nodes[0]), 'exact');
  plugin.setPin('alpha.md', { x: 999, y: 999 });
  assert.equal(replayPositionAction(view), 'conflict');
  assert.equal(plugin.getPin('alpha.md').x, 999);
  const token = beginPositionAction(view, ['alpha.md'], true);
  invalidatePositionHistory(plugin.data);
  view.nodes[0].x++;
  finishPositionAction(view, token);
  assert.equal(replayPositionAction(view), 'empty');
});

test('keyboard scope respects editable fields, active graph, Ctrl+Y and Shift+Z', (t) => {
  const { view, app } = setup(t);
  const doc = { body: {}, activeElement: null };
  view.contentEl.ownerDocument = doc;
  view.contentEl.contains = () => false;
  app.workspace.activeLeaf = { view };
  let prevented = 0;
  const event = (code, extra = {}) => ({
    code,
    ctrlKey: true,
    target: doc.body,
    preventDefault() {
      prevented++;
    },
    stopPropagation() {},
    ...extra,
  });
  view.runPositionAction(['alpha.md'], () => (view.nodes[0].x = 100), true);
  view.onPositionHistoryKeyDown(event('KeyZ', { target: { isContentEditable: true } }));
  assert.equal(prevented, 0);
  view.onPositionHistoryKeyDown(event('KeyZ'));
  assert.equal(view.nodes[0].x, 25);
  view.onPositionHistoryKeyDown(event('KeyY'));
  assert.equal(view.nodes[0].x, 100);
  view.onPositionHistoryKeyDown(event('KeyZ'));
  view.onPositionHistoryKeyDown(event('KeyZ', { shiftKey: true }));
  assert.equal(view.nodes[0].x, 100);
  app.workspace.activeLeaf = { view: {} };
  assert.equal(view.onPositionHistoryKeyDown(event('KeyZ')), undefined);
  assert.equal(view.nodes[0].x, 100);
});

test('two panes share the layout history and local data has a separate history', (t) => {
  const { view, plugin, app } = setup(t);
  const { GraphFrontierView } = loadSource('view.js');
  const other = new GraphFrontierView({ app }, plugin);
  other.nodes = view.nodes.map((n) => ({ ...n }));
  other.nodeById = new Map(other.nodes.map((n) => [n.id, n]));
  other.render = () => {};
  view.runPositionAction(['alpha.md'], () => (view.nodes[0].x = 250), true);
  assert.equal(historyFor(view), historyFor(other));
  assert.equal(replayPositionAction(other), 'applied');
  assert.equal(view.nodes[0].x, 25);
  assert.equal(other.nodes[0].x, 25);
  other.plugin = Object.create(plugin);
  other.plugin.data = plugin.normalizeData({});
  other.plugin.isLocalGraphFrontier = true;
  assert.equal(replayPositionAction(other, true), 'empty');
});
