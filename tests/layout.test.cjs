const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture, deferred, element, notices, loadSource } = require('./helpers/obsidian.cjs');

function holdWrite(t, adapter) {
  const entered = deferred();
  const release = deferred();
  const original = adapter.write.bind(adapter);
  t.mock.method(adapter, 'write', async (...args) => {
    entered.resolve();
    await release.promise;
    return original(...args);
  });
  return { entered: entered.promise, release: release.resolve };
}

function settingsPanelFixture(t, data = {}) {
  const f = fixture(t, data);
  const { view } = f;
  view.sidePanelEl = element();
  view.sidePanelOpen = true;
  const builders = {};
  for (const method of [
    'buildFindSection',
    'buildGroupEditorSection',
    'buildQueryRuleEditorSection',
    'addLayoutFileSearchRow',
    'addSideSaveLayoutButton',
    'buildAttachmentFileTypesControl',
  ]) {
    builders[method] = t.mock.method(view, method, (parent) => parent.createDiv({ text: method }));
  }
  view.buildSidePanel = Object.getPrototypeOf(view).buildSidePanel;
  view.buildSidePanel();
  return { ...f, builders };
}

test('sidebar order is Search, Settings tabs, Layout and each existing builder is reused once', (t) => {
  const { view, builders } = settingsPanelFixture(t, {
    settings: { hide_attachments: false },
    view_state: {
      side_panel_sections: { display: false, groups: false, physics: false, selection: false },
    },
  });
  const sections = view.sidePanelEl.children[1].children;
  assert.deepEqual(
    sections.map((section) => section.children[0].text),
    ['Search', 'Settings', 'Layout']
  );
  const tabs = [...view.settingsTabs];
  assert.deepEqual(
    tabs.map(([id]) => id),
    ['groups', 'display', 'physics', 'selection']
  );
  const settings = sections[1].children[1];
  assert.equal(settings.children[0].attributes.role, 'tablist');
  assert.deepEqual(
    settings.children.slice(1),
    tabs.map(([, { panel }]) => panel)
  );
  const groups = view.settingsTabs.get('groups').panel;
  const display = view.settingsTabs.get('display').panel;
  assert.equal(builders.buildGroupEditorSection.mock.calls[0].arguments[0], groups);
  assert.equal(builders.buildGroupEditorSection.mock.callCount(), 1);
  assert.deepEqual(
    builders.buildQueryRuleEditorSection.mock.calls.map((call) => [
      call.arguments[0],
      call.arguments[1].key,
    ]),
    [
      [groups, 'blacklist'],
      [groups, 'whitelist'],
    ]
  );
  assert.equal(builders.buildFindSection.mock.calls[0].arguments[0], sections[0].children[1]);
  assert.equal(
    builders.addSideSaveLayoutButton.mock.calls[0].arguments[0],
    sections[2].children[1]
  );
  const descendants = (node) => [node, ...node.children.flatMap(descendants)];
  const controls = descendants(display);
  for (const key of [
    'dim_low_degree_nodes',
    'show_arrows',
    'reverse_arrows',
    'custom_background',
    'background_color',
    'grid_color',
    'grid_opacity',
    'grid_line_width',
    'hide_attachments',
    'include_unlinked_attachments',
  ])
    assert(controls.includes(view.sideControls.get(key).input), `${key} stays in Display`);
  assert(
    descendants(view.settingsTabs.get('physics').panel).includes(
      view.sideControls.get('repel_strength').input
    )
  );
  assert(
    descendants(view.settingsTabs.get('selection').panel).includes(
      view.sideControls.get('selection_box_modifier').input
    )
  );
  view.selectSettingsTab('display');
  assert.equal(display.hidden, false, 'legacy collapsed Display does not hide tab content');
});

test('Settings tabs are accessible, compact, persist through rebuild and never wake or dirty physics', (t) => {
  const { view, plugin } = settingsPanelFixture(t);
  const persist = t.mock.method(plugin, 'schedulePersist', () => {});
  t.mock.method(view, 'kickLayoutSearch', () => assert.fail('No physics kick for tabs'));
  view.layoutPaused = true;
  view.layoutAutosaveDirty = false;
  const groups = view.settingsTabs.get('groups');
  assert.equal(groups.button.attributes['aria-selected'], 'true');
  assert.equal(groups.button.attributes.role, 'tab');
  assert.equal(groups.panel.attributes.role, 'tabpanel');
  assert.equal(groups.button.attributes['aria-controls'], groups.panel.id);
  assert.equal(groups.panel.attributes['aria-labelledby'], groups.button.id);
  const key = (key) => ({ key, preventDefault() {}, stopPropagation() {} });
  groups.button.events.keydown(key('ArrowRight'));
  assert.equal(plugin.getSettingsTab(), 'display');
  assert.equal(view.settingsTabs.get('display').button.focused, true);
  assert.equal(groups.button.tabIndex, -1);
  assert.equal(groups.panel.hidden, true);
  assert.equal(persist.mock.callCount(), 1);
  view.settingsTabs.get('display').button.events.keydown(key('End'));
  assert.equal(plugin.getSettingsTab(), 'selection');
  view.settingsTabs.get('selection').button.events.keydown(key('ArrowRight'));
  assert.equal(plugin.getSettingsTab(), 'groups');
  view.settingsTabs.get('groups').button.events.keydown(key('ArrowLeft'));
  assert.equal(plugin.getSettingsTab(), 'selection');
  view.settingsTabs.get('selection').button.events.keydown(key('Home'));
  assert.equal(plugin.getSettingsTab(), 'groups');
  view.settingsTabs.get('physics').button.events.click();
  const calls = persist.mock.callCount();
  view.selectSettingsTab('physics');
  view.selectSettingsTab('not-a-tab');
  assert.equal(persist.mock.callCount(), calls);
  view.buildSidePanel();
  assert.equal(view.settingsTabs.get('physics').panel.hidden, false);
  assert.equal(view.layoutPaused, true);
  assert.equal(view.layoutAutosaveDirty, false);
  const css = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../src/static/styles.css'),
    'utf8'
  );
  assert.match(
    css,
    /\.graphfrontier-settings-tabs\s*\{[^}]*grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)/
  );
  assert.match(css, /\.graphfrontier-settings-panel\[hidden\]\s*\{\s*display:\s*none/);
});

test('Settings tab is a preference, excluded from snapshots/files and preserved by bootstrap and layout activation', async (t) => {
  const { view, plugin, putLayout, writes, flushTimers, preferences } = settingsPanelFixture(t, {
    view_state: { settings_tab: 'physics' },
  });
  assert.equal(plugin.getSettingsTab(), 'physics');
  assert.equal('settings_tab' in view.captureLayoutSnapshot('data.json').view_state, false);
  await view.saveCurrentLayout({ silent: true });
  assert.equal('settings_tab' in JSON.parse(writes.at(-1).contents).view_state, false);
  assert.equal(plugin.getSettingsTab(), 'physics');
  putLayout({ view_state: { settings_tab: 'selection' } }, 'other.json');
  await view.loadSavedLayout({ layoutFileName: 'other.json', silent: true });
  assert.equal(plugin.getSettingsTab(), 'physics', 'layout tab cannot overwrite preference');
  assert.equal(view.settingsTabs.get('physics').panel.hidden, false);
  view.selectSettingsTab('display');
  await plugin.persistPluginDataOnly();
  assert.equal(preferences.at(-1).view_state.settings_tab, 'display');
  await plugin.bootstrapActiveLayoutData();
  assert.equal(plugin.getSettingsTab(), 'display');
  view.buildSidePanel();
  assert.equal(view.settingsTabs.get('display').panel.hidden, false);
  assert.equal(
    plugin.normalizeData({ view_state: { settings_tab: 'invalid' } }).view_state.settings_tab,
    'groups'
  );
  flushTimers();
});

function asymmetricStar(t, settle = true) {
  const f = fixture(t);
  let seed = 3;
  const random = () => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const ids = ['hub.md', ...Array.from({ length: 6 }, (_, i) => `neighbor-${i}.md`)];
  f.graph.nodes = ids.map((id) => ({ id, label: id }));
  f.graph.edges = ids.slice(1).map((target) => ({ source: ids[0], target }));
  f.plugin.data.saved_positions = Object.fromEntries(
    ids.map((id, i) => {
      const angle = (i * Math.PI) / 3 + (random() - 0.5) * 0.8;
      const radius = 25 + random() * 180;
      return [id, { x: 33 + radius * Math.cos(angle), y: -17 + radius * Math.sin(angle) }];
    })
  );
  f.view.nodeById = new Map();
  f.view.refreshFromVault({ keepCamera: true, forceSavedPositions: true });
  if (settle) {
    for (let i = 0; i < 5000 && !f.view.layoutPaused; i++) f.view.stepSimulation();
    assert.equal(f.view.layoutPaused, true, 'asymmetric six-neighbor star settles');
  }
  return f;
}

function positions(view) {
  return view.nodes.map(({ id, x, y }) => ({ id, x, y }));
}

function frameLoop(view) {
  const frames = [];
  view.contentEl.win.requestAnimationFrame = (callback) => {
    frames.push(callback);
    return frames.length;
  };
  view.runFrame = loadSource('view.js').GraphFrontierView.prototype.runFrame;
  return frames;
}

for (const [cost, expected] of [
  [0, 3],
  [2.5, 3],
  [3, 2],
  [8, 1],
  [10, 1],
]) {
  test(`frame batches ${expected} steps with ${cost}ms steps and renders/smooths once`, (t) => {
    const { view } = fixture(t);
    const frames = frameLoop(view);
    let now = 0;
    t.mock.method(performance, 'now', () => now);
    const step = t.mock.method(view, 'stepSimulation', () => {
      now += cost;
    });
    const camera = t.mock.method(view, 'stepCameraSmoothing', () => {});
    const focus = t.mock.method(view, 'stepFocusSmoothing', () => {});
    const render = t.mock.method(view, 'render', () => {});
    view.runFrame();
    assert.equal(step.mock.callCount(), expected);
    assert.equal(camera.mock.callCount(), 1);
    assert.equal(focus.mock.callCount(), 1);
    assert.equal(render.mock.callCount(), 1);
    assert.equal(frames.length, 1);
    assert.equal(view.layoutAutosaveBatch, null);
  });
}

