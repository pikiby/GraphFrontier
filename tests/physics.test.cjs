const assert = require('node:assert/strict');
const test = require('node:test');
const { DEFAULT_DATA } = require('../src/constants');
const { kickLayoutSearch, stepSimulation } = require('../src/physics');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const flushSaves = () => new Promise((resolve) => setImmediate(resolve));

function fixture(t, options = {}) {
  let now = 10000;
  t.mock.method(Date, 'now', () => now);
  const settings = {
    ...DEFAULT_DATA.settings,
    repel_strength: 0,
    center_strength: 0,
    base_link_strength: 0,
    layout_autosave: true,
    ...options.settings,
  };
  const nodes = (options.nodes || [{ id: 'a' }]).map((node) => ({
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    degree: 0,
    ...node,
  }));
  const pins = options.pins || {};
  const calls = [];
  const view = {
    nodes,
    edges: [],
    nodeById: new Map(nodes.map((node) => [node.id, node])),
    neighborsById: new Map(),
    layoutCenter: { x: 0, y: 0 },
    layoutKickAtMs: now,
    layoutStillFrames: 0,
    layoutAutosaveDirty: options.dirty ?? true,
    layoutPaused: options.paused ?? false,
    dragNodeId: null,
    dragSelectionOffsets: null,
    searchFilled: false,
    plugin: {
      getSettings: () => settings,
      getPin: (id) => pins[id] || null,
      getOrbitPin: (id) => options.orbitPins?.[id] || null,
      clampNumber: (value, min, max, fallback) =>
        Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Number(value))) : fallback,
    },
    getFilterVisibleNodeIds: () => options.visibleIds ?? null,
    isSearchFilled() {
      return this.searchFilled;
    },
    async saveCurrentLayout(saveOptions) {
      const kickedAt = this.layoutKickAtMs;
      const snapshot = {
        options: saveOptions,
        positions: this.nodes.map(({ id, x, y }) => ({ id, x, y })),
      };
      calls.push(snapshot);
      const saved = options.persist ? await options.persist(snapshot, calls.length) : true;
      // Model the view contract without importing Obsidian or its persistence implementation.
      const unchanged =
        kickedAt === this.layoutKickAtMs &&
        JSON.stringify(snapshot.positions) ===
          JSON.stringify(this.nodes.map(({ id, x, y }) => ({ id, x, y })));
      if (saved && unchanged) {
        this.layoutAutosaveDirty = false;
        this.layoutStillFrames = 0;
      }
      return saved;
    },
  };
  return {
    view,
    settings,
    pins,
    calls,
    advance(ms) {
      now += ms;
    },
    frames(count = 1, interval = 16) {
      for (let frame = 0; frame < count; frame += 1) {
        now += interval;
        stepSimulation(view);
      }
    },
  };
}

test('a moved pinned node in an all-fixed graph saves after release and debounce', async (t) => {
  const f = fixture(t, {
    dirty: false,
    paused: true,
    nodes: [{ id: 'a', x: 10, y: 20 }],
    pins: { a: { x: 10, y: 20 } },
  });
  f.view.dragNodeId = 'a';
  f.view.nodes[0].x = 80;
  f.view.nodes[0].y = 90;
  f.frames(12);
  assert.equal(f.calls.length, 0);

  f.pins.a = { x: 80, y: 90 };
  f.view.dragNodeId = null;
  kickLayoutSearch(f.view);
  f.frames(1);
  assert.equal(f.view.layoutPaused, true);
  assert.equal(f.view.layoutAutosaveDirty, true);
  f.frames(6);
  assert.equal(f.calls.length, 0);
  f.frames(1);
  await flushSaves();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0], {
    options: { silent: true },
    positions: [{ id: 'a', x: 80, y: 90 }],
  });
  assert.equal(f.view.layoutAutosaveDirty, false);
  f.frames(200);
  assert.equal(f.calls.length, 1);
});

test('an all-fixed graph including an orbit pin can autosave without moving nodes', async (t) => {
  const f = fixture(t, {
    nodes: [{ id: 'a' }, { id: 'b', x: 20 }],
    pins: { a: { x: 0, y: 0 } },
    orbitPins: { b: { anchor_id: 'a', radius: 20, angle: 0 } },
  });
  f.frames(8);
  await flushSaves();
  assert.equal(f.view.layoutPaused, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.view.nodes[1].x, 20);
});

