const assert = require('node:assert/strict');
const test = require('node:test');
const { element, fixture } = require('./helpers/obsidian.cjs');

function selectionFixture(t, settings = {}) {
  const f = fixture(t, { settings });
  const { view } = f;
  view.nodes = ['a.md', 'b.md', 'c.md'].map((id, index) => ({
    id,
    x: 10 + index * 30,
    y: 10,
    vx: 0,
    vy: 0,
  }));
  view.nodeById = new Map(view.nodes.map((node) => [node.id, node]));
  view.canvasEl = element();
  view.canvasEl.getBoundingClientRect = () => ({ left: 20, top: 30 });
  t.mock.method(view, 'worldToScreen', (x, y) => ({ x, y }));
  t.mock.method(view, 'screenToWorld', (x, y) => ({ x, y }));
  t.mock.method(view, 'getNodeAtScreen', (x, y) =>
    view.nodes.find((node) => Math.hypot(node.x - x, node.y - y) < 3)
  );
  const event = (x, y, modifiers = {}) => ({
    button: 0,
    clientX: x + 20,
    clientY: y + 30,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    preventDefault() {},
    stopPropagation() {},
    ...modifiers,
  });
  const box = (startX, endX, modifiers = { shiftKey: true }, endModifiers = modifiers) => {
    view.onMouseDown(event(startX, 0, modifiers));
    assert.ok(view.boxSelectDrag);
    view.onMouseMove(event(endX, 20, endModifiers));
    view.onMouseUp(event(endX, 20, endModifiers));
    assert.equal(view.boxSelectDrag, null);
  };
  return { ...f, event, box };
}

test('successive disjoint Shift boxes accumulate selection, overlaps do not toggle or duplicate', (t) => {
  const { view, box } = selectionFixture(t);
  box(0, 20);
  assert.deepEqual([...view.selectedNodeIds], ['a.md']);
  box(30, 50);
  assert.deepEqual([...view.selectedNodeIds], ['a.md', 'b.md']);
  box(0, 80);
  assert.deepEqual([...view.selectedNodeIds], ['a.md', 'b.md', 'c.md']);
  box(30, 50);
  assert.deepEqual([...view.selectedNodeIds], ['a.md', 'b.md', 'c.md']);
});

test('empty Shift box preserves the previous selection', (t) => {
  const { view, box } = selectionFixture(t);
  view.setNodeSelection(['a.md', 'c.md']);
  box(100, 120);
  assert.deepEqual([...view.selectedNodeIds], ['a.md', 'c.md']);
});

test('Shift baseline is snapshotted at pointer down and survives releasing Shift', (t) => {
  const { view, event } = selectionFixture(t);
  view.setNodeSelection(['a.md']);
  view.onMouseDown(event(30, 0, { shiftKey: true }));
  view.selectedNodeIds.clear();
  view.selectedNodeIds.add('c.md');
  view.onMouseMove(event(50, 20));
  view.onMouseUp(event(50, 20));
  assert.deepEqual([...view.selectedNodeIds], ['a.md', 'b.md']);
});

test('configured box modifier without Shift replaces, including an empty box', (t) => {
  const { view, box } = selectionFixture(t, { selection_box_modifier: 'alt' });
  view.setNodeSelection(['a.md']);
  box(30, 50, { altKey: true });
  assert.deepEqual([...view.selectedNodeIds], ['b.md']);
  box(100, 120, { altKey: true });
  assert.equal(view.selectedNodeIds.size, 0);
});

test('Shift adds with a different configured box modifier, but not when pressed after start', (t) => {
  const { view, box } = selectionFixture(t, { selection_box_modifier: 'alt' });
  view.setNodeSelection(['a.md']);
  box(30, 50, { altKey: true, shiftKey: true });
  assert.deepEqual([...view.selectedNodeIds], ['a.md', 'b.md']);
  box(60, 80, { altKey: true }, { altKey: true, shiftKey: true });
  assert.deepEqual([...view.selectedNodeIds], ['c.md']);
});

test('armed box selection without Shift retains replacement semantics', (t) => {
  const { view, box } = selectionFixture(t);
  view.setNodeSelection(['a.md']);
  view.boxSelectArmed = true;
  box(30, 50, {});
  assert.deepEqual([...view.selectedNodeIds], ['b.md']);
  assert.equal(view.boxSelectArmed, false);
});

test('plain background click still clears accumulated selection', (t) => {
  const { view, box, event } = selectionFixture(t);
  box(0, 20);
  box(30, 50);
  view.onMouseDown(event(100, 100));
  assert.equal(view.boxSelectDrag, null);
  view.onMouseUp(event(100, 100));
  assert.equal(view.selectedNodeIds.size, 0);
});

