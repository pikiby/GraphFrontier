const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, loadSource } = require('./helpers/obsidian.cjs');
const { startGrow, stopGrow, stepGrow, isGrowActive } = loadSource('effects.js');
const { historyFor, replayPositionAction } = loadSource('position-history.js');

test('Grow gives birth to nodes in creation order with physics and is one undo step', (t) => {
  const { view, plugin, app } = fixture(t, { settings: { grow_duration: 4 } });
  const created = { 'old.md': 100, 'mid.md': 200, 'new.md': 300 };
  view.nodes = ['new.md', 'old.md', 'mid.md'].map((id, index) => ({
    id,
    x: 500 + index * 100,
    y: 300,
    vx: 0,
    vy: 0,
  }));
  view.nodes.push({ id: 'gravity', x: -400, y: 700, vx: 0, vy: 0, meta: { darkEnergy: {} } });
  view.nodeById = new Map(view.nodes.map((node) => [node.id, node]));
  view.neighborsById = new Map([
    ['old.md', new Set(['mid.md'])],
    ['mid.md', new Set(['old.md'])],
    ['new.md', new Set()],
  ]);
  plugin.setPin('new.md', { x: 500, y: 300 });
  app.vault.getAbstractFileByPath = (path) =>
    created[path] ? { path, stat: { ctime: created[path] } } : null;
  const before = view.nodes.map((node) => [node.id, node.x, node.y]);

  startGrow(view);
  const start = view.growEffect.startMs;
  const visible = () => [...view.getFilterVisibleNodeIds()].sort();
  assert.deepEqual(visible(), ['gravity'], 'nodes without a creation time come first');
  assert.deepEqual(
    [view.nodeById.get('gravity').x, view.nodeById.get('gravity').y],
    [-400, 700],
    'a gravity node keeps its place'
  );
  stepGrow(view, start + 1400);
  assert.deepEqual(visible(), ['gravity', 'old.md']);
  const old = view.nodeById.get('old.md');
  assert(Math.hypot(old.x, old.y) < 20, 'an unpinned node starts its life again');
  assert.equal(view.layoutPaused, false, 'physics runs while the graph grows');

  stepGrow(view, start + 2700);
  assert.deepEqual(visible(), ['gravity', 'mid.md', 'old.md']);
  const mid = view.nodeById.get('mid.md');
  assert(Math.hypot(mid.x - old.x, mid.y - old.y) < 20, 'born next to a linked neighbor');

  stepGrow(view, start + 4000);
  assert.equal(isGrowActive(view), false);
  assert.deepEqual(
    [view.nodeById.get('new.md').x, view.nodeById.get('new.md').y],
    [500, 300],
    'a pinned node keeps its pin'
  );
  assert.equal(view.getFilterVisibleNodeIds(), null, 'every node is back after Grow');
  assert.equal(historyFor(view).undo.length, 1, 'the whole Grow is one undo step');
  assert.equal(replayPositionAction(view), 'applied');
  assert.deepEqual(
    view.nodes.map((node) => [node.id, node.x, node.y]),
    before
  );
  assert.equal(
    plugin.normalizeData({ settings: { grow_duration: 500 } }).settings.grow_duration,
    60
  );
});