test('a settled movable graph saves once after eight still frames', async (t) => {
  const f = fixture(t);
  f.frames(7);
  assert.equal(f.calls.length, 0);
  f.frames(1);
  await flushSaves();
  assert.equal(f.calls.length, 1);
  assert.equal(f.view.layoutAutosaveDirty, false);
  f.frames(200);
  assert.equal(f.calls.length, 1);
});

test('a three-second forced pause still saves a layout that never settled', async (t) => {
  const f = fixture(t, {
    nodes: [{ id: 'a', x: 100 }],
    settings: { center_strength: 100 },
  });
  f.advance(3000);
  f.frames(1);
  const pausedX = f.view.nodes[0].x;
  assert.notEqual(pausedX, 100);
  assert.equal(f.view.layoutPaused, true);
  assert.equal(f.view.layoutStillFrames, 0);
  assert.equal(f.calls.length, 0);
  f.frames(8);
  await flushSaves();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].positions[0].x, pausedX);
  assert.equal(f.view.nodes[0].x, pausedX);
});

test('a pause before eight still frames finishes the debounce on paused frames', async (t) => {
  const f = fixture(t);
  f.advance(3000);
  f.frames(7);
  assert.equal(f.view.layoutPaused, true);
  assert.equal(f.calls.length, 0);
  f.frames(1);
  await flushSaves();
  assert.equal(f.calls.length, 1);
});

for (const paused of [false, true]) {
  for (const blocked of ['OFF', 'search', 'drag', 'selection drag', 'no dirty']) {
    test(`${blocked} prevents saves in ${paused ? 'paused' : 'active'} layouts`, async (t) => {
      const f = fixture(t, { paused, dirty: blocked !== 'no dirty' });
      if (blocked === 'OFF') f.settings.layout_autosave = false;
      if (blocked === 'search') f.view.searchFilled = true;
      if (blocked === 'drag') f.view.dragNodeId = 'a';
      if (blocked === 'selection drag') {
        f.view.dragSelectionOffsets = new Map([['a', { x: 0, y: 0 }]]);
      }
      f.frames(200);
      await flushSaves();
      assert.equal(f.calls.length, 0);
      assert.equal(f.view.layoutAutosaveDirty, blocked !== 'no dirty');
    });
  }
}

test('loaded unchanged all-fixed layouts are never marked dirty or overwritten', async (t) => {
  const f = fixture(t, { dirty: false, pins: { a: { x: 0, y: 0 } } });
  f.frames(200);
  await flushSaves();
  assert.equal(f.view.layoutPaused, true);
  assert.equal(f.view.layoutAutosaveDirty, false);
  assert.equal(f.calls.length, 0);
});

for (const paused of [false, true]) {
  test(`dirty settings autosave with no nodes in ${paused ? 'paused' : 'active'} layouts`, async (t) => {
    const f = fixture(t, { nodes: [], paused });
    f.settings.grid_step = 40;
    f.frames(7);
    assert.equal(f.calls.length, 0);
    assert.equal(f.view.layoutAutosaveDirty, true);
    f.frames(1);
    await flushSaves();
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calls[0], { options: { silent: true }, positions: [] });
    assert.equal(f.view.layoutAutosaveDirty, false);
    assert.equal(f.view.layoutPaused, paused);
    f.frames(200);
    assert.equal(f.calls.length, 1);
  });
}

for (const blocked of ['OFF', 'search', 'drag', 'selection drag', 'no dirty']) {
  test(`empty layouts respect the ${blocked} autosave guard`, async (t) => {
    const f = fixture(t, { nodes: [], dirty: blocked !== 'no dirty' });
    if (blocked === 'OFF') f.settings.layout_autosave = false;
    if (blocked === 'search') f.view.searchFilled = true;
    if (blocked === 'drag') f.view.dragNodeId = 'a';
    if (blocked === 'selection drag') {
      f.view.dragSelectionOffsets = new Map([['a', { x: 0, y: 0 }]]);
    }
    f.frames(200);
    await flushSaves();
    assert.equal(f.calls.length, 0);
    assert.equal(f.view.layoutAutosaveDirty, blocked !== 'no dirty');
  });
}

