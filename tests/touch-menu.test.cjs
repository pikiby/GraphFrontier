const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSource } = require('./helpers/obsidian.cjs');
const { GraphFrontierView } = loadSource('view.js');
const proto = GraphFrontierView.prototype;

test('touch and mouse share background creation menu and world position', () => {
  let menu;
  let created;
  const view = {
    canvasEl: { getBoundingClientRect: () => ({ left: 10, top: 20 }) },
    getNodeAtScreen: () => null,
    screenToWorld: (x, y) => ({ x: x * 2, y: y * 2 }),
    showMenuAtPointer: (value) => {
      menu = value;
    },
    editDarkEnergy: (node, position) => {
      created = { node, position };
    },
    openContextMenuAt: proto.openContextMenuAt,
  };
  proto.openTouchContextMenuAt.call(view, 40, 60);
  assert.equal(menu.items[0].title, 'Create gravity node');
  menu.items[0].callback();
  assert.deepEqual(created, { node: null, position: { x: 60, y: 80 } });
  let prevented = false;
  proto.onContextMenu.call(view, {
    clientX: 40,
    clientY: 60,
    preventDefault() {
      prevented = true;
    },
  });
  assert.equal(prevented, true);
  assert.equal(menu.items[0].title, 'Create gravity node');
});

test('single touch schedules long press on empty background as well as nodes', () => {
  for (const node of [null, { id: 'test.md' }]) {
    let scheduled;
    const view = {
      clearTouchLongPressTimer() {},
      getTouchScreenPoint: () => ({ x: 1, y: 2 }),
      startSingleTouchGesture: () => node,
      scheduleTouchLongPress: (...args) => {
        scheduled = args;
      },
    };
    proto.onTouchStart.call(view, { touches: [{ clientX: 10, clientY: 20 }] });
    assert.deepEqual(scheduled, [node?.id ?? null, 10, 20]);
  }
});

function touchHarness(t, node = null) {
  const previous = global.window;
  let timer;
  global.window = {
    setTimeout(callback, delay) {
      timer = { callback, delay };
      return 1;
    },
    clearTimeout() {
      timer = null;
    },
  };
  t.after(() => {
    if (previous === undefined) delete global.window;
    else global.window = previous;
  });
  const menus = [],
    clicks = [];
  const view = Object.assign(Object.create(proto), {
    canvasEl: {
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
      addClass() {},
      removeClass() {},
    },
    camera: { x: 0, y: 0, zoom: 1 },
    cameraTarget: { x: 0, y: 0, zoom: 1 },
    getNodeAtScreen: () => node,
    screenToWorld: (x, y) => ({ x, y }),
    openTouchContextMenuAt: (...args) => menus.push(args),
    onMouseUp: (...args) => clicks.push(args),
    persistViewState() {},
    startPinchGesture() {
      this.touchGesture = { mode: 'pinch' };
    },
    updatePinchGesture() {},
  });
  const event = (x = 20, y = 30) => ({
    touches: [{ identifier: 1, clientX: x, clientY: y }],
    cancelable: true,
    preventDefault() {},
  });
  return { view, menus, clicks, event, timer: () => timer };
}

test('background hold opens once at 450ms and release suppresses click', (t) => {
  const h = touchHarness(t);
  h.view.onTouchStart(h.event());
  assert.equal(h.timer().delay, 450);
  const fire = h.timer().callback;
  fire();
  fire();
  assert.deepEqual(h.menus, [[20, 30]]);
  assert.equal(h.view.panDrag, null);
  h.view.onTouchEnd({ touches: [] });
  assert.equal(h.clicks[0][1].suppressClick, true);
});

test('short tap cancels long press', (t) => {
  const h = touchHarness(t);
  h.view.onTouchStart(h.event());
  const fire = h.timer().callback;
  h.view.onTouchEnd({ touches: [] });
  assert.equal(h.timer(), null);
  fire();
  assert.deepEqual(h.menus, []);
  assert.equal(h.clicks[0][1].suppressClick, false);
});

test('movement above 10px cancels menu but still pans camera', (t) => {
  const h = touchHarness(t);
  h.view.onTouchStart(h.event());
  const fire = h.timer().callback;
  h.view.onTouchMove(h.event(40, 30));
  assert.equal(h.timer(), null);
  fire();
  assert.deepEqual(h.menus, []);
  assert.equal(h.view.cameraTarget.x, -20);
});

test('second finger cancels hold and enters pinch', (t) => {
  const h = touchHarness(t);
  h.view.onTouchStart(h.event());
  const fire = h.timer().callback;
  const event = h.event();
  event.touches.push({ identifier: 2, clientX: 80, clientY: 80 });
  h.view.onTouchStart(event);
  assert.equal(h.timer(), null);
  fire();
  assert.deepEqual(h.menus, []);
  assert.equal(h.view.touchGesture.mode, 'pinch');
});

test('existing node hold stops drag and retains node context action', (t) => {
  const h = touchHarness(t, { id: 'test.md', x: 0, y: 0 });
  h.view.onTouchStart(h.event());
  assert.equal(h.view.dragNodeId, 'test.md');
  h.timer().callback();
  assert.equal(h.view.dragNodeId, null);
  assert.deepEqual(h.menus, [[20, 30]]);
});