test('Wave runs along links step by step up to its depth and fades without moving nodes', (t) => {
  const { startWave, isWaveActive, waveLinkState, waveRingState } = loadSource('effects.js');
  const { view } = fixture(t, { settings: { wave_depth: 2 } });
  // a - b - c - d, plus b - e
  view.nodes = ['a', 'b', 'c', 'd', 'e'].map((id, index) => ({ id, x: index * 10, y: 0 }));
  view.nodeById = new Map(view.nodes.map((node) => [node.id, node]));
  view.neighborsById = new Map([
    ['a', new Set(['b'])],
    ['b', new Set(['a', 'c', 'e'])],
    ['c', new Set(['b', 'd'])],
    ['d', new Set(['c'])],
    ['e', new Set(['b'])],
  ]);
  const positions = view.nodes.map((node) => [node.x, node.y]);
  assert.equal(startWave(view, []), false, 'nothing selected, no wave');
  assert.equal(startWave(view, ['a']), true);
  const wave = view.waveEffect;
  assert.deepEqual(
    wave.links.map((link) => [link.from, link.to, link.step]),
    [
      ['a', 'b', 1],
      ['b', 'c', 2],
      ['b', 'e', 2],
    ],
    'depth 2 stops before d'
  );
  const start = wave.startMs;
  const [ab, bc] = wave.links;
  assert.deepEqual(waveLinkState(view, ab, start + 175), { progress: 0.5 });
  assert.equal(waveLinkState(view, bc, start + 175), null, 'the second step waits');
  assert.equal(waveLinkState(view, ab, start + 350), null, 'the light has arrived');
  const ring = (id) => wave.rings.find((entry) => entry.id === id);
  assert.deepEqual(waveRingState(view, ring('a'), start + 350), { spread: 0.5, alpha: 0.5 });
  assert.equal(waveRingState(view, ring('b'), start + 349), null, 'b rings when reached');
  assert.deepEqual(waveRingState(view, ring('b'), start + 350), { spread: 0, alpha: 1 });
  assert.equal(ring('d'), undefined);
  assert.equal(isWaveActive(view, start + 2 * 350 + 699), true);
  assert.equal(isWaveActive(view, start + 2 * 350 + 700), false);
  assert.equal(view.waveEffect, null);
  assert.deepEqual(
    view.nodes.map((node) => [node.x, node.y]),
    positions
  );
});

test('Wave waits for a click on the graph and starts without dragging or opening the note', (t) => {
  const { view } = fixture(t);
  view.nodes = [
    { id: 'a', x: 0, y: 0 },
    { id: 'b', x: 10, y: 0 },
  ];
  view.nodeById = new Map(view.nodes.map((node) => [node.id, node]));
  view.neighborsById = new Map([
    ['a', new Set(['b'])],
    ['b', new Set(['a'])],
  ]);
  const classes = {};
  view.canvasEl = {
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    toggleClass: (name, on) => (classes[name] = on),
    addClass() {},
    removeClass() {},
  };
  let target = view.nodes[0];
  view.getNodeAtScreen = () => target;
  view.openNodeFile = () => assert.fail('the note must not open');
  view.setWaveArmed(true);
  assert.equal(classes['is-wave-armed'], true, 'the cursor becomes a crosshair');
  view.onMouseDown({ button: 0, clientX: 5, clientY: 5 });
  view.onMouseUp({ button: 0, detail: 1 });
  assert.deepEqual(
    view.waveEffect.rings.map((ring) => ring.id),
    ['a', 'b']
  );
  assert.equal(view.dragNodeId, null);
  assert.equal(view.waveArmed, false, 'one wave per click on Wave');

  view.waveEffect = null;
  target = null;
  Object.assign(view, { viewWidth: 100, viewHeight: 100, camera: { x: 0, y: 0, zoom: 1 } });
  view.setWaveArmed(true);
  view.onMouseDown({ button: 0, clientX: 58, clientY: 52 });
  assert.equal(view.waveEffect.rings[0].id, 'b', 'empty space starts from the nearest node');
  assert.equal(view.waveArmed, false);
});

