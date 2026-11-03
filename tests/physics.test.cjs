const assert = require('node:assert/strict');
const test = require('node:test');
const { DEFAULT_DATA } = require('../src/constants');
const {
  kickLayoutSearch,
  stepSimulation,
  wakeOnPhysicsVisibilityChange,
  resetPhysicsVisibilityBaseline,
} = require('../src/physics');
const { loadReferencePhysics } = require('./helpers/repulsion-reference.cjs');
const referencePhysics = loadReferencePhysics();

for (const scenario of ['mixed', 'filtered', 'drag', 'sparse']) {
  test(`numeric repulsion matches every baseline coordinate and velocity throughout ${scenario} trajectories`, (t) => {
    let seed = 3127;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const nodes = Array.from({ length: 64 }, (_, i) => ({
      id: `node-${i}`,
      x: (random() - 0.5) * 700,
      y: (random() - 0.5) * 700,
      vx: (random() - 0.5) * 0.2,
      vy: (random() - 0.5) * 0.2,
    }));
    nodes[5].x = nodes[6].x;
    nodes[5].y = nodes[6].y;
    if (scenario === 'sparse') {
      nodes[0].x = -1e12;
      nodes[63].y = 1e12;
    }
    const connected = nodes.filter((_, i) => i % 7 !== 0);
    const edges = connected.flatMap((node, i) => [
      { source: node.id, target: connected[(i + 1) % connected.length].id },
      { source: node.id, target: connected[(i + 7) % connected.length].id },
    ]);
    const pins = Object.fromEntries(
      nodes
        .filter((_, i) => i % 11 === 0)
        .map((node, i) => [
          node.id,
          {
            x: node.x,
            y: node.y,
            mode: i % 2 ? 'grid' : 'exact',
          },
        ])
    );
    const orbitPins = {
      'node-7': { anchor_id: 'node-0', radius: 44, angle: 0.75 },
      'node-13': { anchor_id: 'node-1', radius: 80, angle: -0.8 },
    };
    const multipliers = { 'node-2': 4, 'node-4': 7 };
    const visibleIds =
      scenario === 'filtered'
        ? new Set(nodes.filter((_, i) => i % 3).map((node) => node.id))
        : null;
    const options = {
      nodes,
      edges,
      pins,
      orbitPins,
      multipliers,
      visibleIds,
      settings: {
        repel_strength: 1500,
        repel_radius: 200,
        base_link_strength: 46,
        center_strength: 52,
        layout_autosave: false,
      },
    };
    const optimized = fixture(t, options).view;
    const reference = fixture(t, options).view;
    if (scenario === 'drag') {
      optimized.dragNodeId = reference.dragNodeId = 'node-1';
      optimized.dragSelectionOffsets = reference.dragSelectionOffsets = new Map([['node-2', {}]]);
    }
    for (let frame = 0; frame < 1800; frame++) {
      if (frame === 300) multipliers['node-2'] = 9;
      if (frame === 450 && visibleIds) visibleIds.add('node-0');
      stepSimulation(optimized);
      referencePhysics.stepSimulation(reference);
      for (let i = 0; i < nodes.length; i++) {
        for (const key of ['x', 'y', 'vx', 'vy']) {
          assert.equal(
            optimized.nodes[i][key],
            reference.nodes[i][key],
            `${scenario} frame=${frame} node=${i} ${key}`
          );
        }
      }
      assert.equal(optimized.layoutPaused, reference.layoutPaused);
      assert.equal(optimized.layoutStillFrames, reference.layoutStillFrames);
      assert.equal(optimized.layoutAutosaveDirty, reference.layoutAutosaveDirty);
    }
  });
}