test('empty layouts retry failed saves without clearing dirty or concurrent writes', async (t) => {
  const pending = deferred();
  const f = fixture(t, {
    nodes: [],
    persist: (_snapshot, attempt) => (attempt === 1 ? pending.promise : true),
  });
  f.frames(8);
  f.frames(200);
  assert.equal(f.calls.length, 1);
  assert.equal(f.view.layoutAutosaveDirty, true);
  pending.resolve(false);
  await flushSaves();
  f.frames(40);
  assert.equal(f.calls.length, 1);
  assert.equal(f.view.layoutAutosaveDirty, true);
  f.advance(1000);
  f.frames(1);
  await flushSaves();
  assert.equal(f.calls.length, 2);
  assert.equal(f.view.layoutAutosaveDirty, false);
});

for (const searchFilled of [false, true]) {
  test(`all nodes filtered out ${searchFilled ? 'respects search restriction' : 'still allows autosave'}`, async (t) => {
    const f = fixture(t, { visibleIds: new Set() });
    f.view.searchFilled = searchFilled;
    f.frames(8);
    await flushSaves();
    assert.equal(f.calls.length, searchFilled ? 0 : 1);
    assert.equal(f.view.layoutAutosaveDirty, searchFilled);
  });
}

for (const blocked of ['OFF', 'search']) {
  test(`dragging with ${blocked} does not change the existing pause or force behavior`, async (t) => {
    const f = fixture(t, {
      paused: true,
      nodes: [
        { id: 'a', x: 50 },
        { id: 'b', x: 100, vx: 10 },
      ],
    });
    if (blocked === 'OFF') f.settings.layout_autosave = false;
    if (blocked === 'search') f.view.searchFilled = true;
    f.view.dragNodeId = 'a';
    f.frames(1);
    assert.equal(f.view.layoutPaused, true);
    assert.equal(f.view.nodes[0].x, 50);
    assert.ok(f.view.nodes[1].x > 100);
    const otherX = f.view.nodes[1].x;
    f.view.dragNodeId = null;
    f.frames(1);
    await flushSaves();
    assert.equal(f.view.nodes[1].x, otherX);
    assert.equal(f.calls.length, 0);
  });
}

for (const blocked of ['OFF', 'search', 'drag']) {
  test(`a dirty paused layout remains saveable after ${blocked} is removed`, async (t) => {
    const f = fixture(t, { paused: true });
    if (blocked === 'OFF') f.settings.layout_autosave = false;
    if (blocked === 'search') f.view.searchFilled = true;
    if (blocked === 'drag') f.view.dragNodeId = 'a';
    f.frames(20);
    f.settings.layout_autosave = true;
    f.view.searchFilled = false;
    f.view.dragNodeId = null;
    f.frames(7);
    assert.equal(f.calls.length, 0);
    f.frames(1);
    await flushSaves();
    assert.equal(f.calls.length, 1);
  });
}

for (const failure of ['false', 'rejection', 'throw']) {
  test(`save ${failure} preserves dirty and retries without concurrent or per-frame writes`, async (t) => {
    const pending = deferred();
    const f = fixture(t, {
      paused: true,
      persist: (_snapshot, attempt) => (attempt === 1 ? pending.promise : true),
    });
    if (failure === 'throw') {
      const save = f.view.saveCurrentLayout.bind(f.view);
      f.view.saveCurrentLayout = (options) => {
        if (f.calls.length === 0) {
          f.calls.push({ options });
          throw new Error('write failed');
        }
        return save(options);
      };
    }
    f.frames(8);
    assert.equal(f.calls.length, 1);
    assert.equal(f.view.layoutAutosaveDirty, true);
    f.frames(500, 0);
    assert.equal(f.calls.length, 1);
    if (failure === 'rejection') pending.reject(new Error('write failed'));
    if (failure === 'false') pending.resolve(false);
    await flushSaves();
    assert.equal(f.view.layoutAutosaveDirty, true);
    f.frames(40);
    assert.equal(f.calls.length, 1);
    f.advance(1000);
    f.frames(1);
    await flushSaves();
    assert.equal(f.calls.length, 2);
    assert.equal(f.view.layoutAutosaveDirty, false);
    f.frames(200);
    assert.equal(f.calls.length, 2);
  });
}

test('physics never acknowledges dirty itself, even when a save returns true', async (t) => {
  const f = fixture(t, { paused: true });
  f.view.saveCurrentLayout = async (options) => {
    f.calls.push({ options });
    return true;
  };
  f.frames(8);
  await flushSaves();
  assert.equal(f.calls.length, 1);
  assert.equal(f.view.layoutAutosaveDirty, true);
  f.frames(40);
  assert.equal(f.calls.length, 1);
});