test('Pulse sends a shockwave from a tap on empty space that pushes nodes out or pulls them in', (t) => {
  const { togglePulse, activePulseWaves } = loadSource('effects.js');
  const physics = loadSource('physics.js');
  const { replayPositionAction } = loadSource('position-history.js');
  const setup = (inward) => {
    const f = fixture(t, {
      settings: {
        pulse_strength: 5,
        pulse_radius: 400,
        pulse_softness: 5,
        pulse_inward: inward,
        repel_strength: 0,
        center_strength: 1,
      },
    });
    const { view, plugin } = f;
    view.nodes = [
      { id: 'hit', x: 150, y: 0, vx: 0, vy: 0, degree: 0, meta: {} },
      { id: 'far', x: 900, y: 0, vx: 0, vy: 0, degree: 0, meta: {} },
      { id: 'pinned', x: 0, y: 150, vx: 0, vy: 0, degree: 0, meta: {} },
    ];
    view.nodeById = new Map(view.nodes.map((node) => [node.id, node]));
    view.edges = [];
    plugin.setPin('pinned', { x: 0, y: 150 });
    Object.assign(view, { viewWidth: 1000, viewHeight: 1000, camera: { x: 0, y: 0, zoom: 1 } });
    view.canvasEl = {
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
      addClass() {},
      removeClass() {},
    };
    view.getNodeAtScreen = () => null;
    return view;
  };
  const run = (view) => {
    const end = Date.now() + 2000;
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      while (now < end) {
        physics.stepSimulation(view);
        now += 16;
      }
    } finally {
      Date.now = realNow;
    }
  };

  const outward = setup(false);
  const before = outward.nodes.map((node) => [node.x, node.y]);
  assert.equal(togglePulse(outward), true);
  outward.onMouseDown({ button: 0, clientX: 500, clientY: 500 }); // the world origin
  assert.equal(activePulseWaves(outward).length, 1, 'a tap on empty space sends a wave');
  run(outward);
  const node = (view, id) => view.nodeById.get(id);
  assert(node(outward, 'hit').x > 170, 'the front pushed the node away from the tap');
  // A node the wave never reaches moves exactly as it does without any wave.
  const calm = setup(false);
  calm.layoutPaused = false;
  run(calm);
  assert(Math.abs(node(outward, 'far').x - node(calm, 'far').x) < 0.5, 'beyond the radius');
  assert.deepEqual([node(outward, 'pinned').x, node(outward, 'pinned').y], [0, 150]);
  assert.equal(togglePulse(outward), false);
  assert.equal(replayPositionAction(outward), 'applied', 'the session is one undo step');
  assert.deepEqual(
    outward.nodes.map((entry) => [entry.x, entry.y]),
    before
  );

  const inward = setup(true);
  togglePulse(inward);
  inward.onMouseDown({ button: 0, clientX: 500, clientY: 500 });
  run(inward);
  assert(node(inward, 'hit').x < 130, 'Inward pulls the node towards the tap');

  const onNode = setup(false);
  togglePulse(onNode);
  onNode.getNodeAtScreen = () => node(onNode, 'hit');
  onNode.onMouseDown({ button: 0, clientX: 650, clientY: 500 });
  assert.equal(activePulseWaves(onNode).length, 0, 'a press on a node does not send a wave');
});

test('Grow schedules only visible nodes when filters hide notes and leaves hidden coordinates untouched', (t) => {
  const { view, plugin, app } = fixture(t, {
    settings: { grow_duration: 3 },
    whitelist: [{ id: 'keep', query: 'tag:keep', enabled: true }],
  });
  const created = {
    'v1.md': 100,
    'v2.md': 200,
    'h1.md': 300,
    'h2.md': 400,
    'h3.md': 500,
    'v3.md': 600,
  };
  view.nodes = Object.keys(created).map((id, index) => ({
    id,
    x: 400 + index * 50,
    y: 250 + index * 10,
    vx: 0,
    vy: 0,
    meta: id.startsWith('v') ? { tags: ['keep'] } : { tags: ['other'] },
  }));
  view.nodeById = new Map(view.nodes.map((node) => [node.id, node]));
  view.neighborsById = new Map(view.nodes.map((node) => [node.id, new Set()]));
  app.vault.getAbstractFileByPath = (path) =>
    created[path] ? { path, stat: { ctime: created[path] } } : null;
  view.markQueryRuleVisibilityDirty();

  assert.equal(startGrow(view), true);
  assert.equal(view.growEffect.revealAtMs.size, 3);
  assert.equal(view.growEffect.revealAtMs.get('v1.md'), 0);
  assert.equal(view.growEffect.revealAtMs.get('v2.md'), 1500);
  assert.equal(view.growEffect.revealAtMs.get('v3.md'), 3000);

  const start = view.growEffect.startMs;
  stepGrow(view, start + 1500);
  assert.deepEqual([...view.getFilterVisibleNodeIds()].sort(), ['v1.md', 'v2.md']);

  // Relaxing the filter mid-Grow still shows newly revealed unscheduled nodes immediately.
  plugin.data.whitelist = [];
  view.markQueryRuleVisibilityDirty();
  assert.deepEqual([...view.getFilterVisibleNodeIds()].sort(), [
    'h1.md',
    'h2.md',
    'h3.md',
    'v1.md',
    'v2.md',
  ]);

  stepGrow(view, start + 3000);
  assert.equal(isGrowActive(view), false);
  for (const [id, x, y] of [
    ['h1.md', 500, 270],
    ['h2.md', 550, 280],
    ['h3.md', 600, 290],
  ]) {
    const hidden = view.nodeById.get(id);
    assert.deepEqual([hidden.x, hidden.y], [x, y]);
  }
});