test('multipliers are read once per linked node per frame and refreshed next frame', (t) => {
  const nodes = Array.from({ length: 7 }, (_, i) => ({ id: String(i), x: i * 55, y: i * 17 }));
  const edges = nodes.slice(1).map((node) => ({ source: '0', target: node.id }));
  const multipliers = { 0: 3 };
  const f = fixture(t, {
    nodes,
    edges,
    multipliers,
    settings: { base_link_strength: 46, layout_autosave: false },
  });
  const read = t.mock.method(f.view.plugin, 'getNodeMultiplier');
  f.frames(1);
  assert.equal(read.mock.callCount(), 7);
  assert.equal(read.mock.calls[0].result, 3);
  multipliers[0] = 8;
  f.frames(1);
  assert.equal(read.mock.callCount(), 14);
  assert.equal(read.mock.calls[7].result, 8);
});

test('group multiplier context shares leaves only within a frame and respects later groups/leaves', (t) => {
  const { fixture: viewFixture } = require('./helpers/obsidian.cjs');
  const { view, plugin, app, graph } = viewFixture(t);
  graph.nodes = ['a.md', 'b.md', 'c.md'].map((id) => ({
    id,
    label: id,
    meta: { path: id, fileName: id, tags: [], properties: new Map() },
  }));
  graph.edges = [
    { source: 'a.md', target: 'b.md' },
    { source: 'b.md', target: 'c.md' },
    { source: 'a.md', target: 'c.md' },
  ];
  plugin.data.groups = [
    { id: 'g', query: 'name:.md', enabled: true, settings: { strong_pull: true } },
  ];
  plugin.data.settings.strong_pull_multiplier = 7;
  view.refreshFromVault({ keepCamera: true });
  let leaves = [{ view }];
  const lookup = t.mock.method(app.workspace, 'getLeavesOfType', () => leaves);
  const multiplier = t.mock.method(plugin, 'getNodeMultiplier');
  for (const [present, strongPull, expected] of [
    [true, true, 7],
    [false, true, 1],
    [true, true, 7],
    [true, false, 1],
  ]) {
    leaves = present ? [{ view }] : [];
    plugin.data.groups = [{ ...plugin.data.groups[0], settings: { strong_pull: strongPull } }];
    view.stepSimulation();
    assert.equal(lookup.mock.callCount(), 1);
    assert.equal(multiplier.mock.callCount(), 3);
    assert(multiplier.mock.calls.every((call) => call.result === expected));
    lookup.mock.resetCalls();
    multiplier.mock.resetCalls();
  }
});

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

test('visibility preserves survivor hysteresis, wakes returning nodes, and keeps manual kicks global', (t) => {
  const f = fixture(t, {
    nodes: [{ id: 'survivor' }, { id: 'returning' }],
    settings: { center_strength: 100, layout_autosave: false },
  });
  f.frames(8);
  assert.equal(f.view.layoutPaused, true);
  resetPhysicsVisibilityBaseline(f.view);
  // Residual attraction between settle and wake thresholds, like the drag regression.
  for (const node of f.view.nodes) node.x = 10;
  let visible = new Set(['survivor']);
  f.view.getPhysicsVisibleNodeIds = () => visible;
  f.view.layoutEditVersion = 10;
  f.view.pendingLayoutSleepRestore = {};
  f.view.layoutStillFrames = 7;
  assert.equal(wakeOnPhysicsVisibilityChange(f.view), true);
  assert.equal(f.view.layoutEditVersion, 11);
  assert.equal(f.view.pendingLayoutSleepRestore, null);
  assert.equal(f.view.layoutStillFrames, 0);
  assert.equal(f.view.layoutAutosaveDirty, true);
  assert.equal(captureLayoutSleep(f.view), null);
  f.frames();
  assert.equal(f.view.nodeById.get('survivor').x, 10, 'survivor keeps sleep threshold');
  visible.add('returning');
  assert.equal(wakeOnPhysicsVisibilityChange(f.view), true, 'in-place addition detected');
  f.frames();
  assert(f.view.nodeById.get('returning').x < 10, 'returning node wakes below 0.04');
  assert.equal(f.view.nodeById.get('survivor').x, 10);
  visible = null;
  assert.equal(wakeOnPhysicsVisibilityChange(f.view), false, 'Set(all) equals null');
  visible = new Set(['returning', 'survivor']);
  assert.equal(wakeOnPhysicsVisibilityChange(f.view), false, 'null equals Set(all)');
  visible.delete('returning');
  visible.add('not-in-graph');
  assert.equal(wakeOnPhysicsVisibilityChange(f.view), true, 'same-size replacement detected');
  kickLayoutSearch(f.view);
  f.frames();
  assert(f.view.nodeById.get('survivor').x < 10, 'manual kick clears all sleep');
});

