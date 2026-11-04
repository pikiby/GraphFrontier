const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, loadSource, element } = require('./helpers/obsidian.cjs');
const { GraphFrontierView } = loadSource('view.js');
const { getPreparedAppearance } = loadSource('render.js');
const { resetPhysicsVisibilityBaseline } = loadSource('physics.js');
const proto = GraphFrontierView.prototype;
const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup(t, settings = {}) {
  const f = fixture(t, { settings });
  const frames = new Map(),
    timers = new Map(),
    rendered = [];
  let now = 0,
    sequence = 0;
  t.mock.method(Date, 'now', () => now);
  const v = f.view;
  v.contentEl.win.requestAnimationFrame = (callback) => {
    frames.set(++sequence, callback);
    return sequence;
  };
  v.contentEl.win.cancelAnimationFrame = (id) => frames.delete(id);
  v.contentEl.win.setTimeout = (callback, delay) => {
    timers.set(++sequence, { callback, at: now + delay });
    return sequence;
  };
  v.contentEl.win.clearTimeout = (id) => timers.delete(id);
  v.runFrame = proto.runFrame;
  v.render = () => rendered.push({ camera: { ...v.camera }, flash: v.clickFlashNodeId });
  v.nodes[0].x = 0;
  v.nodes[0].y = 0;
  v.nodes[0].vx = 0;
  v.nodes[0].vy = 0;
  v.layoutPaused = true;
  resetPhysicsVisibilityBaseline(v);
  const frame = () => {
    const [id, callback] = frames.entries().next().value || [];
    assert(callback, 'a frame is scheduled');
    frames.delete(id);
    now += 1000 / 60;
    callback(now);
  };
  const drain = () => {
    let count = 0;
    while (frames.size && count++ < 300) frame();
    assert(count < 300, 'animation reaches idle');
  };
  const advance = async (ms) => {
    const end = now + ms;
    for (let count = 0; count < 1000; count++) {
      const next = [...timers]
        .filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]);
      now = next[1].at;
      next[1].callback();
      await flush();
      if (count === 999) assert.fail('timer loop must be bounded');
    }
    now = end;
    await flush();
  };
  t.after(() => {
    v.isOpen = false;
    v.cancelScheduledWork();
  });
  return { ...f, frames, timers, rendered, frame, drain, advance };
}