for (const drag of ['node', 'selection']) {
  test(`${drag} drag allows only one physics step per frame`, (t) => {
    const { view } = fixture(t);
    frameLoop(view);
    t.mock.method(performance, 'now', () => 0);
    if (drag === 'node') view.dragNodeId = 'alpha.md';
    else view.dragSelectionOffsets = new Map([['alpha.md', { x: 0, y: 0 }]]);
    const step = t.mock.method(view, 'stepSimulation', () => {});
    view.runFrame();
    assert.equal(step.mock.callCount(), 1);
  });
}

test('batch stops as soon as physics pauses and does not repeat paused steps next frame', (t) => {
  const { view } = fixture(t);
  frameLoop(view);
  t.mock.method(performance, 'now', () => 0);
  let calls = 0;
  t.mock.method(view, 'stepSimulation', () => {
    if (++calls === 2) view.layoutPaused = true;
  });
  view.runFrame();
  assert.equal(calls, 2);
  view.runFrame();
  assert.equal(calls, 2);
});

for (const guard of ['closed', 'metadata', 'backups']) {
  test(`frame ${guard} guard prevents all physics/autosave work`, (t) => {
    const { view, plugin } = fixture(t, { settings: { layout_autosave: true } });
    const frames = frameLoop(view);
    view.layoutAutosaveDirty = true;
    view.layoutStillFrames = 5;
    if (guard === 'closed') view.isOpen = false;
    if (guard === 'metadata') view.waitingForMetadata = true;
    if (guard === 'backups') plugin.backups = { restoring: true };
    const step = t.mock.method(view, 'stepSimulation', () =>
      assert.fail('No physics through guard')
    );
    const render = t.mock.method(view, 'render', () => {});
    view.runFrame();
    assert.equal(step.mock.callCount(), 0);
    assert.equal(view.layoutStillFrames, 5);
    assert.equal(render.mock.callCount(), guard === 'closed' ? 0 : 1);
    assert.equal(frames.length, 0, 'guards wait for an event, not perpetual frames');
  });
}

test('a guard activated inside a batch stops further steps and its autosave flush', (t) => {
  const { view, plugin } = fixture(t, { settings: { layout_autosave: true } });
  frameLoop(view);
  t.mock.method(performance, 'now', () => 0);
  view.layoutAutosaveDirty = true;
  view.layoutStillFrames = 5;
  const step = t.mock.method(view, 'stepSimulation', () => {
    plugin.backups = { restoring: true };
  });
  view.runFrame();
  assert.equal(step.mock.callCount(), 1);
  assert.equal(view.layoutStillFrames, 5);
  assert.equal(view.layoutAutosaveBatch, null);
});

test('physics steps stay single-step and three-step frames have identical per-node trajectories', (t) => {
  const batched = asymmetricStar(t, false);
  const snapshot = batched.view.captureLayoutSnapshot('data.json');
  const single = fixture(t, snapshot);
  single.graph.nodes = batched.graph.nodes.map((node) => ({ ...node }));
  single.graph.edges = batched.graph.edges.map((edge) => ({ ...edge }));
  single.view.nodeById = new Map();
  single.view.refreshFromVault({ keepCamera: true, forceSavedPositions: true });
  batched.view.stepSimulation();
  single.view.stepSimulation();
  const state = (view) => view.nodes.map(({ id, x, y, vx, vy }) => ({ id, x, y, vx, vy }));
  assert.deepEqual(state(batched.view), state(single.view), 'public API remains a single step');
  frameLoop(batched.view);
  t.mock.method(performance, 'now', () => 0);
  for (let frame = 0; frame < 300; frame++) {
    for (let i = 0; i < 3 && !single.view.layoutPaused; i++) single.view.stepSimulation();
    batched.view.runFrame();
    assert.deepEqual(state(batched.view), state(single.view), `frame=${frame}`);
    assert.equal(batched.view.layoutPaused, single.view.layoutPaused);
  }
});

test('a frame containing any moving substep resets idle debounce instead of counting later quiet substeps', (t) => {
  const { view, writes } = fixture(t, { settings: { layout_autosave: true } });
  const { stepLayoutAutosave } = loadSource('physics.js');
  frameLoop(view);
  t.mock.method(performance, 'now', () => 0);
  view.layoutAutosaveDirty = true;
  view.layoutStillFrames = 5;
  let calls = 0;
  t.mock.method(view, 'stepSimulation', () => stepLayoutAutosave(view, calls++ === 0));
  view.runFrame();
  assert.equal(calls, 3);
  assert.equal(view.layoutStillFrames, 0);
  view.runFrame();
  assert.equal(view.layoutStillFrames, 1, 'quiet batch counts as one idle animation frame');
  assert.equal(writes.length, 0);
});

for (const mode of ['settling', 'paused', 'empty']) {
  test(`${mode} frame autosave still requires eight idle animation frames and writes only once`, async (t) => {
    const { view, plugin, graph, writes } = fixture(t, {
      settings: {
        layout_autosave: true,
        repel_strength: 0,
        center_strength: 0,
        base_link_strength: 0,
      },
      saved_positions: { 'alpha.md': { x: 0, y: 0 } },
    });
    if (mode === 'empty') graph.nodes = [];
    view.refreshFromVault({ keepCamera: true, forceSavedPositions: true });
    if (mode === 'paused') view.layoutPaused = true;
    view.layoutAutosaveDirty = true;
    frameLoop(view);
    t.mock.method(performance, 'now', () => 0);
    const step = t.mock.method(view, 'stepSimulation');
    const save = t.mock.method(view, 'saveCurrentLayout');
    for (let frame = 1; frame <= 7; frame++) {
      view.runFrame();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(view.layoutStillFrames, frame);
      assert.equal(writes.length, 0);
    }
    if (mode !== 'settling') assert.equal(step.mock.callCount(), 0);
    else
      assert.equal(step.mock.callCount(), 8, 'stop exactly when the eighth physical step pauses');
    view.runFrame();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(writes.length, 1);
    assert.equal(save.mock.callCount(), 1);
    assert.equal(view.layoutAutosaveDirty, false);
    assert.equal(view.layoutStillFrames, 0);
    if (mode === 'settling') assert(plugin.data.saved_layout_sleep['']);
    for (let frame = 0; frame < 10; frame++) view.runFrame();
    assert.equal(save.mock.callCount(), 1);
  });
}

test('proven settled sleep round-trips and survives topology-neutral passive refreshes', async (t) => {
  const { view, plugin, writes, putLayout } = asymmetricStar(t);
  const settled = positions(view);
  assert.equal(await view.saveCurrentLayout({ silent: true }), true);
  const saved = JSON.parse(writes.at(-1).contents);
  assert.equal(saved.saved_layout_sleep[''].nodes.length, 7);
  assert.deepEqual(plugin.normalizeData(saved).saved_layout_sleep, saved.saved_layout_sleep);
  await view.onOpen();
  assert.deepEqual(positions(view), settled);
  for (let i = 0; i < 600; i++) view.stepSimulation();
  assert.deepEqual(positions(view), settled);
  view.refreshFromVault({ keepCamera: true, passive: true, metadataResolved: true });
  view.layoutPaused = false;
  view.stepSimulation();
  assert.deepEqual(positions(view), settled, 'unchanged rebuild preserves WeakMap sleep');

  // With momentum-conserving forces the settled star is a true equilibrium, so a fresh
  // resume need not move it on its first step: check that physics resumes and settles.
  delete saved.saved_layout_sleep;
  putLayout(saved);
  await view.onOpen();
  assert.equal(view.layoutPaused, false, 'legacy layout without sleep data resumes physics');
  for (let i = 0; i < 5000 && !view.layoutPaused; i++) view.stepSimulation();
  assert.equal(view.layoutPaused, true, 'legacy layout remains compatible and settles normally');
});

test('first real autosave after settling includes sleep before fresh resume', async (t) => {
  const { view, plugin, writes } = asymmetricStar(t, false);
  plugin.data.settings.layout_autosave = true;
  for (let i = 0; i < 5000 && !view.layoutPaused; i++) view.stepSimulation();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes.length, 1);
  assert.equal(JSON.parse(writes[0].contents).saved_layout_sleep[''].nodes.length, 7);
  const settled = positions(view);
  await view.onOpen();
  for (let i = 0; i < 600; i++) view.stepSimulation();
  assert.deepEqual(positions(view), settled);
});

test('moving explicit snapshot is not marked sleeping even after save zeros velocities', async (t) => {
  const { view, writes } = asymmetricStar(t, false);
  view.stepSimulation();
  assert(view.nodes.some((node) => Math.hypot(node.vx, node.vy) > 0));
  assert.equal(await view.saveCurrentLayout({ silent: true }), true);
  assert(view.nodes.every((node) => node.vx === 0 && node.vy === 0));
  assert.deepEqual(JSON.parse(writes.at(-1).contents).saved_layout_sleep, {});
  const moving = positions(view);
  await view.onOpen();
  view.stepSimulation();
  assert.notDeepEqual(positions(view), moving);
});

test('partial metadata cannot simulate or autosave before complete startup links, then resumes sleep once', async (t) => {
  const { view, plugin, graph, app, writes } = asymmetricStar(t);
  await view.saveCurrentLayout({ silent: true });
  const settled = positions(view);
  const edges = graph.edges.slice();
  plugin.metadataResolvedOnce = false;
  app.workspace.layoutReady = false;
  graph.edges = edges.slice(0, 3);
  await view.onOpen();
  plugin.data.settings.layout_autosave = true;
  const writeCount = writes.length;
  assert.equal(view.waitingForMetadata, true);
  for (let i = 0; i < 120; i++) view.stepSimulation();
  view.refreshFromVault({ keepCamera: true, passive: true });
  assert.deepEqual(positions(view), settled);
  assert.equal(writes.length, writeCount);

  graph.edges = edges;
  plugin.metadataResolvedOnce = true;
  view.refreshFromVault({ keepCamera: true, metadataResolved: true, passive: true });
  assert.equal(view.waitingForMetadata, false);
  for (let i = 0; i < 600; i++) view.stepSimulation();
  assert.deepEqual(positions(view), settled);
  graph.edges.push({ source: 'neighbor-0.md', target: 'neighbor-3.md' });
  view.refreshFromVault({ keepCamera: true, metadataResolved: true, passive: true });
  assert.equal(view.layoutPaused, false);
  view.stepSimulation();
  assert.notDeepEqual(positions(view), settled, 'later genuine topology changes wake normally');
});