test('exclude rebuilds sleeper forces and local degree/mass while distant sleepers stay still', (t) => {
  const f = fixture(t, {
    nodes: [
      { id: 'near' },
      { id: 'left', x: -100 },
      { id: 'right', x: 100 },
      { id: 'far', x: 20000 },
    ],
    edges: [
      { source: 'near', target: 'left' },
      { source: 'near', target: 'right' },
    ],
    pins: { left: { x: -100, y: 0 }, right: { x: 100, y: 0 } },
    settings: { repel_strength: 2500, repel_radius: 400, layout_autosave: false },
  });
  f.frames(8);
  assert.equal(f.view.layoutPaused, true);
  resetPhysicsVisibilityBaseline(f.view);
  let samples = 0;
  setSleepForceProbe(({ sleepers }) => {
    for (const { cached, full } of sleepers) {
      samples++;
      assert(Math.abs(cached[0] - full[0]) < 1e-10);
      assert(Math.abs(cached[1] - full[1]) < 1e-10);
    }
  });
  t.after(() => setSleepForceProbe(null));
  f.view.getPhysicsVisibleNodeIds = () => new Set(['near', 'right', 'far']);
  assert.equal(wakeOnPhysicsVisibilityChange(f.view), true);
  f.frames();
  const near = f.view.nodeById.get('near');
  const retention = Math.pow(0.01, 1 / 60) * (1 - f.settings.damping * 0.95);
  assert(Math.abs(near.vx - -0.25 * 7 * retention) < 1e-10, 'degree 1 uses mass 1');
  assert.equal(f.view.nodeById.get('far').x, 20000);
  assert.equal(f.view.nodeById.get('far').vx, 0);
  assert.equal(f.view.nodeById.get('right').x, 100);
  assert(samples > 0, 'cached forces checked against fresh sums');
  const velocity = near.vx;
  f.view.getPhysicsVisibleNodeIds = () => new Set(['near', 'far']);
  assert.equal(wakeOnPhysicsVisibilityChange(f.view), true);
  f.frames();
  assert(
    Math.abs(near.vx - velocity * retention) < 1e-10,
    'new orphan has no removed-source forces'
  );
});

test('empty physics subset pauses, autosaves after eight quiet ticks, and wakes on return', async (t) => {
  const f = fixture(t, { settings: { center_strength: 100 } });
  f.frames(8);
  await Promise.resolve();
  await Promise.resolve();
  f.calls.length = 0;
  f.advance(1001);
  resetPhysicsVisibilityBaseline(f.view);
  f.view.getPhysicsVisibleNodeIds = () => new Set();
  f.view.nodeById.get('a').vx = 3;
  assert.equal(wakeOnPhysicsVisibilityChange(f.view), true);
  f.frames();
  assert.equal(f.view.layoutPaused, true);
  assert.equal(f.view.nodeById.get('a').vx, 0);
  assert.equal(f.view.layoutStillFrames, 1);
  assert.equal(f.calls.length, 0);
  f.frames(7);
  assert.equal(f.calls.length, 1);
  f.frames(10);
  assert.equal(f.calls.length, 1);
  f.view.nodeById.get('a').x = 10;
  f.view.getPhysicsVisibleNodeIds = () => null;
  assert.equal(wakeOnPhysicsVisibilityChange(f.view), true);
  assert.equal(f.view.layoutStillFrames, 0);
  f.frames();
  assert(f.view.nodeById.get('a').x < 10);
});

