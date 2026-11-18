const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, loadSource } = require('./helpers/obsidian.cjs');
const { mobileVault } = require('./helpers/mobile-vault.cjs');
const { buildViewerSource } = require('../scripts/viewer-build.cjs');
const { createApp } = require('../src/viewer/app.js');
const { renderMarkdown } = require('../src/viewer/markdown.js');

function exportedData(html) {
  return JSON.parse(
    html.match(/<script id="graphfrontier-data" type="application\/json">([\s\S]*?)<\/script>/)[1]
  );
}

test('the page script is the plugin itself with the browser Obsidian API, without Node or MCP', async () => {
  const source = await buildViewerSource();
  // The plugin's own modules are bundled, not copies of them.
  for (const module of ['main', 'view', 'physics', 'render', 'effects', 'node-visuals'])
    assert.ok(source.viewerScript.includes(`// src/${module}.js\n`), module);
  assert.match(source.viewerScript, /GraphFrontierView = class extends ItemView/);
  assert.doesNotMatch(source.viewerScript, /require\("node:http"\)|createServer/);
  assert.doesNotMatch(source.viewerScript, /McpServer|zod/);
  assert.match(source.viewerStyles, /#graphfrontier-root/);
  assert.match(source.viewerStyles, /\.graphfrontier-sidepanel/);
  assert.ok(source.cssVariables.includes('--background-primary'));
  assert.ok(source.iconCandidates.includes('undo-2'));
  assert.ok(source.iconCandidates.includes('eye-off'));
});

test('export writes the vault snapshot the plugin reads, with the layout as it is on screen', async (t) => {
  const { view, plugin, app } = fixture(t, { settings: { physics_steps_per_frame: 5 } });
  view.canvasEl = {};
  view.ctx = {};
  const { vault, contents, file } = mobileVault(t, false);
  Object.assign(app.vault, vault);
  file('alpha.md', '# Alpha\ntext');
  file('beta.md', 'beta');
  file('pic.png');
  app.metadataCache.getFileCache = (entry) =>
    entry.path === 'alpha.md'
      ? {
          tags: [{ tag: '#db', position: {} }],
          frontmatter: { status: 'on' },
          headings: [{ heading: 'Alpha', level: 1, position: {} }],
          links: [{ link: 'beta' }],
        }
      : null;
  app.metadataCache.resolvedLinks = { 'alpha.md': { 'beta.md': 1 } };
  app.metadataCache.unresolvedLinks = { 'alpha.md': { missing: 1 } };
  view.nodes[0].x = 123;
  view.nodes[0].y = -45;
  await view.commandExportStaticHtml({ exportPath: 'graph.html' });
  const html = contents.get('graph.html');
  assert.ok(html.startsWith('<!doctype html>'));
  assert.match(html, /--background-primary: #101010;/);
  const data = exportedData(html);
  assert.deepEqual(data.files.map((entry) => entry.path).sort(), [
    'alpha.md',
    'beta.md',
    'pic.png',
  ]);
  assert.deepEqual(data.caches['alpha.md'], {
    tags: [{ tag: '#db' }],
    frontmatter: { status: 'on' },
    headings: [{ heading: 'Alpha', level: 1 }],
  });
  assert.deepEqual(data.resolvedLinks, { 'alpha.md': { 'beta.md': 1 } });
  assert.deepEqual(data.unresolvedLinks, { 'alpha.md': { missing: 1 } });
  assert.equal(data.texts['alpha.md'], '# Alpha\ntext');
  assert.deepEqual(data.pluginData.saved_positions['alpha.md'], { x: 123, y: -45 });
  assert.equal(data.pluginData.settings.physics_steps_per_frame, 5);
  assert.equal(data.pluginData.active_layout_name, plugin.getActiveLayoutFileName());
  const layoutPath = plugin.getLayoutFileRelativePath(plugin.getActiveLayoutFileName());
  assert.deepEqual(JSON.parse(data.pluginFiles[layoutPath]), data.pluginData);
  assert.deepEqual(data.bodyClasses, ['theme-dark']);
  assert.equal(data.vaultName, 'Test vault');
});

test('an export of chosen nodes carries only their files, links and per-node data', async (t) => {
  const { view, plugin, app } = fixture(t);
  view.canvasEl = {};
  view.ctx = {};
  const { vault, contents, file } = mobileVault(t, false);
  Object.assign(app.vault, vault);
  for (const path of ['alpha.md', 'beta.md', 'gamma.md']) file(path, `text ${path}`);
  app.metadataCache.resolvedLinks = {
    'alpha.md': { 'beta.md': 1, 'gamma.md': 1 },
    'gamma.md': { 'alpha.md': 1 },
  };
  plugin.setPin('gamma.md', { x: 1, y: 2, mode: 'exact' });
  await view.commandExportStaticHtml({ exportPath: 'part.html', nodeIds: ['alpha.md', 'beta.md'] });
  const data = exportedData(contents.get('part.html'));
  assert.deepEqual(data.files.map((entry) => entry.path).sort(), ['alpha.md', 'beta.md']);
  assert.deepEqual(data.resolvedLinks, { 'alpha.md': { 'beta.md': 1 } });
  assert.equal(data.pluginData.pins['gamma.md'], undefined);
  assert.ok(!contents.get('part.html').includes('gamma.md'));
});

test('the page app serves the snapshot: files, metadata, links, note text and plugin files', async () => {
  const opened = [];
  const app = createApp(
    {
      vaultName: 'V',
      files: [{ path: 'a/b.md', ctime: 5, mtime: 6 }, { path: 'pic.png' }],
      caches: { 'a/b.md': { tags: [{ tag: '#x' }] } },
      texts: { 'a/b.md': '# B' },
      resolvedLinks: { 'a/b.md': { 'pic.png': 1 } },
      pluginFiles: { '.obsidian/plugins/graphfrontier/layouts/one.json': '{}' },
      pluginData: { settings: {} },
    },
    { openNote: (file) => opened.push(file.path) }
  );
  const note = app.vault.getAbstractFileByPath('a/b.md');
  assert.equal(note.basename, 'b');
  assert.equal(note.extension, 'md');
  assert.equal(note.stat.ctime, 5);
  assert.equal(note.parent.path, 'a');
  assert.deepEqual(
    app.vault.getMarkdownFiles().map((entry) => entry.path),
    ['a/b.md']
  );
  assert.equal(app.vault.getFiles().length, 2);
  assert.deepEqual(app.metadataCache.getFileCache(note), { tags: [{ tag: '#x' }] });
  assert.equal(await app.vault.cachedRead(note), '# B');
  assert.deepEqual(await app.vault.adapter.list('.obsidian/plugins/graphfrontier/layouts'), {
    files: ['.obsidian/plugins/graphfrontier/layouts/one.json'],
    folders: [],
  });
  await app.vault.adapter.write('.obsidian/plugins/graphfrontier/layouts/two.json', '{"a":1}');
  assert.equal(
    (await app.vault.adapter.list('.obsidian/plugins/graphfrontier/layouts')).files.length,
    2
  );
  await app.workspace.getLeaf(true).openFile(note);
  assert.deepEqual(opened, ['a/b.md']);
  assert.equal(app.viewRegistry.getTypeByExtension('md'), 'markdown');
  await assert.rejects(
    app.vault.process(note, () => ''),
    /cannot be changed/
  );
});

test('notes opened on the page render as Markdown with text kept literal', () => {
  const html = renderMarkdown('# Title\n\n- one\n- two\n\n`code` <b>x</b>\n\n```js\na < b\n```');
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<code>code<\/code> &lt;b&gt;x&lt;\/b&gt;/);
  assert.match(html, /<pre><code class="language-js">a &lt; b\n<\/code><\/pre>/);
});

test('without a built page script the export says so instead of writing a broken file', async (t) => {
  const source = loadSource('viewer-source.js');
  const previous = source.viewerScript;
  source.viewerScript = null;
  t.after(() => {
    source.viewerScript = previous;
  });
  const { view, app } = fixture(t);
  view.canvasEl = {};
  view.ctx = {};
  const { vault, contents } = mobileVault(t, false);
  Object.assign(app.vault, vault);
  await assert.rejects(
    view.commandExportStaticHtml({ exportPath: 'x.html' }, { throwOnError: true }),
    /no export page/
  );
  assert.equal(contents.size, 0);
});

test('the chosen parts travel with the page; Layouts brings every saved layout', async (t) => {
  const { view, plugin, app, adapter, files } = fixture(t);
  view.canvasEl = {};
  view.ctx = {};
  const { vault, contents } = mobileVault(t, false);
  Object.assign(app.vault, vault);
  const other = plugin.getLayoutFileRelativePath('other.json');
  files.set(other, '{"settings":{}}');
  adapter.list = async (folder) => ({
    files: [...files.keys()].filter((path) => path.startsWith(`${folder}/`)),
    folders: [],
  });
  await view.commandExportStaticHtml({
    exportPath: 'Exports/a.html',
    modules: { physics: true, settings: true, saves: true },
  });
  let data = exportedData(contents.get('Exports/a.html'));
  assert.deepEqual(data.exportOptions, {
    physics: true,
    settings: true,
    layouts: false,
    saves: true,
  });
  // Without Layouts only the layout on screen travels.
  assert.equal(data.pluginFiles[other], undefined);
  await view.commandExportStaticHtml({
    exportPath: 'b.html',
    modules: { settings: true, layouts: true },
  });
  data = exportedData(contents.get('b.html'));
  assert.equal(data.pluginFiles[other], '{"settings":{}}');
  assert.equal(data.exportOptions.saves, false);
  // Layouts and Saves belong to the settings menu: without it they are not included.
  await view.commandExportStaticHtml({
    exportPath: 'c.html',
    modules: { layouts: true, saves: true },
  });
  const options = exportedData(contents.get('c.html')).exportOptions;
  assert.deepEqual([options.layouts, options.saves], [false, false]);
});

test('a page with Layouts but without Saves only switches layouts', (t) => {
  const { view, plugin } = fixture(t);
  const { LayoutList } = loadSource('layout-list.js');
  const { element } = require('./helpers/obsidian.cjs');
  view.getLayoutDisplayName = (name) => name.replace(/\.json$/, '');
  plugin.exportPage = { settings: true, layouts: true, saves: false };
  const container = element();
  new LayoutList(view, container).renderRows(['one.json', 'two.json']);
  assert.equal(container.children.length, 2, 'no New layout row');
  assert.ok(container.children.every((row) => !row.children.some((el) => el.tag === 'button')));
  plugin.exportPage = { settings: true, layouts: true, saves: true };
  const editable = element();
  new LayoutList(view, editable).renderRows(['one.json']);
  assert.equal(editable.children.length, 2, 'New layout row with Saves');
});

test('a page without physics keeps the layout still; without settings it shows no menu', (t) => {
  const { view, plugin } = fixture(t);
  const { GraphFrontierView } = loadSource('view.js');
  const node = view.nodes[0];
  node.vx = 5;
  plugin.exportPage = { physics: false, settings: false };
  GraphFrontierView.prototype.stepSimulation.call(view);
  assert.deepEqual([node.x, node.y], [25, 40]);
  assert.equal(view.layoutPaused, true);
  const classes = new Map();
  view.sidePanelEl = {
    scrollTop: 0,
    empty() {},
    toggleClass: (name, value) => classes.set(name, value),
    createDiv: () => assert.fail('no menu is built'),
  };
  GraphFrontierView.prototype.buildSidePanel.call(view);
  assert.equal(classes.get('is-export-hidden'), true);
});

test('an exported page has Save layout but no Export to', (t) => {
  const { view, plugin } = fixture(t);
  const { GraphFrontierView } = loadSource('view.js');
  const { element } = require('./helpers/obsidian.cjs');
  const texts = (parent) => {
    const all = [];
    const walk = (el) => {
      if (el.text) all.push(el.text);
      for (const child of el.children || []) walk(child);
    };
    walk(parent);
    return all;
  };
  const inObsidian = element();
  GraphFrontierView.prototype.addSideSaveLayoutButton.call(view, inObsidian);
  assert.ok(texts(inObsidian).includes('Export to'));
  plugin.exportPage = { settings: true, saves: true };
  const onPage = element();
  GraphFrontierView.prototype.addSideSaveLayoutButton.call(view, onPage);
  assert.ok(texts(onPage).includes('Save layout'));
  assert.ok(!texts(onPage).includes('Export to'));
});

test('attachments clicked on the page say they cannot open in the browser', async () => {
  const obsidianShim = require('../src/viewer/obsidian.js');
  const shown = [];
  const original = obsidianShim.Notice.prototype.setMessage;
  obsidianShim.Notice.prototype.setMessage = function (message) {
    shown.push(message);
    return this;
  };
  const container = { createDiv: () => ({ addEventListener() {}, remove() {} }) };
  globalThis.document = { querySelector: () => container, body: container };
  try {
    const app = createApp({ files: [{ path: 'pic.png' }] });
    await app.openWithDefaultApp('pic.png');
  } finally {
    obsidianShim.Notice.prototype.setMessage = original;
    delete globalThis.document;
  }
  assert.deepEqual(shown, ['Attachments cannot be opened in the browser']);
});

test('a page saves into the file the user chose; without a click it asks for one first', async (t) => {
  const notices = [];
  const written = [];
  const saved = {};
  for (const [name, value] of Object.entries({
    navigator: { userActivation: { isActive: false } },
    window: {
      location: { pathname: '/site/My%20graph.html' },
      showSaveFilePicker: async (options) => {
        saved.options = options;
        return {
          name: 'My graph.html',
          createWritable: async () => ({
            write: async (text) => written.push(text),
            close: async () => {},
          }),
        };
      },
    },
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    t.after(() =>
      previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]
    );
  }
  const obsidianShim = require('../src/viewer/obsidian.js');
  t.mock.method(obsidianShim.Notice.prototype, 'setMessage', function (message) {
    notices.push(message);
    return this;
  });
  const { createFileSaver } = require('../src/viewer/file-save.js');
  const container = {
    createDiv: () => ({ setText() {}, empty() {}, addEventListener() {}, remove() {} }),
  };
  globalThis.document = { querySelector: () => container, body: container };
  t.after(() => delete globalThis.document);
  let html = 'v1';
  const saver = createFileSaver(() => html);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 200));
  saver.schedule();
  await settle();
  assert.deepEqual(written, []);
  assert.match(notices[0], /Click Save layout once/);
  navigator.userActivation.isActive = true;
  saver.schedule();
  await settle();
  assert.equal(saved.options.suggestedName, 'My graph.html');
  assert.deepEqual(written, ['v1']);
  navigator.userActivation.isActive = false;
  html = 'v2';
  saver.schedule();
  await settle();
  assert.deepEqual(written, ['v1', 'v2'], 'later saves need no click');
});