for (const change of ['forces', 'position', 'pin', 'multiplier', 'topology', 'filter']) {
  test(`saved sleep is rejected after changed ${change}`, async (t) => {
    const { view, graph, files, layoutPath, putLayout } = asymmetricStar(t);
    await view.saveCurrentLayout({ silent: true });
    const saved = JSON.parse(files.get(layoutPath()));
    if (change === 'forces') saved.settings.center_strength = 100;
    if (change === 'position') saved.saved_positions['hub.md'].x += 50;
    if (change === 'pin') saved.pins['hub.md'] = { x: 70, y: 80, mode: 'exact' };
    if (change === 'multiplier') saved.node_force_multipliers['hub.md'] = 10;
    if (change === 'topology') graph.edges.pop();
    if (change === 'filter') saved.view_state.node_filter = ['hub.md', 'neighbor-0.md'];
    putLayout(saved);
    await view.onOpen();
    const restored = positions(view);
    view.stepSimulation();
    assert.notDeepEqual(positions(view), restored);
  });
}

for (const action of ['drag', 'new node']) {
  test(`${action} wakes a resumed settled layout`, async (t) => {
    const { view, graph } = asymmetricStar(t);
    await view.saveCurrentLayout({ silent: true });
    await view.onOpen();
    view.stepSimulation();
    assert.equal(view.layoutPaused, true);
    if (action === 'drag') {
      view.nodeById.get('hub.md').x += 50;
      view.dragNodeId = 'hub.md';
      view.dragMovedDistance = 10;
      view.onMouseUp();
    } else {
      graph.nodes.push({ id: 'new.md', label: 'new' });
      view.refreshFromVault({ keepCamera: true, passive: true, metadataResolved: true });
    }
    assert.equal(view.layoutPaused, false);
    assert.equal(view.layoutAutosaveDirty, true);
  });
}

test('new graph waits for metadata then starts ordinary initial settling', async (t) => {
  const { view, plugin, app, putLayout } = fixture(t);
  plugin.metadataResolvedOnce = false;
  app.workspace.layoutReady = false;
  putLayout({ settings: { center_strength: 100 } });
  await view.onOpen();
  const initial = positions(view);
  view.stepSimulation();
  assert.deepEqual(positions(view), initial);
  plugin.metadataResolvedOnce = true;
  view.refreshFromVault({ keepCamera: true, passive: true, metadataResolved: true });
  view.stepSimulation();
  assert.notDeepEqual(positions(view), initial);
  assert.equal(view.layoutPaused, false);
});

test('metadata readiness handles linkless notes, absent maps and incomplete cached targets', (t) => {
  const { plugin, app } = fixture(t);
  plugin.metadataResolvedOnce = false;
  const files = [{ path: 'a.md' }, { path: 'b.md' }, { path: 'c.md' }];
  app.vault.getMarkdownFiles = () => files;
  app.metadataCache.getFileCache = () => ({});
  delete app.metadataCache.resolvedLinks;
  assert.equal(plugin.isGraphMetadataReady(), true, 'linkless notes need no own map keys');
  app.metadataCache.getFileCache = () => null;
  assert.equal(plugin.isGraphMetadataReady(), false);
  app.metadataCache.getFileCache = (file) =>
    file.path === 'a.md'
      ? {
          links: [{ link: 'b#heading' }],
          embeds: [{ link: 'b' }],
          frontmatterLinks: [{ link: 'c' }],
        }
      : {};
  app.metadataCache.getFirstLinkpathDest = (link) =>
    files.find((file) => file.path === `${link}.md`);
  app.metadataCache.resolvedLinks = { 'a.md': { 'b.md': 1 } };
  assert.equal(plugin.isGraphMetadataReady(), false, 'nonempty partial map is not ready');
  app.metadataCache.resolvedLinks['a.md'] = { 'b.md': 2, 'c.md': 1 };
  assert.equal(plugin.isGraphMetadataReady(), true);
  app.metadataCache.resolvedLinks['a.md'] = { 'b.md': 2, 'old.md': 1 };
  assert.equal(plugin.isGraphMetadataReady(), false, 'same count but stale target is not ready');
});

test('resolved during loadData is retained without an early refresh or lost timer', async (t) => {
  const { plugin, events, flushTimers } = fixture(t);
  const entered = deferred();
  const release = deferred();
  plugin.loadData = async () => {
    entered.resolve();
    await release.promise;
    return {};
  };
  const refresh = t.mock.method(plugin, 'refreshAllViews', () => assert(plugin._graphRefreshReady));
  const loading = plugin.onload();
  await entered.promise;
  events.resolved();
  flushTimers();
  assert.equal(refresh.mock.callCount(), 0);
  assert.equal(plugin._refreshTimer, null);
  release.resolve();
  await loading;
  flushTimers();
  assert.equal(refresh.mock.callCount(), 1);
  assert.equal(plugin.isGraphMetadataReady(), true);
});

test('sleep normalization accepts legacy absence and rejects malformed or unknown versions', (t) => {
  const { plugin } = fixture(t);
  for (const value of [
    undefined,
    null,
    [],
    { '': { version: 2, signature: 'old', nodes: [] } },
    { '': { version: 1, signature: 'bad', nodes: null } },
  ]) {
    assert.deepEqual(plugin.normalizeData({ saved_layout_sleep: value }).saved_layout_sleep, {});
  }
});

test('a debounced resolved refresh cannot release startup after a newer metadata change', async (t) => {
  const { view, plugin, app, putLayout } = fixture(t);
  app.workspace.layoutReady = false;
  putLayout({ saved_positions: { 'alpha.md': { x: 300, y: 200 } } });
  await view.onOpen();
  plugin.metadataResolvedOnce = true;
  plugin.metadataResolutionPending = true;
  view.refreshFromVault({ keepCamera: true, passive: true, metadataResolved: true });
  view.stepSimulation();
  assert.equal(view.waitingForMetadata, true);
  assert.equal(view.nodeById.get('alpha.md').x, 300);
  plugin.metadataResolutionPending = false;
  view.refreshFromVault({ keepCamera: true, passive: true, metadataResolved: true });
  assert.equal(view.waitingForMetadata, false);
});

test('attachment extensions filter linked and unlinked files exactly, without dangling edges', (t) => {
  const { plugin, app } = fixture(t);
  const files = ['alpha.md', 'photo.PNG', 'scan.png2', 'LICENSE', 'free.PDF', 'upper.MD'].map(
    (path) => ({
      path,
      basename: path,
      extension: path.includes('.') ? path.split('.').pop() : '',
    })
  );
  app.vault.getFiles = () => files;
  app.vault.getMarkdownFiles = () => [files[0], files[5]];
  app.vault.getAbstractFileByPath = (path) => files.find((file) => file.path === path);
  app.metadataCache.getFileCache = () => ({});
  app.metadataCache.resolvedLinks = {
    'alpha.md': { 'photo.PNG': 1, 'scan.png2': 1, LICENSE: 1, 'missing.PNG': 1 },
  };
  Object.assign(plugin.data.settings, {
    hide_attachments: false,
    hide_orphans: false,
    existing_files_only: false,
    excluded_attachment_extensions: ['PNG', '', 'md'],
  });
  const collect = () => Object.getPrototypeOf(plugin).collectGraphData.call(plugin);
  for (const unlinked of [false, true]) {
    plugin.data.settings.include_unlinked_attachments = unlinked;
    const graph = collect();
    assert.deepEqual(
      graph.nodes.map((n) => n.id).sort(),
      ['alpha.md', 'scan.png2', 'upper.MD', ...(unlinked ? ['free.PDF'] : [])].sort()
    );
    assert.deepEqual(graph.edges, [{ source: 'alpha.md', target: 'scan.png2' }]);
  }
  plugin.data.settings.excluded_attachment_extensions = [];
  assert(collect().nodes.some((n) => n.id === 'LICENSE' && n.meta.isAttachment));
  plugin.data.settings.hide_orphans = true;
  assert(!collect().nodes.some((n) => n.id === 'free.PDF'));
});

test('attachment exclusion arrays normalize safely and round-trip without dropping absent types', async (t) => {
  const { plugin, view, writes, putLayout } = fixture(t);
  for (const value of [null, {}, 'png', 1]) {
    assert.deepEqual(
      plugin.normalizeData({ settings: { excluded_attachment_extensions: value } }).settings
        .excluded_attachment_extensions,
      []
    );
  }
  const normalized = plugin.normalizeData({
    settings: {
      excluded_attachment_extensions: [' PNG ', 'png', '', null, 7, {}, 'missing'],
    },
  });
  assert.deepEqual(normalized.settings.excluded_attachment_extensions, ['png', '', 'missing']);
  plugin.data.settings.excluded_attachment_extensions =
    normalized.settings.excluded_attachment_extensions;
  assert.equal(await view.saveCurrentLayout(), true);
  const saved = JSON.parse(writes.at(-1).contents);
  assert.deepEqual(saved.settings.excluded_attachment_extensions, ['png', '', 'missing']);
  assert.deepEqual(saved.saved_layout_settings.excluded_attachment_extensions, [
    'png',
    '',
    'missing',
  ]);
  plugin.data.settings.excluded_attachment_extensions = [];
  assert.equal(await view.loadSavedLayout(), true);
  assert.deepEqual(plugin.data.settings.excluded_attachment_extensions, ['png', '', 'missing']);
  putLayout({ settings: {} });
  assert.equal(await view.loadSavedLayout(), true);
  assert.deepEqual(plugin.data.settings.excluded_attachment_extensions, []);
});