test('returning exact, grid and orbit pins retain constraints', (t) => {
  const f = fixture(t, {
    nodes: [
      { id: 'anchor', x: 100 },
      { id: 'grid', x: 200 },
      { id: 'orbit', x: 130 },
      { id: 'free' },
    ],
    pins: { anchor: { x: 100, y: 0 }, grid: { x: 200, y: 0, mode: 'grid' } },
    orbitPins: { orbit: { anchor_id: 'anchor', radius: 30, angle: 0 } },
    settings: { center_strength: 100, layout_autosave: false },
  });
  f.frames(8);
  resetPhysicsVisibilityBaseline(f.view);
  f.view.getPhysicsVisibleNodeIds = () => new Set(['free']);
  assert.equal(wakeOnPhysicsVisibilityChange(f.view), true);
  f.frames();
  f.view.getPhysicsVisibleNodeIds = () => null;
  assert.equal(wakeOnPhysicsVisibilityChange(f.view), true);
  f.frames();
  for (const [id, x] of [
    ['anchor', 100],
    ['grid', 200],
    ['orbit', 130],
  ]) {
    const node = f.view.nodeById.get(id);
    assert.deepEqual([node.x, node.y, node.vx, node.vy], [x, 0, 0, 0]);
  }
});

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

// Sleeping-source cache: exact for moving nodes, consistent for sleepers, invalidated by changes.
const { setSleepForceProbe, captureLayoutSleep, restoreLayoutSleep } = require('../src/physics');

function lockstep(t, options, events = () => {}, frames = 1500) {
  const optimized = fixture(t, options).view;
  const reference = fixture(t, options).view;
  for (let frame = 0; frame < frames; frame++) {
    events(frame, optimized, reference);
    stepSimulation(optimized);
    referencePhysics.stepSimulation(reference);
    for (let i = 0; i < optimized.nodes.length; i++) {
      for (const key of ['x', 'y', 'vx', 'vy']) {
        assert.equal(
          optimized.nodes[i][key],
          reference.nodes[i][key],
          `frame=${frame} node=${i} ${key}`
        );
      }
    }
    assert.equal(optimized.layoutPaused, reference.layoutPaused, `frame=${frame} paused`);
  }
  return { optimized, reference };
}

function randomGraph(count, seed = 7) {
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const nodes = Array.from({ length: count }, (_, i) => ({
    id: `n${i}`,
    x: (random() - 0.5) * 900,
    y: (random() - 0.5) * 900,
  }));
  const edges = [];
  for (let i = 0; i < count; i++) {
    if (i % 5 === 0) continue;
    edges.push({ source: nodes[i].id, target: nodes[Math.floor(random() * count)].id });
  }
  return { nodes, edges: edges.filter((edge) => edge.source !== edge.target) };
}