test('notes on the page render without their properties block', () => {
  assert.equal(renderMarkdown('---\ntags: [a]\n---\n# Note'), '<h1>Note</h1>');
  assert.equal(renderMarkdown('a\n\n___\n\nb'), '<p>a</p><hr><p>b</p>');
});

test('choosing a search option shows that option’s values, not the options again', async (t) => {
  const { view } = fixture(t);
  const { element } = require('./helpers/obsidian.cjs');
  const menus = [];
  view.showInputSuggestMenu = (input, items, onSelect, meta) =>
    menus.push({ input, items, onSelect, meta });
  view.getQueryTypeSuggestions = () => [{ value: 'tag:', kind: 'source' }];
  view.getSearchSuggestionPack = (text) => ({
    items: [{ value: `${text}db` }],
    menuTitle: 'Values',
  });
  view.contentEl.win.setTimeout = (callback) => callback();
  view.searchInputValue = 'name:';
  const parent = element();
  view.buildFindSection(parent);
  const input = view.searchInputEl;
  input.value = 'name:';
  input.selectionStart = 5;
  input.events.click();
  assert.equal(menus.at(-1).meta.title, 'Search options');
  menus.at(-1).onSelect('tag:', { kind: 'source' });
  assert.equal(input.value, 'tag:');
  assert.equal(menus.at(-1).meta.title, 'Values');
  assert.deepEqual(menus.at(-1).items, [{ value: 'tag:db' }]);
});