test('file type control searches cached inventory, refreshes on reopen and bulk actions target matches', (t) => {
  const { plugin, app, view } = fixture(t);
  let files = ['png', 'PNG', 'pdf', '', 'md', 'MD'].map((extension) => ({ extension }));
  const enumerate = t.mock.fn(() => files);
  app.vault.getFiles = enumerate;
  const win = {
    innerWidth: 1920,
    innerHeight: 1080,
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame() {},
  };
  const doc = { defaultView: win, addEventListener() {}, removeEventListener() {} };
  const decorate = (el) => {
    Object.assign(el, {
      ownerDocument: doc,
      style: {},
      isConnected: true,
      offsetHeight: 300,
      classList: { add() {}, remove() {} },
      scrollIntoView() {},
      appendChild(child) {
        child.parentElement = this;
        this.children.push(child);
      },
      remove() {
        this.isConnected = false;
      },
      getBoundingClientRect: () => ({ left: 1600, top: 200, bottom: 230, width: 250 }),
    });
    const create = el.createEl.bind(el);
    el.createEl = (tag, options) => decorate(create(tag, options));
    return el;
  };
  doc.body = decorate(element());
  doc.createElement = () => decorate(element());
  const parent = decorate(element());
  const refresh = t.mock.method(view, 'applyRefreshMode', () => {});
  const persist = t.mock.method(plugin, 'schedulePersist', () => {});
  plugin.data.settings.excluded_attachment_extensions = ['missing'];
  view.buildAttachmentFileTypesControl(parent);
  const trigger = parent.children[0].children[0].children[0];
  assert.equal(trigger.tag, 'input');
  assert.equal(enumerate.mock.callCount(), 1, 'initial summary uses current inventory');
  trigger.events.click();
  const search = trigger;
  const entries = () => view.inputSuggestMenu.selectableEntries;
  const formats = () => entries().filter((entry) => entry.checkbox);
  const select = (value) =>
    entries()
      .find((entry) => entry.suggestion.value === value)
      .itemEl.events.click({ preventDefault() {}, stopPropagation() {} });
  assert.equal(formats().length, 3);
  assert.deepEqual(
    formats().map((entry) => entry.suggestion.title),
    ['No extension', '.pdf', '.png']
  );
  assert.equal(formats()[2].suggestion.count, 2);
  assert(formats().every((entry) => entry.checkbox.checked));
  search.value = 'PnG';
  search.events.input();
  assert.equal(enumerate.mock.callCount(), 2);
  assert.equal(formats().length, 1);
  select('none');
  assert.deepEqual(plugin.data.settings.excluded_attachment_extensions, ['missing', 'png']);
  assert.equal(formats()[0].checkbox.checked, false);
  select('all');
  assert.deepEqual(plugin.data.settings.excluded_attachment_extensions, ['missing']);
  const checkbox = formats()[0].checkbox;
  checkbox.checked = false;
  checkbox.events.change();
  assert.deepEqual(plugin.data.settings.excluded_attachment_extensions, ['missing', 'png']);
  files = [{ extension: 'webp' }];
  view.closeInputSuggestMenu();
  assert.equal(trigger.value, 'File type: No extension, .pdf');
  trigger.events.click();
  assert.equal(trigger.value, 'File type: ');
  assert.equal(formats()[0].suggestion.title, '.webp');
  assert.equal(formats()[0].checkbox.checked, true);
  select('all');
  assert.deepEqual(plugin.data.settings.excluded_attachment_extensions, ['missing', 'png']);
  assert.equal(refresh.mock.callCount(), 4);
  assert.equal(persist.mock.callCount(), 4);
});

test('successful file write propagates true through persistActiveLayoutFile', async (t) => {
  const { plugin, writes } = fixture(t);
  assert.equal(await plugin.persistActiveLayoutFile(), true);
  assert.equal(writes.length, 1);
  assert.equal(JSON.parse(writes[0].contents).active_layout_name, 'data.json');
});

test('file write failure propagates false, retaining dirty state and old snapshots for retry', async (t) => {
  const { plugin, view, adapter, writes } = fixture(t, {
    saved_positions: { 'alpha.md': { x: 1, y: 2 }, hidden: { x: 7, y: 8 } },
    saved_layout_settings: { grid_step: 10 },
  });
  const original = JSON.parse(JSON.stringify(plugin.data));
  const write = t.mock.method(adapter, 'write', async () => {
    throw new Error('Read-only adapter');
  });
  assert.equal(await plugin.persistActiveLayoutFile(), false);
  assert.equal(await view.saveCurrentLayout(), false);
  assert.deepEqual(plugin.data, original);
  assert.equal(view.layoutAutosaveDirty, true);
  assert.equal(view.nodes[0].vx, 1);
  assert.equal(writes.length, 0);
  assert.match(notices.at(-1), /Failed to save/);
  assert.ok(!notices.some((message) => message.startsWith('Layout saved')));
  write.mock.restore();
  assert.equal(await view.saveCurrentLayout(), true);
  assert.equal(view.layoutAutosaveDirty, false);
  assert.deepEqual(plugin.data.saved_positions.hidden, { x: 7, y: 8 });
});

test('successful save commits only after write and stores a complete normalized snapshot', async (t) => {
  const { plugin, view, adapter, writes } = fixture(t, {
    pins: { anchor: { x: 0, y: 0, mode: 'grid' } },
    orbit_pins: { moon: { anchor_id: 'anchor', radius: 30, angle: 1 } },
    saved_positions: { hidden: { x: 77, y: 88 } },
    view_state: { side_panel_sections: { groups: true } },
    groups: [{ id: 'g', query: 'name:alpha', color: '#123456' }],
  });
  const before = JSON.parse(JSON.stringify(plugin.data));
  const gate = holdWrite(t, adapter);
  const saving = view.saveCurrentLayout();
  await gate.entered;
  assert.deepEqual(plugin.data, before);
  assert.equal(view.layoutAutosaveDirty, true);
  gate.release();
  assert.equal(await saving, true);
  const written = JSON.parse(writes[0].contents);
  for (const key of [
    'saved_positions',
    'saved_layout_settings',
    'saved_layout_pins',
    'saved_layout_orbit_pins',
  ]) {
    assert.deepEqual(plugin.data[key], written[key]);
  }
  assert.deepEqual(written.groups, plugin.data.groups);
  assert.deepEqual(written.view_state.side_panel_sections, {});
  assert.deepEqual(plugin.data.view_state.side_panel_sections, { groups: true });
  assert.equal(view.layoutAutosaveDirty, false);
  assert.equal(view.nodes[0].vx, 0);
});

test('edits during a save remain dirty; committed snapshots match disk, not newer edits', async (t) => {
  const { plugin, view, adapter, writes } = fixture(t);
  const gate = holdWrite(t, adapter);
  const saving = view.saveCurrentLayout();
  await gate.entered;
  view.nodes[0].x = 900;
  view.nodes[0].vx = 8;
  plugin.data.settings.grid_step = 35;
  plugin.data.groups.push({ id: 'g', query: 'name:new', color: '#ffffff', enabled: true });
  view.kickLayoutSearch();
  gate.release();
  assert.equal(await saving, true);
  const written = JSON.parse(writes[0].contents);
  assert.equal(written.saved_positions['alpha.md'].x, 25);
  assert.equal(plugin.data.saved_positions['alpha.md'].x, 25);
  assert.equal(view.nodes[0].x, 900);
  assert.equal(view.nodes[0].vx, 8);
  assert.equal(plugin.data.settings.grid_step, 35);
  assert.equal(plugin.data.saved_layout_settings.grid_step, written.settings.grid_step);
  assert.equal(plugin.data.groups.length, 1);
  assert.equal(view.layoutAutosaveDirty, true);
  assert.equal(await view.saveCurrentLayout({ silent: true }), true);
  assert.equal(plugin.data.saved_positions['alpha.md'].x, 900);
  assert.equal(view.layoutAutosaveDirty, false);
});

test('settings changed and reverted while writing still count as edits', async (t) => {
  const { plugin, view, adapter } = fixture(t);
  const gate = holdWrite(t, adapter);
  const saving = view.saveCurrentLayout();
  await gate.entered;
  const old = plugin.data.settings.show_grid;
  plugin.data.settings.show_grid = !old;
  plugin.schedulePersist();
  plugin.data.settings.show_grid = old;
  plugin.schedulePersist();
  gate.release();
  assert.equal(await saving, true);
  assert.equal(view.layoutAutosaveDirty, true);
});

test('overlapping saves serialize and the later snapshot includes newer coordinates', async (t) => {
  const { plugin, view, adapter, writes } = fixture(t);
  const gate = holdWrite(t, adapter);
  const first = view.saveCurrentLayout();
  await gate.entered;
  view.nodes[0].x = 600;
  const second = view.saveCurrentLayout();
  assert.equal(writes.length, 0);
  gate.release();
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(writes.length, 2);
  assert.equal(JSON.parse(writes[0].contents).saved_positions['alpha.md'].x, 25);
  assert.equal(JSON.parse(writes[1].contents).saved_positions['alpha.md'].x, 600);
  assert.equal(plugin.data.saved_positions['alpha.md'].x, 600);
  assert.equal(view.layoutAutosaveDirty, false);
});

test('switch waits for an older save and cannot receive its saved snapshots', async (t) => {
  const { plugin, view, adapter, putLayout, writes } = fixture(t);
  putLayout({ saved_positions: { 'alpha.md': { x: -70, y: -80 } }, groups: [] }, 'next.json');
  const gate = holdWrite(t, adapter);
  const saving = view.saveCurrentLayout();
  await gate.entered;
  const switching = view.selectActiveLayoutFileByName('next.json');
  assert.equal(plugin.getActiveLayoutFileName(), 'data.json');
  gate.release();
  assert.equal(await saving, true);
  assert.equal(await switching, true);
  assert.equal(plugin.getActiveLayoutFileName(), 'next.json');
  assert.equal(plugin.data.saved_positions['alpha.md'].x, -70);
  assert.equal(view.nodeById.get('alpha.md').x, -70);
  assert.ok(writes[0].name.endsWith('/data.json'));
});

test('save queued behind a layout switch is discarded rather than writing into the new layout', async (t) => {
  const { plugin, view, adapter, putLayout, writes } = fixture(t);
  putLayout({ saved_positions: { 'alpha.md': { x: -70, y: -80 } } }, 'next.json');
  const entered = deferred();
  const release = deferred();
  const original = adapter.read.bind(adapter);
  t.mock.method(adapter, 'read', async (name) => {
    entered.resolve();
    await release.promise;
    return original(name);
  });
  const switching = plugin.setActiveLayoutFile('next.json');
  await entered.promise;
  const saving = view.saveCurrentLayout();
  release.resolve();
  assert.equal(await switching, true);
  assert.equal(await saving, false);
  assert.equal(writes.length, 0);
  assert.equal(plugin.data.saved_positions['alpha.md'].x, -70);
});

test('older save never commits snapshots or dirty state into a replaced data object', async (t) => {
  const { plugin, view, adapter } = fixture(t);
  const gate = holdWrite(t, adapter);
  const saving = view.saveCurrentLayout();
  await gate.entered;
  plugin.data = plugin.normalizeData({
    active_layout_name: 'new.json',
    saved_positions: { other: { x: 5, y: 8 } },
  });
  view.layoutAutosaveDirty = true;
  gate.release();
  assert.equal(await saving, true);
  assert.equal(plugin.getActiveLayoutFileName(), 'new.json');
  assert.deepEqual(plugin.data.saved_positions, { other: { x: 5, y: 8 } });
  assert.equal(view.layoutAutosaveDirty, true);
});