test('cached sleeper accelerations equal full sums through sleep, wake, kick, pins, drag and multipliers', (t) => {
  const { nodes, edges } = randomGraph(90);
  const pins = { n3: { x: nodes[3].x, y: nodes[3].y, mode: 'exact' } };
  const multipliers = { n1: 3 };
  let samples = 0;
  let worst = 0;
  t.after(() => setSleepForceProbe(null));
  setSleepForceProbe(({ sleepers }) => {
    for (const { cached, full } of sleepers) {
      for (let axis = 0; axis < 2; axis++) {
        const error = Math.abs(cached[axis] - full[axis]);
        worst = Math.max(worst, error / Math.max(Math.abs(full[axis]), 1e-3));
      }
      samples += 1;
    }
  });
  const phases = new Map();
  let phase = 'settle';
  lockstep(
    t,
    {
      nodes,
      edges,
      pins,
      multipliers,
      settings: {
        repel_strength: 900,
        repel_radius: 180,
        base_link_strength: 30,
        center_strength: 40,
        layout_autosave: false,
      },
    },
    (frame, optimized, reference) => {
      const views = [optimized, reference];
      if (frame === 500) {
        phase = 'kick';
        kickLayoutSearch(optimized);
        referencePhysics.kickLayoutSearch(reference);
      }
      if (frame === 900) {
        phase = 'pin';
        pins.n10 = { x: nodes[10].x + 40, y: nodes[10].y, mode: 'exact' };
      }
      if (frame === 1100) {
        phase = 'unpin';
        delete pins.n3;
      }
      if (frame === 1300) {
        phase = 'drag';
        for (const view of views) view.dragNodeId = 'n20';
      }
      if (frame > 1300 && frame < 1340) for (const view of views) view.nodeById.get('n20').x += 3;
      if (frame === 1340) {
        phase = 'release';
        for (const view of views) view.dragNodeId = null;
      }
      if (frame === 1500) {
        phase = 'multiplier';
        multipliers.n1 = 8;
      }
      if (!phases.has(phase)) phases.set(phase, samples);
    },
    1900
  );
  assert(samples > 10000, `sleepers were probed (${samples})`);
  // Every event phase starts with sleepers still being probed afterwards.
  const order = ['settle', 'kick', 'pin', 'unpin', 'drag', 'release', 'multiplier'];
  for (let i = 1; i < order.length; i++) {
    const next = phases.get(order[i + 1]) ?? samples;
    assert(next > phases.get(order[i]), `sleepers were probed after ${order[i]}`);
  }
  assert(worst <= 1e-9, `relative cache error ${worst}`);
});

test('a sleeping node wakes when an awake neighbour approaches', (t) => {
  const { optimized } = lockstep(
    t,
    {
      nodes: [
        { id: 'a', x: 0 },
        { id: 'b', x: 280 },
        { id: 'keep-running', x: -100000 },
      ],
      settings: { repel_strength: 5000, repel_radius: 200, layout_autosave: false },
    },
    (frame, ...views) => {
      for (const view of views) {
        if (frame === 0) view.dragNodeId = 'keep-running';
        if (frame === 40) view.nodeById.get('b').vx = -25;
      }
    },
    200
  );
  const a = optimized.nodeById.get('a');
  assert(a.x < 0, 'the sleeping node was pushed away');
  assert(optimized.nodeById.get('b').x < 250, 'the neighbour entered the repulsion radius');
});

for (const change of ['moved', 'unpinned']) {
  test(`a sleeping node wakes when its pinned neighbour is ${change}`, (t) => {
    const pins = { p: { x: 0, y: 0, mode: 'exact' } };
    let settledX = null;
    const { optimized } = lockstep(
      t,
      {
        nodes: [
          { id: 'a', x: 90 },
          { id: 'p', x: 0 },
          { id: 'keep-running', x: -100000 },
        ],
        pins,
        settings: {
          repel_strength: 2500,
          repel_radius: 400,
          center_strength: 100,
          layout_autosave: false,
        },
      },
      (frame, ...views) => {
        if (frame === 0) for (const view of views) view.dragNodeId = 'keep-running';
        if (frame === 600) {
          settledX = views[0].nodeById.get('a').x;
          if (change === 'moved') pins.p = { x: -3000, y: 0, mode: 'exact' };
          else delete pins.p;
        }
      },
      900
    );
    assert.notEqual(settledX, null);
    assert(optimized.nodeById.get('a').x < settledX - 1, 'the released node moved');
  });
}

test('random graphs settle on the same frame and coordinates as the uncached baseline', (t) => {
  const { nodes, edges } = randomGraph(150, 11);
  let paused = -1;
  const { optimized } = lockstep(
    t,
    {
      nodes,
      edges,
      pins: { n0: { x: nodes[0].x, y: nodes[0].y, mode: 'exact' } },
      // Repulsion at the cutoff stays below the sleep threshold, so this graph settles.
      settings: {
        repel_strength: 300,
        repel_radius: 400,
        base_link_strength: 25,
        center_strength: 10,
        layout_autosave: false,
      },
    },
    (frame, view) => {
      if (paused < 0 && view.layoutPaused) paused = frame;
    },
    7000
  );
  assert(paused > 0 && optimized.layoutPaused, 'the graph settled');
});