test('Grow can be stopped, restarted, undone mid-run, and cleared by loading a layout', async (t) => {
  const { element } = require('./helpers/obsidian.cjs');
  const { view, app, putLayout } = fixture(t, { settings: { grow_duration: 4 } });
  const created = { 'a.md': 100, 'b.md': 200, 'c.md': 300 };
  view.nodes = [
    { id: 'a.md', x: 300, y: 100, vx: 0, vy: 0, meta: {} },
    { id: 'b.md', x: 400, y: 100, vx: 0, vy: 0, meta: {} },
    { id: 'c.md', x: 500, y: 100, vx: 0, vy: 0, meta: {} },
  ];
  view.nodeById = new Map(view.nodes.map((node) => [node.id, node]));
  view.neighborsById = new Map(view.nodes.map((node) => [node.id, new Set()]));
  app.vault.getAbstractFileByPath = (path) =>
    created[path] ? { path, stat: { ctime: created[path] } } : null;
  view.growButtonEl = element();
  view.historyButtons = [element(), element()];
  view.syncGrowButton();
  view.syncHistoryButtons();
  assert.equal(view.growButtonEl.text, 'Grow');
  assert.equal(view.historyButtons[0].disabled, true);

  const before = view.nodes.map((node) => [node.id, node.x, node.y]);
  assert.equal(startGrow(view), true);
  assert.equal(view.growButtonEl.text, 'Stop');
  assert.equal(view.historyButtons[0].disabled, false);

  // Stop mid-run -> all nodes reappear and Grow can be restarted right away.
  assert.equal(stopGrow(view), true);
  assert.equal(isGrowActive(view), false);
  assert.equal(view.growButtonEl.text, 'Grow');
  assert.equal(view.getFilterVisibleNodeIds(), null);
  assert.equal(view.replayHistory(false), 'applied');
  assert.deepEqual(
    view.nodes.map((node) => [node.id, node.x, node.y]),
    before
  );

  // Undo while Grow is still active stops Grow and restores pre-Grow coordinates in one step.
  assert.equal(startGrow(view), true);
  stepGrow(view, view.growEffect.startMs + 2000);
  assert.equal(isGrowActive(view), true);
  assert.equal(view.replayHistory(false), 'applied');
  assert.equal(isGrowActive(view), false);
  assert.equal(view.growButtonEl.text, 'Grow');
  assert.deepEqual(
    view.nodes.map((node) => [node.id, node.x, node.y]),
    before
  );

  // Loading a saved layout cancels active Grow cleanly.
  putLayout({ saved_positions: {} });
  assert.equal(startGrow(view), true);
  assert.equal(isGrowActive(view), true);
  await view.loadSavedLayout({ silent: true });
  assert.equal(isGrowActive(view), false);
  assert.equal(view.growButtonEl.text, 'Grow');
});