test('save requested during switch preferences persistence cannot capture old view nodes for a new file', async (t) => {
  const { plugin, view, putLayout, writes } = fixture(t);
  putLayout({ saved_positions: { 'alpha.md': { x: -70, y: -80 } } }, 'next.json');
  const entered = deferred();
  const release = deferred();
  t.mock.method(plugin, 'saveData', async () => {
    entered.resolve();
    await release.promise;
  });
  const switching = view.selectActiveLayoutFileByName('next.json');
  await entered.promise;
  assert.equal(plugin.getActiveLayoutFileName(), 'data.json');
  const saving = view.saveCurrentLayout();
  release.resolve();
  assert.equal(await switching, true);
  assert.equal(await saving, false);
  assert.equal(writes.length, 0);
  assert.equal(plugin.data.saved_positions['alpha.md'].x, -70);
  assert.equal(view.nodeById.get('alpha.md').x, -70);
});

test('Save-As UI preserves active name on failure and changes it only after successful write', async (t) => {
  const { plugin, view, adapter, files, layoutPath } = fixture(t);
  const parent = element();
  view.addSideSaveLayoutButton(parent);
  const row = parent.children[0].children[0];
  const saveButton = row.children[1].children[0];
  assert.equal(saveButton.text, 'Save layout');
  view.layoutFileSearchInputValue = 'new layout';
  const write = t.mock.method(adapter, 'write', async () => {
    throw new Error('Disk full');
  });
  await saveButton.events.click();
  assert.equal(plugin.getActiveLayoutFileName(), 'data.json');
  assert.deepEqual(plugin.data.saved_positions, {});
  assert.equal(view.layoutAutosaveDirty, true);
  assert.equal(files.has(layoutPath('new layout.json')), false);
  write.mock.restore();
  const gate = holdWrite(t, adapter);
  const saving = saveButton.events.click();
  await gate.entered;
  assert.equal(plugin.getActiveLayoutFileName(), 'data.json');
  gate.release();
  await saving;
  assert.equal(plugin.getActiveLayoutFileName(), 'new layout.json');
  assert.equal(files.has(layoutPath('new layout.json')), true);
  assert.equal(view.layoutAutosaveDirty, false);
});

test('nonempty search still forbids save without mutating layout state', async (t) => {
  const { plugin, view, writes } = fixture(t);
  view.searchInputValue = 'alpha';
  view.layoutAutosaveDirty = true;
  const before = JSON.parse(JSON.stringify(plugin.data));
  assert.equal(await view.saveCurrentLayout({ layoutFileName: 'other.json' }), false);
  assert.deepEqual(plugin.data, before);
  assert.equal(writes.length, 0);
  assert.equal(view.layoutAutosaveDirty, true);
  assert.equal(notices.at(-1), 'Clear search field to save');
});

test('bootstrap creates a layout only when its absence is confirmed', async (t) => {
  const { plugin, writes } = fixture(t);
  assert.deepEqual(await plugin.readLayoutFileData('data.json'), { status: 'missing' });
  assert.equal(await plugin.bootstrapActiveLayoutData(), true);
  assert.equal(writes.length, 1);
});

for (const raw of ['{broken', '', 'null', '[]', 'false', '42']) {
  test(`bootstrap preserves an existing invalid layout: ${JSON.stringify(raw)}`, async (t) => {
    const { plugin, view, files, writes, layoutPath, preferences } = fixture(t);
    files.set(layoutPath(), raw);
    const before = JSON.parse(JSON.stringify(plugin.data));
    assert.equal((await plugin.readLayoutFileData('data.json')).status, 'error');
    assert.equal(await plugin.bootstrapActiveLayoutData(), false);
    assert.equal(files.get(layoutPath()), raw);
    assert.deepEqual(plugin.data, before);
    assert.equal(writes.length, 0);
    assert.equal(preferences.length, 0);
    assert.match(notices.at(-1), /Cannot read layout/);
    assert.equal(await view.saveCurrentLayout({ silent: true }), false);
    assert.equal(writes.length, 0);
  });
}

for (const failingMethod of ['read', 'exists']) {
  test(`bootstrap never creates over a ${failingMethod} error`, async (t) => {
    const { plugin, adapter, putLayout, writes } = fixture(t);
    putLayout({ settings: { grid_step: 45 } });
    t.mock.method(adapter, failingMethod, async () => {
      throw new Error('Access denied');
    });
    assert.equal(await plugin.bootstrapActiveLayoutData(), false);
    assert.equal(writes.length, 0);
  });
}

test('adapter without existence support may read but cannot infer absence from failure', async (t) => {
  const { plugin, adapter, putLayout, writes } = fixture(t);
  delete adapter.exists;
  assert.equal(await plugin.bootstrapActiveLayoutData(), false);
  assert.equal(writes.length, 0);
  putLayout({ settings: { grid_step: 45 } });
  assert.equal(await plugin.bootstrapActiveLayoutData(), true);
  assert.equal(plugin.data.settings.grid_step, 45);
});

test('bootstrap write failure reports failure without claiming creation', async (t) => {
  const { plugin, adapter, preferences } = fixture(t);
  t.mock.method(adapter, 'write', async () => {
    throw new Error('Disk full');
  });
  assert.equal(await plugin.bootstrapActiveLayoutData(), false);
  assert.equal(preferences.length, 0);
  assert.match(notices.at(-1), /Failed to create layout/);
});

test('Load reads full active file, including groups, rules and settings; side-panel state stays global', async (t) => {
  const { plugin, view, putLayout, reads } = fixture(t, {
    saved_positions: { 'alpha.md': { x: 1, y: 2 } },
    saved_layout_settings: { grid_step: 5 },
    groups: [{ id: 'old', query: 'name:old', color: '#000000' }],
    view_state: { side_panel_sections: { groups: false, display: true } },
  });
  const disk = {
    settings: { grid_step: 45, search_mode: 'filter' },
    saved_positions: { 'alpha.md': { x: 800, y: 900 } },
    groups: [{ id: 'disk', query: 'name:alpha', color: '#abcdef' }],
    blacklist: [{ id: 'b', query: 'name:exclude' }],
    whitelist: [{ id: 'w', query: 'name:alpha' }],
    pins: { anchor: { x: 4, y: 5, mode: 'grid' } },
    orbit_pins: { moon: { anchor_id: 'anchor', radius: 30, angle: 0 } },
    node_force_multipliers: { 'alpha.md': 3 },
    painted_edge_colors: { 'alpha.md': '#123456' },
    view_state: { side_panel_sections: { groups: true }, pan_x: 30 },
  };
  putLayout(disk);
  view.layoutAutosaveDirty = true;
  let rebuilt = 0;
  view.buildSidePanel = () => {
    rebuilt += 1;
  };
  assert.equal(await view.loadSavedLayout(), true);
  const expected = plugin.normalizeData(disk);
  expected.view_state.side_panel_sections = { groups: false, display: true };
  assert.deepEqual(plugin.data, expected);
  assert.equal(view.searchMode, 'filter');
  assert.deepEqual(view.sidePanelSectionState, expected.view_state.side_panel_sections);
  assert.equal(view.nodeById.get('alpha.md').x, 800);
  assert.equal(view.layoutAutosaveDirty, false);
  assert.equal(view.layoutPaused, true);
  assert.equal(reads.length, 1);
  assert.equal(rebuilt, 1);
});

test('failed reload retains current data and dirty state and never writes the file', async (t) => {
  const { plugin, view, files, layoutPath, writes } = fixture(t);
  files.set(layoutPath(), '{bad JSON');
  const data = plugin.data;
  view.layoutAutosaveDirty = true;
  assert.equal(await view.loadSavedLayout(), false);
  assert.equal(plugin.data, data);
  assert.equal(view.layoutAutosaveDirty, true);
  assert.equal(writes.length, 0);
  assert.match(notices.at(-1), /Cannot read layout/);
});

test('autosave-off close reloads all fields even without dirty and reopen uses disk positions', async (t) => {
  const { plugin, view, putLayout, preferences, flushTimers, writes } = fixture(t);
  const saved = plugin.normalizeData({ saved_positions: { 'alpha.md': { x: 15, y: 25 } } });
  putLayout(saved);
  plugin.data.groups = [{ id: 'g', query: 'name:unsaved', color: '#ffffff' }];
  plugin.data.blacklist = [{ id: 'b', query: 'name:unsaved' }];
  plugin.data.settings.show_grid = false;
  view.layoutAutosaveDirty = false;
  await view.onClose();
  flushTimers();
  assert.deepEqual(plugin.data, saved);
  assert.deepEqual(preferences.at(-1), saved);
  await view.onOpen();
  assert.deepEqual(plugin.data, saved);
  assert.equal(view.nodeById.get('alpha.md').x, 15);
  assert.equal(view.layoutPaused, false);
  assert.equal(view.layoutAutosaveDirty, true);
  assert.equal(writes.length, 0);
});

test('autosave-on close flushes dirty state before eight idle frames', async (t) => {
  const { plugin, view, writes } = fixture(t, { settings: { layout_autosave: true } });
  view.layoutAutosaveDirty = true;
  view.layoutPaused = true;
  view.stepSimulation();
  view.stepSimulation();
  assert.equal(view.layoutStillFrames, 2);
  assert.equal(writes.length, 0);
  await view.onClose();
  assert.equal(writes.length, 1);
  assert.equal(JSON.parse(writes[0].contents).saved_positions['alpha.md'].x, 25);
  assert.equal(plugin.data.saved_positions['alpha.md'].x, 25);
  assert.equal(view.layoutAutosaveDirty, false);
});

test('close flush queues behind an in-flight save and persists newer edits', async (t) => {
  const { plugin, view, adapter, writes } = fixture(t, { settings: { layout_autosave: true } });
  const gate = holdWrite(t, adapter);
  const saving = view.saveCurrentLayout({ silent: true });
  await gate.entered;
  view.nodes[0].x = 1000;
  const closing = view.onClose();
  gate.release();
  assert.equal(await saving, true);
  await closing;
  assert.equal(writes.length, 2);
  assert.equal(JSON.parse(writes[1].contents).saved_positions['alpha.md'].x, 1000);
  assert.equal(plugin.data.saved_positions['alpha.md'].x, 1000);
  assert.equal(view.layoutAutosaveDirty, false);
});