test('node toggle and selected-node dragging still take precedence over Shift box selection', (t) => {
  const { view, event } = selectionFixture(t, { selection_toggle_modifier: 'alt' });
  view.setNodeSelection(['a.md']);
  view.onMouseDown(event(10, 10, { altKey: true, shiftKey: true }));
  assert.equal(view.selectedNodeIds.size, 0);
  assert.equal(view.boxSelectDrag, null);
  view.onMouseDown(event(40, 10, { altKey: true, shiftKey: true }));
  assert.deepEqual([...view.selectedNodeIds], ['b.md']);

  view.setNodeSelection(['a.md', 'b.md']);
  const kick = t.mock.method(view, 'kickLayoutSearch', () => {});
  view.onMouseDown(event(10, 10, { shiftKey: true }));
  assert.equal(view.boxSelectDrag, null);
  assert.equal(view.dragNodeId, 'a.md');
  view.onMouseMove(event(15, 15, { shiftKey: true }));
  view.onMouseUp(event(15, 15));
  assert.deepEqual([...view.selectedNodeIds], ['a.md', 'b.md']);
  assert.deepEqual(
    view.nodes.map(({ x, y }) => [x, y]),
    [
      [15, 15],
      [45, 15],
      [70, 10],
    ]
  );
  assert.equal(kick.mock.callCount(), 1);
});

test('configured quick pick puts node name in search without opening or dragging', (t) => {
  const { view, event } = selectionFixture(t);
  view.nodes[0].label = 'Alpha';
  view.searchInputValue = 'path:old';
  view.searchInputEl = { value: 'path:old' };
  t.mock.method(view, 'openNodeFile', () => assert.fail('Quick pick must not open a file'));
  view.onMouseDown(event(10, 10, { altKey: true }));
  view.onMouseUp(event(10, 10, { altKey: true }));
  assert.equal(view.searchInputValue, 'name:Alpha');
  assert.equal(view.searchInputEl.value, 'name:Alpha');
  assert.equal(view.searchSelectedNodeId, 'a.md');
  assert.equal(view.dragNodeId, null);
});

test('quick pick None leaves ordinary opening intact', (t) => {
  const { view, event } = selectionFixture(t, { quick_pick_modifier: 'none' });
  const opened = [];
  t.mock.method(view, 'openNodeFile', (id) => opened.push(id));
  view.onMouseDown(event(10, 10, { altKey: true }));
  view.onMouseUp(event(10, 10, { altKey: true }));
  assert.deepEqual(opened, ['a.md']);
  assert.equal(view.searchInputValue, 'name:');
});

test('quick pick overrides preview on configured Ctrl and restarts Filter layout', (t) => {
  const { view, event } = selectionFixture(t, { quick_pick_modifier: 'ctrl' });
  view.searchMode = 'filter';
  view.nodes[0].label = 'Alpha';
  view.layoutPaused = true;
  t.mock.method(view, 'toggleQuickPreview', () => assert.fail('Search has priority'));
  view.onMouseDown(event(10, 10, { ctrlKey: true }));
  assert.equal(view.searchInputValue, 'name:Alpha');
  assert.equal(view.layoutPaused, false);
});

test('selection wins shared modifier; default Ctrl preview is unchanged', (t) => {
  const { view, event } = selectionFixture(t, { selection_toggle_modifier: 'alt' });
  view.onMouseDown(event(10, 10, { altKey: true }));
  assert.deepEqual([...view.selectedNodeIds], ['a.md']);
  assert.equal(view.searchInputValue, 'name:');
  const previews = [];
  t.mock.method(view, 'toggleQuickPreview', (id) => previews.push(id));
  view.onMouseDown(event(40, 10, { ctrlKey: true }));
  assert.deepEqual(previews, ['b.md']);
});

test('dragging a selection records a single reversible mouse gesture, clicking records none', (t) => {
  const { loadSource } = require('./helpers/obsidian.cjs');
  const { historyFor, replayPositionAction } = loadSource('position-history.js');
  const { view, event } = selectionFixture(t);
  view.setNodeSelection(['a.md', 'b.md']);
  view.onMouseDown(event(10, 10));
  view.onMouseMove(event(20, 20));
  view.onMouseMove(event(30, 40));
  view.onMouseUp(event(30, 40));
  assert.equal(historyFor(view).undo.length, 1);
  assert.deepEqual(
    view.nodes.slice(0, 2).map((n) => [n.x, n.y]),
    [
      [30, 40],
      [60, 40],
    ]
  );
  assert.equal(replayPositionAction(view), 'applied');
  assert.deepEqual(
    view.nodes.slice(0, 2).map((n) => [n.x, n.y]),
    [
      [10, 10],
      [40, 10],
    ]
  );
  view.onMouseDown(event(10, 10));
  view.onMouseUp(event(10, 10), { suppressClick: true });
  assert.equal(historyFor(view).undo.length, 0);
  assert.equal(historyFor(view).redo.length, 1);
});
