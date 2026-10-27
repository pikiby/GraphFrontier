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
    degree: (options.edges || []).filter(
      (edge) => edge.source === node.id || edge.target === node.id
    ).length,
    ...node,
  }));
  const pins = options.pins || {};
  const edges = options.edges || [];
  const neighborsById = new Map(nodes.map((node) => [node.id, new Set()]));
  for (const edge of edges) {
    neighborsById.get(edge.source)?.add(edge.target);
    neighborsById.get(edge.target)?.add(edge.source);
  }
  const calls = [];
  const view = {
    nodes,
    edges,
    nodeById: new Map(nodes.map((node) => [node.id, node])),
    neighborsById,
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
      getNodeMultiplier: (id) => options.multipliers?.[id] || 1,
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

function repulsionFixture(t, kinds, pinnedId = null, mode = 'exact') {
  const nodes = [
    { id: 'a', x: 0 },
    { id: 'b', x: 60 },
    { id: 'anchor', x: 10000 },
  ];
  const edges = [];
  const pins = { anchor: { x: 10000, y: 0, mode: 'exact' } };
  for (const [index, kind] of kinds.entries()) {
    if (kind === 'orphan') continue;
    const id = `support-${index}`;
    const x = 20000 + index * 1000;
    nodes.push({ id, x, meta: { isAttachment: kind === 'attachment-only' } });
    pins[id] = { x, y: 0, mode: 'exact' };
    edges.push({ source: nodes[index].id, target: id });
  }
  const orbitPins = {};
  if (pinnedId) {
    const node = nodes.find((item) => item.id === pinnedId);
    if (mode === 'orbit')
      orbitPins[pinnedId] = { anchor_id: 'anchor', radius: 10000 - node.x, angle: Math.PI };
    else pins[pinnedId] = { x: node.x, y: 0, mode };
  }
  return fixture(t, {
    nodes,
    edges,
    pins,
    orbitPins,
    settings: { repel_strength: 1500, repel_radius: 200, layout_autosave: false },
  });
}

for (const kinds of [
  ['regular', 'regular'],
  ['orphan', 'orphan'],
  ['attachment-only', 'attachment-only'],
  ['orphan', 'regular'],
  ['orphan', 'attachment-only'],
  ['attachment-only', 'regular'],
]) {
  for (const mode of ['exact', 'grid', 'orbit']) {
    for (const pinnedId of ['a', 'b']) {
      test(`${kinds.join('/')} repulsion is unchanged by ${mode} pinning ${pinnedId}`, (t) => {
        const baseline = repulsionFixture(t, kinds);
        const pinned = repulsionFixture(t, kinds, pinnedId, mode);
        const freeId = pinnedId === 'a' ? 'b' : 'a';
        const fixed = pinned.view.nodeById.get(pinnedId);
        const initialPosition = { x: fixed.x, y: fixed.y };
        baseline.frames();
        pinned.frames();
        const expected = baseline.view.nodeById.get(freeId);
        const actual = pinned.view.nodeById.get(freeId);
        assert.notEqual(expected.vx, 0, 'the baseline pair must repel');
        assert.equal(actual.vx, expected.vx, 'pinning must not change force on the free node');
        assert.equal(actual.vy, expected.vy);
        assert(Math.abs(fixed.x - initialPosition.x) < 1e-8);
        assert(Math.abs(fixed.y - initialPosition.y) < 1e-8);
        assert.equal(fixed.vx, 0);
        assert.equal(fixed.vy, 0);
      });
    }
  }
}

for (const mode of ['exact', 'grid', 'orbit']) {
  for (const pinnedId of ['a', 'b']) {
    test(`${mode} pinned ${pinnedId} keeps link attraction and strong pull`, (t) => {
      function simulate(multiplier) {
        const x = pinnedId === 'a' ? 0 : 120;
        const f = fixture(t, {
          nodes: [{ id: 'a' }, { id: 'b', x: 120 }, { id: 'anchor', x: 10000 }],
          edges: [{ source: 'a', target: 'b' }],
          pins: {
            anchor: { x: 10000, y: 0 },
            ...(mode === 'orbit' ? {} : { [pinnedId]: { x, y: 0, mode } }),
          },
          orbitPins:
            mode === 'orbit'
              ? { [pinnedId]: { anchor_id: 'anchor', radius: 10000 - x, angle: Math.PI } }
              : {},
          multipliers: { [pinnedId]: multiplier },
          settings: { base_link_strength: 10, link_distance: 20, layout_autosave: false },
        });
        f.frames();
        const fixed = f.view.nodeById.get(pinnedId);
        assert(Math.abs(fixed.x - x) < 1e-8);
        assert(Math.abs(fixed.y) < 1e-8);
        assert.equal(fixed.vx, 0);
        return f.view.nodeById.get(pinnedId === 'a' ? 'b' : 'a').vx;
      }
      const normal = simulate(1);
      const strong = simulate(3);
      assert(pinnedId === 'a' ? normal < 0 : normal > 0);
      assert(Math.abs(strong - normal * 3) < 1e-8);
    });
  }
}

for (const mode of ['exact', 'grid']) {
  for (const sameParent of [true, false]) {
    test(`${mode} pinned attachments repel regardless of parent (${sameParent ? 'same' : 'different'} parent)`, (t) => {
      const f = fixture(t, {
        nodes: [
          { id: 'a', meta: { isAttachment: true } },
          { id: 'b', x: 60, meta: { isAttachment: true } },
          { id: 'parent-a', x: 10000 },
          { id: 'parent-b', x: 20000 },
        ],
        edges: [
          { source: 'a', target: 'parent-a' },
          { source: 'b', target: sameParent ? 'parent-a' : 'parent-b' },
        ],
        pins: {
          a: { x: 0, y: 0, mode },
          'parent-a': { x: 10000, y: 0 },
          'parent-b': { x: 20000, y: 0 },
        },
        settings: { repel_strength: 1500, repel_radius: 200, layout_autosave: false },
      });
      f.frames();
      assert.equal(f.view.nodeById.get('a').x, 0);
      const free = f.view.nodeById.get('b');
      assert(free.x > 60);
    });
  }
}

test('two grid pins stay fixed while an unrelated free node keeps physics running', (t) => {
  const f = fixture(t, {
    nodes: [{ id: 'a' }, { id: 'b', x: 60 }, { id: 'free', x: 90 }],
    edges: [{ source: 'a', target: 'b' }],
    pins: { a: { x: 0, y: 0, mode: 'grid' }, b: { x: 60, y: 0, mode: 'grid' } },
    multipliers: { a: 10 },
    settings: { repel_strength: 1500, base_link_strength: 100, layout_autosave: false },
  });
  f.frames(10);
  for (const [id, x] of [
    ['a', 0],
    ['b', 60],
  ]) {
    const node = f.view.nodeById.get(id);
    assert.deepEqual({ x: node.x, y: node.y, vx: node.vx, vy: node.vy }, { x, y: 0, vx: 0, vy: 0 });
  }
  assert(f.view.nodeById.get('free').x > 90);
});

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

test('forces keep moving nodes after three seconds, then equilibrium pauses and saves', async (t) => {
  const f = fixture(t, {
    nodes: [{ id: 'a', x: 100 }],
    settings: { center_strength: 100 },
  });
  f.advance(3000);
  f.frames(1);
  const movingX = f.view.nodes[0].x;
  assert.notEqual(movingX, 100);
  assert.equal(f.view.layoutPaused, false);
  assert.equal(f.view.layoutStillFrames, 0);
  assert.equal(f.calls.length, 0);
  f.frames(3000);
  await flushSaves();
  assert.equal(f.view.layoutPaused, true);
  assert.equal(f.calls.length, 1);
  assert(Math.abs(f.view.nodes[0].x) < Math.abs(movingX));
  const settledX = f.view.nodes[0].x;
  f.frames(100);
  assert.equal(f.view.nodes[0].x, settledX);
});

test('eight quiet frames pause the simulation and finish the autosave debounce', async (t) => {
  const f = fixture(t);
  f.advance(3000);
  f.frames(7);
  assert.equal(f.view.layoutPaused, false);
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
  kickLayoutSearch(f.view);
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

test('sleeping nodes ignore tiny force changes but wake for meaningful attraction during a drag', (t) => {
  const f = fixture(t, {
    nodes: [{ id: 'a' }, { id: 'drag' }],
    settings: { center_strength: 100, layout_autosave: false },
  });
  f.view.dragNodeId = 'drag';
  f.frames(8);
  const node = f.view.nodes[0];
  node.x = 10; // Net acceleration 0.025, between sleep and wake thresholds.
  f.frames(10);
  assert.equal(node.x, 10);
  node.x = 100;
  f.frames(1);
  assert(node.x < 100);
  assert(node.vx < 0);
});

test('explicit layout changes wake a fully settled graph even below the hysteresis threshold', (t) => {
  const f = fixture(t, { settings: { center_strength: 100, layout_autosave: false } });
  f.frames(8);
  assert.equal(f.view.layoutPaused, true);
  f.view.nodes[0].x = 10;
  kickLayoutSearch(f.view);
  f.frames(1);
  assert(f.view.nodes[0].x < 10);
  assert.equal(f.view.layoutPaused, false);
});

for (const legacyIsolation of [undefined, false, true]) {
  for (const forces of ['repel', 'spring', 'center', 'combined']) {
    for (const filtered of [false, true]) {
      for (const constraint of ['free', 'exact', 'grid', 'orbit', 'drag']) {
        test(
          'same-topology attachment physics: ' +
            [legacyIsolation, forces, filtered, constraint].join('/'),
          (t) => {
            const nodes = [
              { id: 'core', x: -180, y: -80 },
              { id: 'a', x: 50, y: 20 },
              { id: 'b', x: 100, y: 100 },
              { id: 'note', x: 220, y: 30 },
              { id: 'orphan', x: -40, y: 160 },
              { id: 'orphan2', x: -140, y: 130 },
              { id: 'hidden', x: 400, y: 120 },
            ];
            const options = {
              nodes,
              edges: [
                { source: 'core', target: 'a' },
                { source: 'core', target: 'b' },
                { source: 'a', target: 'b' },
                { source: 'a', target: 'note' },
                { source: 'note', target: 'hidden' },
              ],
              settings: {
                repel_strength: ['repel', 'combined'].includes(forces) ? 200 : 0,
                base_link_strength: ['spring', 'combined'].includes(forces) ? 20 : 0,
                center_strength: ['center', 'combined'].includes(forces) ? 25 : 0,
                link_distance: 45,
                repel_radius: 1000,
                layout_autosave: false,
              },
              multipliers: { a: 3 },
              visibleIds: filtered ? new Set(['core', 'a', 'b', 'orphan', 'orphan2']) : null,
              pins: ['exact', 'grid'].includes(constraint)
                ? { a: { x: 50, y: 20, mode: constraint } }
                : {},
              orbitPins:
                constraint === 'orbit'
                  ? {
                      a: {
                        anchor_id: 'core',
                        radius: Math.hypot(230, 100),
                        angle: Math.atan2(100, 230),
                      },
                    }
                  : {},
            };
            const baseline = fixture(t, options);
            const attachments = fixture(t, {
              ...options,
              nodes: nodes.map((node) => ({
                ...node,
                meta: { isAttachment: ['a', 'b', 'orphan', 'hidden'].includes(node.id) },
              })),
              settings: {
                ...options.settings,
                attachment_size_multiplier: 0.8,
                attachment_link_distance_multiplier: 14,
                attachments_on_orbits: legacyIsolation,
              },
            });
            if (constraint === 'drag') {
              baseline.view.dragSelectionOffsets = new Map([['a', { x: 0, y: 0 }]]);
              attachments.view.dragSelectionOffsets = new Map([['a', { x: 0, y: 0 }]]);
            }
            const state = (f) => ({
              nodes: f.view.nodes.map(({ id, x, y, vx, vy }) => ({ id, x, y, vx, vy })),
              center: f.view.layoutCenter,
              paused: f.view.layoutPaused,
            });
            for (let frame = 0; frame < 20; frame++) {
              baseline.frames();
              attachments.frames();
              assert.deepEqual(state(attachments), state(baseline));
            }
            assert(
              baseline.view.nodes.some((node, i) => node.x !== nodes[i].x || node.y !== nodes[i].y)
            );
          }
        );
      }
    }
  }
}