test('close-time write failure keeps dirty and old snapshots and surfaces a notice', async (t) => {
  const { plugin, view, adapter } = fixture(t, { settings: { layout_autosave: true } });
  view.layoutAutosaveDirty = true;
  t.mock.method(adapter, 'write', async () => {
    throw new Error('Disk full');
  });
  await view.onClose();
  assert.deepEqual(plugin.data.saved_positions, {});
  assert.equal(view.layoutAutosaveDirty, true);
  assert.match(notices.at(-1), /Failed to save layout on close/);
});

test('autosave-on close respects the nonempty-search restriction', async (t) => {
  const { view, writes } = fixture(t, { settings: { layout_autosave: true } });
  view.layoutAutosaveDirty = true;
  view.searchInputValue = 'alpha';
  await view.onClose();
  assert.equal(writes.length, 0);
  assert.equal(view.layoutAutosaveDirty, true);
});

test('onOpen synchronizes search mode from disk before building controls', async (t) => {
  const { view, putLayout } = fixture(t);
  assert.equal(view.searchMode, 'find');
  putLayout({ settings: { search_mode: 'filter' } });
  const modesAtBuild = [];
  view.buildSidePanel = () => modesAtBuild.push(view.searchMode);
  await view.onOpen();
  assert.deepEqual(modesAtBuild, ['filter']);
});

for (const [mode, query] of [
  ['find', ''],
  ['find', 'name:alpha'],
  ['filter', 'name:alpha'],
]) {
  test(`onOpen restores saved root positions and camera but starts physics (${mode}, ${query || 'no search'})`, async (t) => {
    const { view, putLayout, writes } = fixture(t);
    putLayout({
      saved_positions: { 'alpha.md': { x: 300, y: 200 } },
      settings: { center_strength: 100, layout_autosave: false, search_mode: mode },
      view_state: { camera_saved: true, pan_x: 40, pan_y: 50, zoom: 1.5, search_query: query },
    });
    const kick = t.mock.method(view, 'kickLayoutSearch');
    await view.onOpen();
    await view.setState({});
    const node = view.nodeById.get('alpha.md');
    assert.deepEqual({ x: node.x, y: node.y }, { x: 300, y: 200 });
    assert.deepEqual(view.camera, { x: 40, y: 50, zoom: 1.5 });
    assert.deepEqual(view.cameraTarget, view.camera);
    assert.equal(view.layoutPaused, false);
    const kicks = kick.mock.callCount();
    for (let i = 0; i < 5; i += 1) view.stepSimulation();
    assert.notEqual(node.x, 300);
    assert.notEqual(node.y, 200);
    assert.equal(kick.mock.callCount(), kicks);
    assert.equal(writes.length, 0);
  });
}

test('opening a saved root retains manual exact/grid pins and orbit geometry while free nodes move', async (t) => {
  const { plugin, view, graph, putLayout } = fixture(t);
  graph.nodes.push(...['grid.md', 'moon.md', 'free.md'].map((id) => ({ id, label: id })));
  const pins = {
    'alpha.md': { x: 20, y: 30, mode: 'exact' },
    'grid.md': { x: 100, y: 100, mode: 'grid' },
  };
  const orbit = { 'moon.md': { anchor_id: 'alpha.md', radius: 40, angle: 0 } };
  putLayout({
    pins,
    orbit_pins: orbit,
    saved_positions: { 'free.md': { x: 300, y: 200 } },
    settings: { center_strength: 100, layout_autosave: false },
  });
  await view.onOpen();
  for (let i = 0; i < 5; i += 1) view.stepSimulation();
  for (const [id, pin] of Object.entries(pins)) {
    const node = view.nodeById.get(id);
    assert.deepEqual({ x: node.x, y: node.y }, { x: pin.x, y: pin.y });
  }
  const moon = view.nodeById.get('moon.md');
  assert.deepEqual({ x: moon.x, y: moon.y }, { x: 60, y: 30 });
  assert.notEqual(view.nodeById.get('free.md').x, 300);
  assert.deepEqual(plugin.data.pins, pins);
  assert.deepEqual(plugin.data.orbit_pins, orbit);
});

test('entry starts once and the frame loop lets an equilibrium layout sleep normally', async (t) => {
  const { view, putLayout, writes } = fixture(t);
  putLayout({
    saved_positions: { 'alpha.md': { x: 0, y: 0 } },
    settings: { center_strength: 0, repel_strength: 0, layout_autosave: false },
  });
  const frames = [];
  view.contentEl.win.requestAnimationFrame = (callback) => frames.push(callback);
  view.runFrame = loadSource('view.js').GraphFrontierView.prototype.runFrame;
  const kick = t.mock.method(view, 'kickLayoutSearch');
  await view.onOpen();
  assert.equal(view.layoutPaused, false);
  for (let i = 0; i < 12 && frames.length; i += 1) frames.shift()();
  assert.equal(view.layoutPaused, true);
  assert.equal(frames.length, 0, 'settled graph stops scheduling frames');
  view.requestFrame();
  view.requestFrame();
  assert.equal(frames.length, 1, 'a real wake coalesces to one frame');
  frames.shift()();
  assert.equal(frames.length, 0, 'one settled redraw returns to idle');
  assert.equal(kick.mock.callCount(), 1);
  assert.equal(writes.length, 0);
});

for (const reason of ['read failure', 'another open root']) {
  test(`onOpen keeps the safety pause for ${reason}, including restored filter search`, async (t) => {
    const { plugin, view, app, files, layoutPath, writes } = fixture(t, {
      saved_positions: { 'alpha.md': { x: 300, y: 200 } },
      settings: { center_strength: 100, search_mode: 'filter' },
      view_state: { search_query: 'name:alpha' },
    });
    if (reason === 'read failure') files.set(layoutPath(), '{bad JSON');
    else {
      app.workspace.getLeavesOfType().push({ view: { isOpen: true } });
      t.mock.method(plugin, 'setActiveLayoutFile', () => assert.fail('No duplicate root reload'));
    }
    const data = JSON.parse(JSON.stringify(plugin.data));
    const expectedX = reason === 'read failure' ? view.nodeById.get('alpha.md').x : 300;
    await view.onOpen();
    for (let i = 0; i < 5; i += 1) view.stepSimulation();
    assert.equal(view.layoutPaused, true);
    assert.equal(view.layoutAutosaveDirty, false);
    assert.equal(view.nodeById.get('alpha.md').x, expectedX);
    assert.deepEqual(plugin.data, data);
    assert.equal(writes.length, 0);
  });
}

test('topology-neutral metadata/vault refresh preserves pause, coordinates and dirty state', async (t) => {
  const { plugin, view, putLayout, events, flushTimers } = fixture(t);
  putLayout({ saved_positions: { 'alpha.md': { x: 15, y: 25 }, hidden: { x: 70, y: 80 } } });
  await plugin.onload();
  await view.onOpen();
  await view.loadSavedLayout({ silent: true });
  assert.equal(view.layoutPaused, true);
  for (const dirty of [false, true]) {
    view.layoutAutosaveDirty = dirty;
    view.layoutStillFrames = 5;
    events.resolved();
    events.modify({ path: 'alpha.md' });
    flushTimers();
    assert.equal(view.layoutPaused, true);
    assert.equal(view.layoutAutosaveDirty, dirty);
    assert.equal(view.layoutStillFrames, 5);
    assert.equal(view.nodeById.get('alpha.md').x, 15);
    view.stepSimulation();
    assert.equal(view.nodeById.get('alpha.md').x, 15);
    assert.deepEqual(plugin.data.saved_positions.hidden, { x: 70, y: 80 });
  }
});

test('adding a node through a passive vault refresh wakes settled physics', async (t) => {
  const { plugin, view, putLayout, events, flushTimers, graph } = fixture(t);
  putLayout({ saved_positions: { 'alpha.md': { x: 15, y: 25 } } });
  await plugin.onload();
  await view.onOpen();
  await view.loadSavedLayout({ silent: true });
  assert.equal(view.layoutPaused, true);

  graph.nodes.push({ id: 'late.md', label: 'late' });
  plugin.data.saved_positions['late.md'] = { x: 600, y: 700 };
  events.create({ path: 'late.md' });
  flushTimers();
  assert.equal(view.nodeById.get('late.md').x, 600);
  assert.equal(view.layoutPaused, false);
  assert.equal(view.layoutAutosaveDirty, true);
  assert.equal(view.layoutStillFrames, 0);
});

test('adding an edge through a passive metadata refresh wakes settled physics', (t) => {
  const { view, graph } = fixture(t);
  graph.nodes.push({ id: 'beta.md', label: 'beta' });
  view.refreshFromVault({ keepCamera: true, skipLayoutKick: true });
  view.layoutAutosaveDirty = false;
  view.layoutStillFrames = 5;

  graph.edges.push({ source: 'alpha.md', target: 'beta.md' });
  view.refreshFromVault({ keepCamera: true, passive: true, metadataResolved: true });

  assert.equal(view.layoutPaused, false);
  assert.equal(view.layoutAutosaveDirty, true);
  assert.equal(view.layoutStillFrames, 0);
});

test('passive and topology-neutral data-filter refreshes preserve sleep and dirty state', (t) => {
  const { plugin, view } = fixture(t);
  view.layoutPaused = false;
  view.layoutAutosaveDirty = true;
  view.layoutStillFrames = 3;
  view.refreshFromVault({ passive: true, keepCamera: true });
  assert.equal(view.layoutPaused, false);
  assert.equal(view.layoutAutosaveDirty, true);
  assert.equal(view.layoutStillFrames, 3);
  view.layoutPaused = true;
  view.layoutAutosaveDirty = false;
  plugin.data.settings.hide_orphans = false;
  view.applyRefreshMode('data');
  assert.equal(view.layoutPaused, true);
  assert.equal(view.layoutAutosaveDirty, false);
  assert.equal(view.layoutStillFrames, 3);
});