test('settled frames stop completely and external requests coalesce without physics', (t) => {
  const f = setup(t);
  const step = t.mock.method(f.view, 'stepSimulation');
  for (let i = 0; i < 5; i++) f.view.requestFrame();
  assert.equal(f.frames.size, 1);
  f.drain();
  assert.equal(f.rendered.length, 1);
  assert.equal(f.frames.size, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(step.mock.callCount(), 0);
  f.view.requestFrame();
  f.drain();
  assert.equal(f.rendered.length, 2);
});

test('camera converges exactly before its final draw without cache scans or physics visibility checks', (t) => {
  const f = setup(t);
  f.view.requestFrame();
  f.drain();
  const appearance = getPreparedAppearance(f.view);
  const visibility = t.mock.method(f.view, 'getPhysicsVisibleNodeIds');
  t.mock.method(JSON, 'stringify', () => assert.fail('no per-frame JSON signatures'));
  f.view.render = () => {
    assert.equal(getPreparedAppearance(f.view), appearance);
    f.rendered.push({ camera: { ...f.view.camera } });
  };
  f.view.cameraTarget = { x: 25, y: -30, zoom: 2 };
  f.view.requestFrame();
  f.drain();
  assert.deepEqual(f.view.camera, f.view.cameraTarget);
  assert.deepEqual(f.rendered.at(-1).camera, f.view.cameraTarget);
  assert.equal(visibility.mock.callCount(), 0);
  assert.equal(f.view.layoutPaused, true);
  assert.equal(f.frames.size, 0);
});

test('manual physics kick wakes once, batches normally and stops at equilibrium', (t) => {
  const f = setup(t);
  let steps = 0;
  t.mock.method(performance, 'now', () => 0);
  f.view.stepSimulation = () => {
    if (++steps === 8) f.view.layoutPaused = true;
  };
  f.view.kickLayoutSearch();
  assert.equal(f.frames.size, 1);
  f.drain();
  assert.equal(steps, 8);
  assert.equal(f.rendered.length, 3);
  assert.equal(f.frames.size, 0);
});

test('raw settings/individual/group/rule writes wake sleeping view and invalidate only on events', (t) => {
  const f = setup(t);
  let cache = getPreparedAppearance(f.view);
  for (const mutate of [
    () => {
      f.plugin.data.settings.node_color = '#112233';
    },
    () => {
      f.plugin.data.node_visual_settings['alpha.md'] = { aura_radius: 100 };
    },
    () => {
      f.plugin.data.node_visual_settings['alpha.md'].aura_radius = 200;
    },
    () => {
      f.plugin.data.node_label_sizes['alpha.md'] = 18;
    },
    () => {
      f.plugin.data.painted_edge_colors['alpha.md'] = '#445566';
    },
    () => {
      delete f.plugin.data.node_visual_settings['alpha.md'].aura_radius;
    },
    () => {
      f.plugin.data.groups = [{ query: 'name:alpha', color: '#abcdef', settings: {} }];
    },
    () => {
      f.plugin.data.groups[0].settings.node_size_scale = 1.5;
    },
  ]) {
    mutate();
    assert.equal(f.frames.size, 1);
    const next = getPreparedAppearance(f.view);
    assert.notEqual(next, cache);
    cache = next;
    f.drain();
    assert.equal(f.frames.size, 0);
  }
  const before = f.view.getActiveQueryRuleSignature();
  f.plugin.data.blacklist.push({ query: 'name:nothing' });
  assert.equal(f.frames.size, 1);
  assert.notEqual(f.view.getActiveQueryRuleSignature(), before);
  f.drain();
  const stable = f.view.getActiveQueryRuleSignature();
  const groups = f.plugin.data.groups;
  // Instrument after warming the cache without creating a configuration change.
  Object.defineProperty(groups, 'filter', {
    configurable: true,
    value() {
      assert.fail('no group signature scan');
    },
  });
  try {
    assert.equal(f.view.getActiveQueryRuleSignature(), stable);
  } finally {
    delete groups.filter;
  }
});

test('focus, hover fade and flash render their final state then leave no frames', (t) => {
  const f = setup(t);
  f.view.hoverNodeId = 'alpha.md';
  f.view.requestFrame();
  f.drain();
  assert.equal(f.view.hoverFocusProgress, 1);
  f.view.hoverNodeId = null;
  f.view.requestFrame();
  f.drain();
  assert.equal(f.view.hoverFocusProgress, 0);
  assert.equal(f.view.hoverFadeProgress, 0);
  f.view.clickFlashNodeId = 'alpha.md';
  f.view.clickFlashUntilMs = Date.now() + 180;
  f.view.render = () => {
    if (Date.now() >= f.view.clickFlashUntilMs) f.view.clickFlashNodeId = null;
    f.rendered.push({ flash: f.view.clickFlashNodeId });
  };
  f.view.requestFrame();
  f.drain();
  assert.equal(f.rendered.at(-1).flash, null);
  assert.equal(f.frames.size, 0);
});

test('idle autosave counts eight quiet ticks with no perpetual RAF and retries by timer', async (t) => {
  const f = setup(t, { layout_autosave: true });
  let attempts = 0;
  f.view.saveCurrentLayout = async () => {
    if (++attempts === 1) throw Error('temporary storage failure');
    f.view.layoutAutosaveDirty = false;
    f.view.layoutStillFrames = 0;
    return true;
  };
  f.view.layoutAutosaveDirty = true;
  f.view.requestFrame();
  f.drain();
  assert.equal(f.view.layoutStillFrames, 1);
  assert.equal(f.frames.size, 0);
  await f.advance((6 * 1000) / 60 + 1);
  assert.equal(attempts, 0);
  await f.advance(1000 / 60);
  assert.equal(attempts, 1);
  assert.equal(f.view.layoutStillFrames, 8);
  assert.equal(f.frames.size, 0);
  await f.advance(990);
  assert.equal(attempts, 1);
  await f.advance(20);
  assert.equal(attempts, 2);
  assert.equal(f.timers.size, 0);
});

test('autosave enabling on an asleep dirty view saves without clicking canvas', async (t) => {
  const f = setup(t);
  let saved = 0;
  f.view.saveCurrentLayout = async () => {
    saved++;
    f.view.layoutAutosaveDirty = false;
    return true;
  };
  f.view.layoutAutosaveDirty = true;
  f.plugin.data.settings.layout_autosave = true;
  assert.equal(f.frames.size, 1);
  f.drain();
  await f.advance(150);
  assert.equal(saved, 1);
  assert.equal(f.frames.size, 0);
});

test('metadata/backup guards suspend simulation and quiet ticks, timer resumes after guard clears', async (t) => {
  for (const guard of ['metadata', 'backup']) {
    const f = setup(t, { layout_autosave: true });
    let saved = 0;
    f.view.layoutAutosaveDirty = true;
    if (guard === 'metadata') f.view.waitingForMetadata = true;
    else f.plugin.backups = { restoring: true };
    f.view.saveCurrentLayout = async () => {
      saved++;
      f.view.layoutAutosaveDirty = false;
      return true;
    };
    f.view.stepSimulation = () => assert.fail('guard prevents physics');
    f.view.requestFrame();
    f.drain();
    await f.advance(500);
    assert.equal(saved, 0);
    assert.equal(f.view.layoutStillFrames, 0);
    if (guard === 'metadata') f.view.waitingForMetadata = false;
    else f.plugin.backups.restoring = false;
    await f.advance(500);
    assert.equal(saved, 1);
    assert.equal(f.frames.size, 0);
    f.view.isOpen = false;
    f.view.cancelScheduledWork();
  }
});

test('visibility return, theme and active-pane events wake; close cancels all scheduled work', async (t) => {
  const f = setup(t, { layout_autosave: true });
  f.view.contentEl.ownerDocument = element();
  f.view.contentEl.ownerDocument.visibilityState = 'hidden';
  f.view.canvasEl = element();
  f.view.registerEvent = () => {};
  f.view.resizeCanvas = () => f.view.requestFrame();
  proto.bindEvents.call(f.view);
  f.view.requestFrame();
  assert.equal(f.frames.size, 0);
  f.view.contentEl.ownerDocument.visibilityState = 'visible';
  f.view.contentEl.ownerDocument.events.visibilitychange();
  assert.equal(f.frames.size, 1);
  f.drain();
  f.events['active-leaf-change']();
  assert.equal(f.frames.size, 1);
  f.drain();
  f.view.layoutAutosaveDirty = true;
  f.view.scheduleLayoutAutosave();
  assert.equal(f.timers.size, 1);
  f.view.loadSavedLayout = async () => true;
  f.view.saveCurrentLayout = async () => true;
  await f.view.onClose();
  assert.equal(f.frames.size, 0);
  assert.equal(f.timers.size, 0);
  f.view.requestFrame();
  assert.equal(f.frames.size, 0);
});

test('repeated branch replacements do not stack proxies and detached references never wake', async (t) => {
  const f = setup(t);
  f.plugin.setNodeVisualSetting('b', 'node_color', '#112233');
  for (let i = 0; i < 30; i++)
    f.plugin.setNodeVisualSetting('a', 'node_color', i % 2 ? '#445566' : '#778899');
  f.drain();
  let version = f.plugin.appearanceVersion;
  const lookups = t.mock.method(f.app.workspace, 'getLeavesOfType');
  f.plugin.data.node_visual_settings.b.node_color = '#abcdef';
  assert.equal(f.plugin.appearanceVersion - version, 1);
  assert.equal(lookups.mock.callCount(), 1);
  f.drain();
  const oldSettings = f.plugin.data.settings;
  const oldNode = f.plugin.data.node_visual_settings.b;
  f.plugin.data.settings = { ...oldSettings };
  f.plugin.data.node_visual_settings.b = { ...oldNode };
  f.drain();
  version = f.plugin.appearanceVersion;
  oldSettings.repel_strength = 99;
  oldNode.node_color = '#ffffff';
  assert.equal(f.plugin.appearanceVersion, version);
  assert.equal(f.frames.size, 0);
  assert.equal(f.view.layoutPaused, true);
  f.plugin.nodeListStore = { lists: [{ id: 'L', nodeIds: ['a'] }] };
  const oldLists = f.plugin.getNodeLists();
  f.plugin.nodeListStore.lists = [];
  await flush();
  f.drain();
  const listVersion = f.plugin.nodeListStore.appearanceVersion;
  oldLists[0].nodeIds.push('b');
  await flush();
  assert.equal(f.plugin.nodeListStore.appearanceVersion, listVersion);
  assert.equal(f.frames.size, 0);
});

test('settings and reordered groups refresh appearance without adding physics wakeups', (t) => {
  const f = setup(t);
  let steps = 0;
  f.view.stepSimulation = () => {
    steps++;
    f.view.layoutPaused = true;
  };
  const wake = (mutate) => {
    const before = getPreparedAppearance(f.view);
    mutate();
    assert.equal(f.view.layoutPaused, true);
    assert.equal(f.frames.size, 1);
    assert.notEqual(getPreparedAppearance(f.view), before);
    f.drain();
    assert.equal(steps, 0);
  };
  wake(() => {
    f.plugin.data.settings = { ...f.plugin.data.settings, repel_strength: 200 };
  });
  wake(() => {
    f.plugin.data.groups = [
      { query: 'name:nothing', settings: {} },
      { query: 'name:alpha', settings: { strong_pull: true, strong_pull_multiplier: 20 } },
    ];
  });
  const retained = f.plugin.data.groups[1];
  f.plugin.data.groups.shift();
  f.drain();
  wake(() => {
    retained.query = 'name:other';
  });
  wake(() => {
    retained.settings = { strong_pull: true, strong_pull_multiplier: 5 };
  });
  wake(() => {
    retained.settings.strong_pull_multiplier = 10;
  });
  const before = steps;
  f.plugin.data.groups = [{ ...f.plugin.data.groups[0], color: '#123456' }];
  f.drain();
  assert.equal(steps, before);
  f.plugin.data = f.plugin.normalizeData({ render_model: 2, settings: { repel_strength: 10 } });
  f.drain();
  assert.equal(steps, before);
  assert.equal(f.view.layoutPaused, true);
});

test('pointer pan, hover, wheel, touch and pinch request frames without invalidating appearance', (t) => {
  const f = setup(t);
  f.view.canvasEl = element();
  f.view.canvasEl.getBoundingClientRect = () => ({ left: 0, top: 0 });
  f.view.getNodeAtScreen = () => null;
  f.view.persistViewState = () => {};
  const cache = getPreparedAppearance(f.view);
  f.view.onMouseDown({ button: 0, clientX: 10, clientY: 10 });
  assert.equal(f.frames.size, 1);
  f.view.onMouseMove({ clientX: 40, clientY: 40 });
  assert.equal(f.frames.size, 1);
  assert.notEqual(f.view.cameraTarget.x, 0);
  f.view.onMouseUp({ button: 0 });
  f.drain();
  f.view.onWheel({ deltaY: -100, clientX: 40, clientY: 40, preventDefault() {} });
  assert.equal(f.frames.size, 1);
  f.drain();
  f.view.getNodeAtScreen = () => f.view.nodes[0];
  f.view.onMouseMove({ clientX: 40, clientY: 40 });
  f.drain();
  assert.equal(f.view.hoverFocusProgress, 1);
  const touch = (identifier, x) => ({ identifier, clientX: x, clientY: 30 });
  f.view.getNodeAtScreen = () => null;
  f.view.onTouchStart({ touches: [touch(1, 10), touch(2, 50)] });
  assert.equal(f.frames.size, 1);
  f.view.onTouchMove({ touches: [touch(1, 0), touch(2, 70)] });
  f.view.onTouchEnd({ touches: [] });
  f.drain();
  assert.equal(getPreparedAppearance(f.view), cache);
  assert.equal(f.view.layoutPaused, true);
});

test('flash expiry during drawing schedules a final clearing frame', (t) => {
  const f = setup(t);
  f.view.clickFlashNodeId = 'alpha.md';
  f.view.clickFlashUntilMs = 100;
  let draws = 0;
  f.view.render = () => {
    if (++draws === 1) t.mock.method(Date, 'now', () => 101);
    else f.view.clickFlashNodeId = null;
  };
  f.view.requestFrame();
  f.frame();
  assert.equal(f.frames.size, 1);
  f.frame();
  assert.equal(draws, 2);
  assert.equal(f.view.clickFlashNodeId, null);
  assert.equal(f.frames.size, 0);
});

test('hidden active physics is not mistaken for settled autosave time', async (t) => {
  const f = setup(t, { layout_autosave: true });
  f.view.contentEl.ownerDocument = element();
  f.view.contentEl.ownerDocument.visibilityState = 'hidden';
  f.view.layoutAutosaveDirty = true;
  f.view.layoutPaused = false;
  f.view.nodes[0].vx = 3;
  f.view.saveCurrentLayout = () => assert.fail('active hidden graph must not save as settled');
  f.view.runFrame();
  await f.advance(2000);
  assert.equal(f.timers.size, 0);
  assert.equal(f.frames.size, 0);
  assert.equal(f.view.layoutStillFrames, 0);
  assert.equal(f.view.nodes[0].vx, 3);
  assert.equal(f.view.layoutAutosaveDirty, true);
});