test('sleep signatures keep the localeCompare ordering of saved layouts', (t) => {
  const ids = ['b', 'B', 'a', 'é', 'Z', '_x', '10', '9', 'ä', 'A'];
  const options = {
    nodes: ids.map((id, i) => ({ id, x: i * 400, y: (i % 3) * 400 })),
    edges: [
      { source: 'b', target: 'B' },
      { source: 'é', target: 'a' },
      { source: '10', target: '9' },
      { source: 'A', target: 'ä' },
    ],
    settings: { center_strength: 30, layout_autosave: false },
  };
  const reference = fixture(t, options).view;
  for (let i = 0; i < 6000 && !reference.layoutPaused; i++)
    referencePhysics.stepSimulation(reference);
  const saved = referencePhysics.captureLayoutSleep(reference);
  assert(saved, 'the baseline captured its sleep state');
  const restored = fixture(t, {
    ...options,
    nodes: reference.nodes.map(({ id, x, y }) => ({ id, x, y })),
  }).view;
  assert.equal(restoreLayoutSleep(restored, saved), true);
  restored.layoutPaused = true;
  assert.deepEqual(captureLayoutSleep(restored)?.nodes, saved.nodes);
});

// Degree-based tree: hubs among the first few nodes, so link masses differ widely.
function asymmetricTree(seed, count = 25) {
  let state = seed;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const nodes = Array.from({ length: count }, (_, i) => ({
    id: `n${i}`,
    x: (random() - 0.5) * 300,
    y: (random() - 0.5) * 300,
  }));
  const edges = nodes.slice(1).map((node, i) => ({
    source: `n${Math.floor(random() * Math.min(i + 1, 4))}`,
    target: node.id,
  }));
  return { nodes, edges };
}

const freeClusterSettings = {
  repel_strength: 200,
  repel_radius: 535,
  center_strength: 0,
  base_link_strength: 17,
  link_distance: 33,
  damping: 0.01,
  layout_autosave: false,
};

const centroid = (nodes) => [
  nodes.reduce((sum, node) => sum + node.x, 0) / nodes.length,
  nodes.reduce((sum, node) => sum + node.y, 0) / nodes.length,
];

for (const seed of [1, 2, 3, 4, 5, 6]) {
  test(`an isolated asymmetric tree settles in place without self-propulsion (seed ${seed})`, (t) => {
    const { view } = fixture(t, { ...asymmetricTree(seed), settings: freeClusterSettings });
    const [startX, startY] = centroid(view.nodes);
    for (let i = 0; i < 20000 && !view.layoutPaused; i++) stepSimulation(view);
    assert.equal(view.layoutPaused, true, 'the free cluster comes to rest');
    const [endX, endY] = centroid(view.nodes);
    assert(Math.hypot(endX - startX, endY - startY) < 100, 'the cluster does not travel');
  });
}

test('without pins or center the summed momentum of a free cluster stays zero', (t) => {
  const { view } = fixture(t, { ...asymmetricTree(4), settings: freeClusterSettings });
  const mass = (node) => 1 + Math.max(0, node.degree - 1) * 0.25;
  // Until the settle rule first zeroes a slow node, pair forces alone change velocities.
  let frame = 0;
  for (; frame < 1000; frame++) {
    stepSimulation(view);
    if (view.nodes.some((node) => node.vx === 0 && node.vy === 0)) break;
    let px = 0;
    let py = 0;
    let scale = 0;
    for (const node of view.nodes) {
      px += mass(node) * node.vx;
      py += mass(node) * node.vy;
      scale += mass(node) * Math.hypot(node.vx, node.vy);
    }
    assert(scale > 0, `frame=${frame} cluster is moving`);
    assert(Math.hypot(px, py) <= 1e-9 * scale, `frame=${frame} momentum ${Math.hypot(px, py)}`);
  }
  assert(frame >= 60, `momentum checked over ${frame} frames`);
});