for (const blocked of ['OFF', 'search', 'drag']) {
  test(`a failed save rechecks ${blocked} before retrying`, async (t) => {
    const f = fixture(t, {
      paused: true,
      persist: (_snapshot, attempt) => attempt > 1,
    });
    f.frames(8);
    await flushSaves();
    assert.equal(f.calls.length, 1);
    if (blocked === 'OFF') f.settings.layout_autosave = false;
    if (blocked === 'search') f.view.searchFilled = true;
    if (blocked === 'drag') f.view.dragNodeId = 'a';
    f.advance(2000);
    f.frames(100);
    await flushSaves();
    assert.equal(f.calls.length, 1);
    assert.equal(f.view.layoutAutosaveDirty, true);
    f.settings.layout_autosave = true;
    f.view.searchFilled = false;
    f.view.dragNodeId = null;
    f.frames(8);
    await flushSaves();
    assert.equal(f.calls.length, 2);
    assert.equal(f.view.layoutAutosaveDirty, false);
  });
}

test('an unresolved save stays exclusive even past the retry delay', async (t) => {
  const pending = deferred();
  const f = fixture(t, { paused: true, persist: () => pending.promise });
  f.frames(8);
  f.advance(10000);
  f.frames(100);
  assert.equal(f.calls.length, 1);
  assert.equal(f.view.layoutAutosaveDirty, true);
  pending.resolve(true);
  await flushSaves();
  assert.equal(f.view.layoutAutosaveDirty, false);
});

test('persistent failures are throttled even when each attempt finishes between frames', async (t) => {
  const f = fixture(t, { paused: true, persist: () => false });
  f.frames(8);
  await flushSaves();
  for (let frame = 0; frame < 180; frame += 1) {
    f.frames(1);
    await flushSaves();
  }
  assert.equal(f.calls.length, 3);
  assert.equal(f.view.layoutAutosaveDirty, true);
});

test('a same-millisecond kick during an outstanding save stays dirty and gets its own save', async (t) => {
  const pending = deferred();
  const f = fixture(t, {
    pins: { a: { x: 0, y: 0 } },
    persist: (_snapshot, attempt) => (attempt === 1 ? pending.promise : true),
  });
  kickLayoutSearch(f.view);
  f.frames(8, 0);
  assert.equal(f.calls.length, 1);
  f.view.nodes[0].x = 50;
  f.pins.a.x = 50;
  kickLayoutSearch(f.view);
  const kickedAt = f.view.layoutKickAtMs;
  pending.resolve(true);
  await flushSaves();
  assert.equal(f.view.layoutAutosaveDirty, true);
  assert.equal(f.view.layoutPaused, false);
  assert.equal(f.view.layoutStillFrames, 0);
  assert.equal(f.view.layoutKickAtMs, kickedAt);
  f.advance(1000);
  f.frames(8);
  await flushSaves();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].positions[0].x, 0);
  assert.equal(f.calls[1].positions[0].x, 50);
  assert.equal(f.view.layoutAutosaveDirty, false);
});

test('simulation movement while saving stays dirty for a subsequent save', async (t) => {
  const pending = deferred();
  const f = fixture(t, {
    persist: (_snapshot, attempt) => (attempt === 1 ? pending.promise : true),
  });
  f.frames(8);
  assert.equal(f.calls.length, 1);
  f.view.nodes[0].vx = 10;
  f.frames(1);
  assert.ok(f.view.nodes[0].x > 0);
  f.frames(30);
  assert.equal(f.calls.length, 1);
  pending.resolve(true);
  await flushSaves();
  assert.equal(f.view.layoutAutosaveDirty, true);
  f.advance(1000);
  f.frames(8);
  await flushSaves();
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls[1].positions[0].x > 0);
});

test('new kicks restart the debounce instead of saving an intermediate fixed layout', async (t) => {
  const f = fixture(t, { pins: { a: { x: 0, y: 0 } } });
  f.frames(7);
  kickLayoutSearch(f.view);
  f.frames(7);
  assert.equal(f.calls.length, 0);
  f.frames(1);
  await flushSaves();
  assert.equal(f.calls.length, 1);
});