test('visibility wake protects dirty state when an older layout save finishes', async (t) => {
  const { wakeOnPhysicsVisibilityChange, resetPhysicsVisibilityBaseline } =
    loadSource('physics.js');
  const { view, adapter } = fixture(t);
  resetPhysicsVisibilityBaseline(view);
  const gate = holdWrite(t, adapter);
  const saving = view.saveCurrentLayout({ silent: true });
  await gate.entered;
  const version = view.layoutEditVersion;
  view.apiVisibleNodeIds = new Set();
  view.markSearchVisibilityDirty();
  assert.equal(wakeOnPhysicsVisibilityChange(view), true);
  assert.equal(view.layoutEditVersion, version + 1);
  gate.release();
  await saving;
  assert.equal(
    view.layoutAutosaveDirty,
    true,
    'older completion cannot acknowledge visibility edit'
  );
});

test('exclude-all frame stops batching immediately and paused frames still tick autosave once', (t) => {
  const { resetPhysicsVisibilityBaseline } = loadSource('physics.js');
  const { view } = fixture(t, { settings: { hide_orphans: false, layout_autosave: true } });
  frameLoop(view);
  resetPhysicsVisibilityBaseline(view);
  view.apiVisibleNodeIds = new Set();
  view.markSearchVisibilityDirty();
  view.layoutPaused = true;
  const step = t.mock.method(view, 'stepSimulation');
  view.runFrame();
  assert.equal(step.mock.callCount(), 1);
  assert.equal(view.layoutPaused, true);
  assert.equal(view.layoutStillFrames, 1);
  view.runFrame();
  assert.equal(step.mock.callCount(), 1, 'paused empty subset does not simulate again');
  assert.equal(view.layoutStillFrames, 2);
});

test('physics setting slider still restarts a loaded layout', (t) => {
  const { view } = fixture(t);
  const parent = element();
  view.addSideSlider(parent, 'Repulsion', 'repel_strength', 0, 100, 1, 'render');
  const input = view.sideControls.get('repel_strength').input;
  view.layoutPaused = true;
  view.layoutAutosaveDirty = false;
  input.value = '65';
  input.events.input();
  assert.equal(view.layoutPaused, false);
  assert.equal(view.layoutAutosaveDirty, true);
});

test('stale hit-test buckets use current coordinates without rebuilding or altering rendering', (t) => {
  const { view } = fixture(t);
  const node = view.nodes[0];
  const index = view.getNodeSpatialIndex();
  const buildVersion = view.nodeSpatialIndexBuildVersion;
  node.x = 1200;
  node.y = -700;
  view.markNodeSpatialIndexDirty();
  t.mock.method(view, 'getNodeSpatialIndex', () => {
    throw new Error('No pointer-time rebuild');
  });
  t.mock.method(view, 'render', () => {
    throw new Error('No pointer-time render');
  });
  const point = view.worldToScreen(node.x, node.y);
  for (let i = 0; i < 20; i += 1) assert.equal(view.getNodeAtScreen(point.x, point.y), node);
  const old = view.worldToScreen(25, 40);
  assert.equal(view.getNodeAtScreen(old.x, old.y), null);
  assert.equal(view.nodeSpatialIndex, index);
  assert.equal(view.nodeSpatialIndexBuildVersion, buildVersion);
  view.getFilterVisibleNodeIds = () => new Set();
  assert.equal(view.getNodeAtScreen(point.x, point.y), null);
});

test('fresh indexed hit testing and stale scanning agree at non-default zoom', (t) => {
  const { view } = fixture(t);
  view.camera = { x: 150, y: -50, zoom: 0.3 };
  const node = view.nodes[0];
  const point = view.worldToScreen(node.x, node.y);
  view.getNodeSpatialIndex();
  assert.equal(view.getNodeAtScreen(point.x, point.y), node);
  view.markNodeSpatialIndexDirty();
  assert.equal(view.getNodeAtScreen(point.x, point.y), node);
});

test('real physics autosave consumes saveCurrentLayout boolean and retains dirty after disk failure', async (t) => {
  const { plugin, view, adapter } = fixture(t);
  plugin.data.settings.layout_autosave = true;
  view.layoutAutosaveDirty = true;
  view.layoutPaused = true;
  t.mock.method(adapter, 'write', async () => {
    throw new Error('Disk full');
  });
  const { stepSimulation } = loadSource('physics.js');
  for (let i = 0; i < 10; i += 1) stepSimulation(view);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(view.layoutAutosaveDirty, true);
  assert.deepEqual(plugin.data.saved_positions, {});
});

test('old attachment controls are dropped from settings, rollback and node overrides without changing layouts', async (t) => {
  const { plugin, view, putLayout, files, layoutPath } = fixture(t);
  const legacy = {
    attachment_size_multiplier: 0.8,
    attachment_link_distance_multiplier: 14,
    attachments_on_orbits: false,
  };
  const retained = {
    settings: {
      node_size_scale: 1.3,
      link_distance: 37,
      grid_line_width: 0.3,
      repel_strength: 200,
      repel_radius: 1000,
    },
    saved_layout_settings: {
      node_size_scale: 2,
      link_distance: 41,
      grid_step: 30,
      grid_line_width: 0.5,
    },
    pins: { 'alpha.md': { x: 25, y: 40, mode: 'grid' } },
    orbit_pins: { 'image.png': { anchor_id: 'alpha.md', radius: 71, angle: 1.2 } },
    saved_layout_pins: { 'alpha.md': { x: 25, y: 40, mode: 'exact' } },
    saved_layout_orbit_pins: { 'image.png': { anchor_id: 'alpha.md', radius: 71, angle: 1.2 } },
    saved_positions: { 'alpha.md': { x: 25, y: 40 }, 'image.png': { x: 100, y: -20 } },
    node_visual_settings: { 'alpha.md': { node_size_scale: 1.7, hover_dim_strength: 40 } },
    node_force_multipliers: { 'alpha.md': 3 },
    view_state: { camera_x: 12, camera_y: -15, camera_zoom: 2 },
  };
  const old = {
    ...retained,
    settings: { ...retained.settings, ...legacy },
    saved_layout_settings: { ...retained.saved_layout_settings, ...legacy },
    node_visual_settings: {
      'alpha.md': { ...retained.node_visual_settings['alpha.md'], attachment_size_multiplier: 0.8 },
      'image.png': { attachment_size_multiplier: 0.1 },
    },
  };
  const original = structuredClone(old);
  const expected = plugin.normalizeData(retained);
  assert.deepEqual(plugin.normalizeData(old), expected);
  assert.deepEqual(old, original, 'loading must not mutate the input layout');
  putLayout(old);
  assert.equal(await view.loadSavedLayout({ silent: true }), true);
  assert.deepEqual(plugin.data, expected);
  assert.equal(await view.saveCurrentLayout({ silent: true }), true);
  const written = JSON.parse(files.get(layoutPath()));
  for (const key of Object.keys(legacy)) {
    assert(!(key in written.settings));
    assert(!(key in written.saved_layout_settings));
  }
  assert.deepEqual(written.pins, expected.pins);
  assert.deepEqual(written.orbit_pins, expected.orbit_pins);
  assert.deepEqual(written.saved_positions, expected.saved_positions);
  assert.deepEqual(written.node_visual_settings, expected.node_visual_settings);
});

test('unlinked attachments require both flags and remain subject to orphan filtering', (t) => {
  const { plugin, app } = fixture(t);
  const files = [
    { path: 'alpha.md', basename: 'alpha', extension: 'md' },
    { path: 'upper.MD', basename: 'upper', extension: 'MD' },
    { path: 'linked.png', basename: 'linked', extension: 'png' },
    { path: 'assets/unused.PDF', basename: 'unused', extension: 'PDF' },
    { path: 'LICENSE', basename: 'LICENSE', extension: '' },
  ];
  app.vault.getMarkdownFiles = () => files.slice(0, 2);
  app.vault.getAbstractFileByPath = (path) => files.find((file) => file.path === path);
  const enumerate = t.mock.fn(() => files);
  app.vault.getFiles = enumerate;
  app.metadataCache.getFileCache = () => ({});
  app.metadataCache.resolvedLinks = { 'alpha.md': { 'linked.png': 1 } };
  const collect = () => Object.getPrototypeOf(plugin).collectGraphData.call(plugin);
  for (const hide_attachments of [true, false]) {
    for (const include_unlinked_attachments of [false, true]) {
      for (const hide_orphans of [true, false]) {
        Object.assign(plugin.data.settings, {
          hide_attachments,
          include_unlinked_attachments,
          hide_orphans,
        });
        const before = enumerate.mock.callCount();
        const graph = collect();
        const includeAll = !hide_attachments && include_unlinked_attachments;
        assert.equal(enumerate.mock.callCount() - before, Number(includeAll));
        const expected = hide_orphans ? [] : ['alpha.md', 'upper.MD'];
        if (!hide_attachments) {
          if (hide_orphans) expected.push('alpha.md');
          expected.push('linked.png');
          if (includeAll && !hide_orphans) expected.push('assets/unused.PDF', 'LICENSE');
        }
        assert.deepEqual(graph.nodes.map((node) => node.id).sort(), expected.sort());
        assert.deepEqual(
          graph.edges,
          hide_attachments ? [] : [{ source: 'alpha.md', target: 'linked.png' }]
        );
        for (const node of graph.nodes) {
          assert.equal(node.meta.isAttachment, !node.id.toLowerCase().endsWith('.md'));
        }
      }
    }
  }
});

test('include unlinked attachments defaults off, normalizes and round-trips per layout', async (t) => {
  const { plugin, view, writes, putLayout } = fixture(t);
  assert.equal(plugin.data.settings.include_unlinked_attachments, false);
  assert.equal(
    plugin.normalizeData({ settings: { include_unlinked_attachments: 1 } }).settings
      .include_unlinked_attachments,
    true
  );
  assert.equal(
    plugin.normalizeData({ settings: { include_unlinked_attachments: null } }).settings
      .include_unlinked_attachments,
    false
  );
  plugin.data.settings.include_unlinked_attachments = true;
  assert.equal(await view.saveCurrentLayout(), true);
  const saved = JSON.parse(writes.at(-1).contents);
  assert.equal(saved.settings.include_unlinked_attachments, true);
  assert.equal(saved.saved_layout_settings.include_unlinked_attachments, true);
  plugin.data.settings.include_unlinked_attachments = false;
  assert.equal(await view.loadSavedLayout(), true);
  assert.equal(plugin.data.settings.include_unlinked_attachments, true);
  putLayout({ settings: {} });
  assert.equal(await view.loadSavedLayout(), true);
  assert.equal(plugin.data.settings.include_unlinked_attachments, false);
});

