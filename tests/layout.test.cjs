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
  const original = structuredClone(plugin.data);
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
  const before = structuredClone(plugin.data);
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
  const before = structuredClone(plugin.data);
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
    const before = structuredClone(plugin.data);
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
  for (let i = 0; i < 12; i += 1) frames.shift()();
  assert.equal(view.layoutPaused, true);
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
    const data = structuredClone(plugin.data);
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

test('passive refresh preserves an already-running layout, while deliberate settings still kick', (t) => {
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
  assert.equal(view.layoutPaused, false);
  assert.equal(view.layoutAutosaveDirty, true);
  assert.equal(view.layoutStillFrames, 0);
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