test('unlinked attachment UI toggle follows Show attachments and uses normal data refresh', (t) => {
  const { plugin, view } = fixture(t);
  const fileTypes = t.mock.method(view, 'buildAttachmentFileTypesControl', () => {});
  view.sidePanelEl = element();
  view.sidePanelOpen = true;
  for (const method of [
    'buildFindSection',
    'addSideModifierSelect',
    'addSideSlider',
    'buildGroupEditorSection',
    'buildQueryRuleEditorSection',
    'addLayoutFileSearchRow',
    'addSideSaveLayoutButton',
    'syncSidePanelControls',
  ])
    t.mock.method(view, method, () => {});
  const toggles = [];
  const original = view.addSideToggle.bind(view);
  t.mock.method(view, 'addSideToggle', (...args) => {
    toggles.push(args);
    return original(...args);
  });
  const refresh = t.mock.method(view, 'applyRefreshMode', () => {});
  const persist = t.mock.method(plugin, 'schedulePersist', () => {});
  plugin.data.settings.hide_attachments = false;
  Object.getPrototypeOf(view).buildSidePanel.call(view);
  const index = toggles.findIndex((args) => args[2] === 'hide_attachments');
  assert.equal(toggles[index + 1][0], toggles[index][0]);
  assert.equal(toggles[index + 1][1], 'Show unlinked attachments');
  assert.equal(toggles[index + 1][2], 'include_unlinked_attachments');
  assert.equal(fileTypes.mock.callCount(), 1);
  view.sideControls.get('include_unlinked_attachments').input.events.click();
  assert.equal(plugin.data.settings.include_unlinked_attachments, true);
  assert.deepEqual(refresh.mock.calls[0].arguments, ['data']);
  assert.equal(persist.mock.callCount(), 1);
  assert.equal(toggles[index][4].rebuildPanelOnChange, true);
  plugin.data.settings.hide_attachments = true;
  toggles.length = 0;
  Object.getPrototypeOf(view).buildSidePanel.call(view);
  assert.equal(view.sideControls.has('include_unlinked_attachments'), false);
  assert.equal(fileTypes.mock.callCount(), 1, 'file types hidden with attachments off');
  assert.equal(
    toggles.some((args) => args[2] === 'include_unlinked_attachments'),
    false
  );
  assert.equal(
    plugin.data.settings.include_unlinked_attachments,
    true,
    'hiding preserves the setting'
  );
  plugin.data.settings.hide_attachments = false;
  Object.getPrototypeOf(view).buildSidePanel.call(view);
  assert.equal(view.sideControls.has('include_unlinked_attachments'), true);
  assert.equal(fileTypes.mock.callCount(), 2);
  assert.equal(view.reverseArrowsRowEl.style.display, 'none');
  assert.equal(view.backgroundColorRowEl.style.display, 'none');
  assert.equal(
    view.sideControls.has('strong_pull_multiplier'),
    false,
    'no global force slider in sidebar'
  );
  view.sideControls.get('show_arrows').input.events.click();
  Object.getPrototypeOf(view).syncSidePanelControls.call(view);
  assert.equal(view.reverseArrowsRowEl.style.display, '');
  view.sideControls.get('reverse_arrows').input.events.click();
  view.sideControls.get('show_arrows').input.events.click();
  Object.getPrototypeOf(view).syncSidePanelControls.call(view);
  assert.equal(view.reverseArrowsRowEl.style.display, 'none');
  assert.equal(plugin.getSettings().reverse_arrows, true, 'hiding retains reverse preference');
  view.sideControls.get('custom_background').input.events.click();
  Object.getPrototypeOf(view).syncSidePanelControls.call(view);
  assert.equal(view.backgroundColorRowEl.style.display, '');
  const background = view.sideControls.get('background_color').input;
  background.value = '#123456';
  background.events.input();
  view.sideControls.get('custom_background').input.events.click();
  Object.getPrototypeOf(view).syncSidePanelControls.call(view);
  assert.equal(view.backgroundColorRowEl.style.display, 'none');
  assert.equal(plugin.getSettings().background_color, '#123456');
});

test('excluded types remain excluded after disappearing and returning while new types are included', (t) => {
  const { plugin, app } = fixture(t);
  const note = { path: 'note.md', basename: 'note', extension: 'md' };
  const file = (path, extension) => ({ path, basename: path, extension });
  let attachments = [file('old.PNG', 'PNG'), file('LICENSE', '')];
  app.vault.getFiles = () => [note, ...attachments];
  app.vault.getMarkdownFiles = () => [note];
  app.vault.getAbstractFileByPath = (path) => [note, ...attachments].find((f) => f.path === path);
  app.metadataCache.getFileCache = () => ({});
  Object.assign(plugin.data.settings, {
    hide_attachments: false,
    include_unlinked_attachments: true,
    hide_orphans: false,
    excluded_attachment_extensions: ['png', ''],
  });
  const collect = () => Object.getPrototypeOf(plugin).collectGraphData.call(plugin);
  assert.deepEqual(
    collect().nodes.map((node) => node.id),
    ['note.md']
  );
  attachments = [file('new.PDF', 'PDF')];
  assert.deepEqual(
    collect()
      .nodes.map((node) => node.id)
      .sort(),
    ['new.PDF', 'note.md']
  );
  assert.deepEqual(plugin.data.settings.excluded_attachment_extensions, ['png', '']);
  attachments.push(file('returned.png', 'png'), file('README', ''));
  assert.deepEqual(
    collect()
      .nodes.map((node) => node.id)
      .sort(),
    ['new.PDF', 'note.md']
  );
});

test('reciprocal references retain actual source and one spring, including projection metadata', (t) => {
  const { plugin, app, view } = fixture(t, { settings: { hide_orphans: false } });
  const notes = ['a.md', 'b.md'].map((path) => ({ path, basename: path, extension: 'md' }));
  app.vault.getMarkdownFiles = () => notes;
  app.vault.getAbstractFileByPath = (path) => notes.find((note) => note.path === path);
  app.metadataCache.getFileCache = () => ({});
  app.metadataCache.resolvedLinks = { 'b.md': { 'a.md': 1 }, 'a.md': { 'b.md': 1 } };
  const graph = Object.getPrototypeOf(plugin).collectGraphData.call(plugin);
  assert.deepEqual(graph.edges, [{ source: 'b.md', target: 'a.md', bidirectional: true }]);
  plugin.collectGraphData = () => graph;
  view.refreshFromVault({ keepCamera: true });
  assert.equal(view.edges.length, 1);
  assert.equal(view.edges[0].bidirectional, true);
  assert(view.nodes.every((node) => node.degree === 1));
  const { projectSubgraphs } = loadSource('subgraphs.js');
  assert.equal(projectSubgraphs(graph, [], null).edges[0].bidirectional, true);
});

test('new visuals default safely, normalize and round-trip layouts without losing disabled background color', async (t) => {
  const { plugin, view, putLayout } = fixture(t);
  view.updateCanvasBackgroundColor = Object.getPrototypeOf(view).updateCanvasBackgroundColor;
  assert.equal(plugin.getSettings().dim_low_degree_nodes, false);
  assert.equal(plugin.getSettings().custom_background, false);
  assert.equal(plugin.getSettings().grid_opacity, null);
  const patch = {
    dim_low_degree_nodes: true,
    custom_background: false,
    background_color: '#abcdef',
    grid_color: '#123456',
    grid_opacity: 0,
    grid_line_width: 2,
    show_arrows: true,
    reverse_arrows: true,
    strong_pull_multiplier: 20,
  };
  Object.assign(plugin.data.settings, patch);
  plugin.setNodeVisualSetting('alpha.md', 'show_arrows', false);
  await view.saveCurrentLayout({ silent: true });
  Object.assign(plugin.data.settings, { background_color: null, show_arrows: false });
  await view.loadSavedLayout();
  for (const [key, value] of Object.entries(patch)) assert.equal(plugin.getSettings()[key], value);
  assert.equal(plugin.data.node_visual_settings['alpha.md'].show_arrows, false);
  view.updateCanvasBackgroundColor();
  assert.equal(view.canvasBackgroundColor, view.canvasTheme.background);
  plugin.data.settings.custom_background = true;
  view.updateCanvasBackgroundColor();
  assert.equal(view.canvasBackgroundColor, '#abcdef');
  plugin.data.settings.custom_background = false;
  view.updateCanvasBackgroundColor();
  assert.equal(plugin.data.settings.background_color, '#abcdef');
  putLayout({ settings: {} });
  await view.loadSavedLayout();
  assert.equal(plugin.getSettings().show_arrows, false);
  assert.equal(plugin.getSettings().reverse_arrows, false);
  assert.equal(plugin.getSettings().custom_background, false);
  assert.equal(plugin.getSettings().dim_low_degree_nodes, false);
  const invalid = plugin.normalizeData({
    settings: {
      grid_color: 'red',
      grid_opacity: 5,
      grid_line_width: 9,
      custom_background: 'true',
      strong_pull_multiplier: 99,
    },
  });
  assert.equal(invalid.settings.grid_color, null);
  assert.equal(invalid.settings.grid_opacity, 1);
  assert.equal(invalid.settings.grid_line_width, 2);
  assert.equal(invalid.settings.custom_background, false);
  assert.equal(invalid.settings.strong_pull_multiplier, 20);
});

test('two saved layouts restore independent attachment visibility and exclusions', async (t) => {
  const { plugin, view } = fixture(t);
  Object.assign(plugin.data.settings, {
    hide_attachments: false,
    include_unlinked_attachments: true,
    excluded_attachment_extensions: ['png', ''],
  });
  assert.equal(await view.saveCurrentLayout({ silent: true }), true);
  plugin.data.active_layout_name = 'other.json';
  Object.assign(plugin.data.settings, {
    hide_attachments: true,
    include_unlinked_attachments: false,
    excluded_attachment_extensions: ['pdf'],
  });
  assert.equal(await view.saveCurrentLayout({ silent: true }), true);
  for (const [name, hide, unlinked, excluded] of [
    ['data.json', false, true, ['png', '']],
    ['other.json', true, false, ['pdf']],
    ['data.json', false, true, ['png', '']],
  ]) {
    plugin.data.active_layout_name = name;
    assert.equal(await view.loadSavedLayout({ silent: true }), true);
    assert.equal(plugin.data.settings.hide_attachments, hide);
    assert.equal(plugin.data.settings.include_unlinked_attachments, unlinked);
    assert.deepEqual(plugin.data.settings.excluded_attachment_extensions, excluded);
  }
});
