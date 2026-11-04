const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { fixture, loadSource, notices } = require('./helpers/obsidian.cjs');
const { addNoteNavigationActions, getNoteTargets, openNoteTarget } =
  loadSource('note-navigation.js');
const { mobileVault } = require('./helpers/mobile-vault.cjs');

function menu() {
  return {
    items: [],
    addItem(build) {
      const item = {
        dom: {
          attributes: {},
          setAttribute(name, value) {
            this.attributes[name] = value;
          },
        },
        setSubmenu() {
          this.submenu = menu();
          return this.submenu;
        },
        setTitle(title) {
          this.title = title;
          return this;
        },
        setIcon(icon) {
          this.icon = icon;
          return this;
        },
        onClick(callback) {
          this.click = callback;
          return this;
        },
      };
      build(item);
      this.items.push(item);
    },
  };
}

test('YAML lists parse aliases, nested parentheses, spaces and native separators without rewriting targets', () => {
  assert.deepEqual(
    getNoteTargets('url', [
      ' https://example.com/reports?q=one#chart ',
      '[Dashboard](https://example.com/a_(b))',
      '[Two words](https://example.org/some path)',
    ]),
    [
      {
        target: 'https://example.com/reports?q=one#chart',
        label: 'example.com/reports?q=one#chart',
      },
      { target: 'https://example.com/a_(b)', label: 'Dashboard' },
      { target: 'https://example.org/some path', label: 'Two words' },
    ]
  );
  assert.deepEqual(
    getNoteTargets('path', [
      '[Project](/home/user/projects/example (copy))',
      '[Schema](Schemas/my schema (v2).sql)',
      'C:\\Projects\\My project\\schema.sql',
      '\\\\server\\share\\Project\\',
      '~/Some project/',
    ]),
    [
      { target: '/home/user/projects/example (copy)', label: 'Project' },
      { target: 'Schemas/my schema (v2).sql', label: 'Schema' },
      { target: 'C:\\Projects\\My project\\schema.sql', label: 'schema.sql' },
      { target: '\\\\server\\share\\Project\\', label: 'Project' },
      { target: '~/Some project/', label: 'Some project' },
    ]
  );
  assert.deepEqual(getNoteTargets('path', '[Schema](Schemas/schema.sql)'), [
    { target: 'Schemas/schema.sql', label: 'Schema' },
  ]);
});

test('arrays skip empty/nonstring entries and forbidden schemes including Markdown aliases', async () => {
  for (const type of ['url', 'path']) {
    assert.deepEqual(getNoteTargets(type, []), []);
    assert.deepEqual(getNoteTargets(type, [null, false, {}, [], 4, '', ' ', '[Empty]()']), []);
    const invalid = [
      'javascript:alert(1)',
      '[Click](javascript:alert(1))',
      '[Click](data:text/html,<script>alert(1)</script>)',
      '[Click](file:///tmp/example)',
      '[Click](obsidian://new?file=example)',
    ];
    assert.deepEqual(getNoteTargets(type, invalid), []);
  }
  assert.deepEqual(getNoteTargets('url', ['obsidian://open?file=Note']), []);
  assert.equal(
    getNoteTargets('path', ['obsidian://open?file=Note'])[0].target,
    'obsidian://open?file=Note'
  );
  const host = {
    get require() {
      return assert.fail('Unsafe paths must not reach Electron');
    },
  };
  for (const target of [
    'javascript:alert(1)',
    'data:text/plain,x',
    'https://example.com',
    'java\nscript:alert(1)',
  ])
    await assert.rejects(openNoteTarget({}, 'path', target, host), /local path/);
});

test('choice labels are plain text, bounded, and do not alter exact targets', () => {
  const target = `https://example.com/${'long'.repeat(30)}`;
  const entries = getNoteTargets('url', [
    target,
    '[<img src=x onerror=alert(1)>](https://example.org)',
    '[A\u202eB\nC](https://example.net)',
  ]);
  assert.equal(entries[0].label.length, 48);
  assert.ok(entries[0].label.endsWith('...'));
  assert.equal(entries[0].target, target);
  assert.equal(entries[1].label, '<img src=x onerror=alert(1)>');
  assert.equal(entries[2].label, 'A B C');
});

test('multiple destinations use hover submenus with tooltips and captured exact targets', async (t) => {
  const { app } = fixture(t);
  const opened = [];
  const targets = ['/tmp/Project (v2)', 'Schemas/schema with spaces.sql'];
  const frontmatter = {
    url: ['[Dashboard](https://example.com/a_(b))', 'https://example.org/report'],
    path: targets,
  };
  app.metadataCache.getFileCache = () => ({ frontmatter });
  app.vault.getAbstractFileByPath = (target) => ({ path: target, extension: 'sql' });
  app.workspace.getLeaf = () => ({ openFile: async (file) => opened.push(file.path) });
  const actions = menu();
  addNoteNavigationActions(actions, app, {}, { open: (url) => opened.push(url) });
  assert.deepEqual(opened, []);
  assert.deepEqual(
    actions.items[0].submenu.items.map((item) => item.title),
    ['Dashboard', 'example.org/report']
  );
  assert.deepEqual(
    actions.items[1].submenu.items.map((item) => item.title),
    ['Project (v2)', 'schema with spaces.sql']
  );
  assert.equal(actions.items[0].submenu.items[0].title, 'Dashboard');
  assert.equal(actions.items[0].submenu.items[0].dom.innerHTML, undefined);
  assert.equal(actions.items[1].submenu.items[1].title, 'schema with spaces.sql');
  assert.equal(
    actions.items[1].submenu.items[1].dom.attributes.title,
    'Schemas/schema with spaces.sql'
  );
  // Frontmatter changes after opening must not retarget an existing menu action.
  frontmatter.path[1] = '/different';
  assert.equal(actions.items[1].submenu.items[1].title, 'schema with spaces.sql');
  await actions.items[0].submenu.items[0].click();
  await actions.items[1].submenu.items[1].click();
  assert.deepEqual(opened, ['https://example.com/a_(b)', 'Schemas/schema with spaces.sql']);
});

test('one valid array entry keeps its alias in a submenu and no valid entries add no menu', async (t) => {
  const { app } = fixture(t);
  app.metadataCache.getFileCache = () => ({
    frontmatter: { url: [null, 'javascript:x', '[Only](https://example.com)'], path: [] },
  });
  const actions = menu();
  const opened = [];
  addNoteNavigationActions(actions, app, {}, { open: (url) => opened.push(url) });
  assert.equal(actions.items.length, 1);
  assert.equal(actions.items[0].title, 'Open URL');
  assert.equal(actions.items[0].click, undefined);
  assert.equal(actions.items[0].submenu.items.length, 1);
  assert.equal(actions.items[0].submenu.items[0].title, 'Only');
  assert.equal(actions.items[0].submenu.items[0].dom.attributes.title, 'https://example.com');
  assert.deepEqual(opened, []);
  await actions.items[0].submenu.items[0].click();
  assert.deepEqual(opened, ['https://example.com/']);
});

test('mobile navigation never uses Electron even when emulation exposes require', async (t) => {
  const { vault, file } = mobileVault(t);
  const opened = [];
  const app = {
    vault,
    workspace: { getLeaf: () => ({ openFile: async (f) => opened.push(f.path) }) },
  };
  const host = {
    get require() {
      return assert.fail('Mobile must not access Node/Electron');
    },
    open: (...args) => opened.push(args),
  };
  file('Note.md');
  await openNoteTarget(app, 'url', 'https://example.com', host);
  await openNoteTarget(app, 'path', 'obsidian://open?vault=Other', host);
  await openNoteTarget(app, 'path', 'Note.md', host);
  assert.deepEqual(opened, [
    ['https://example.com/', '_blank', 'noopener,noreferrer'],
    ['obsidian://open?vault=Other', '_blank', 'noopener,noreferrer'],
    'Note.md',
  ]);
  await assert.rejects(openNoteTarget(app, 'path', '/external/file', host), /On mobile/);
  await assert.rejects(openNoteTarget(app, 'url', 'javascript:alert(1)', host), /URL must use/);
});

test('mobile array aliases retain URL/Obsidian/vault routing and reject external files', async (t) => {
  const { vault, file } = mobileVault(t);
  file('Schemas/my schema (v2).sql');
  const opened = [];
  const app = {
    vault,
    workspace: { getLeaf: () => ({ openFile: async (f) => opened.push(f.path) }) },
    metadataCache: {
      getFileCache: () => ({
        frontmatter: {
          url: ['[Dashboard](https://example.com/report)', 'javascript:alert(1)'],
          path: [
            '[Schema](Schemas/my schema (v2).sql)',
            '[Other](obsidian://open?file=Other)',
            '[External](/tmp/Project)',
          ],
        },
      }),
    },
  };
  const actions = menu();
  addNoteNavigationActions(
    actions,
    app,
    {},
    {
      get require() {
        return assert.fail('No Node on mobile');
      },
      open: (target) => opened.push(target),
    }
  );
  await actions.items[0].submenu.items[0].click();
  for (const entry of actions.items[1].submenu.items) await entry.click();
  assert.deepEqual(opened, [
    'https://example.com/report',
    'Schemas/my schema (v2).sql',
    'obsidian://open?file=Other',
  ]);
  assert.match(notices.at(-1), /On mobile/);
});

test('menu reads current note YAML and provides only applicable quick-open actions', async (t) => {
  const { app } = fixture(t);
  const file = { path: 'note.md', extension: 'md' };
  let frontmatter = { url: 'https://example.com', path: 'target.md' };
  const opened = [];
  app.metadataCache.getFileCache = (received) => {
    assert.equal(received, file);
    return { frontmatter };
  };
  app.vault.getAbstractFileByPath = (target) => ({ path: target, extension: 'md' });
  app.workspace.getLeaf = () => ({ openFile: async (target) => opened.push(target.path) });
  const host = { require: () => ({ shell: { openExternal: async (url) => opened.push(url) } }) };
  const first = menu();
  addNoteNavigationActions(first, app, file, host);
  assert.deepEqual(
    first.items.map((item) => item.title),
    ['Open URL', 'Open path']
  );
  assert.equal(first.items[0].submenu.items[0].title, 'example.com/');
  assert.equal(first.items[1].submenu.items[0].title, 'target.md');
  await first.items[0].submenu.items[0].click();
  await first.items[1].submenu.items[0].click();
  assert.deepEqual(opened, ['https://example.com/', 'target.md']);
  frontmatter = { url: 'https://example.org', path: ' ' };
  const second = menu();
  addNoteNavigationActions(second, app, file, host);
  assert.equal(second.items.length, 1);
  await second.items[0].submenu.items[0].click();
  assert.equal(opened.at(-1), 'https://example.org/');
  for (frontmatter of [undefined, {}, { url: null, path: 4 }]) {
    const empty = menu();
    addNoteNavigationActions(empty, app, file, host);
    assert.equal(empty.items.length, 0);
  }
});

test('local files and folders use native paths on Linux, macOS and Windows', async () => {
  for (const [paths, base, expected] of [
    [path.posix, '/home/user/vault', '/home/user/vault/Project'],
    [path.posix, '/Users/user/vault', '/Users/user/vault/Project'],
    [path.win32, 'C:\\Vault', 'C:\\Vault\\Project'],
  ]) {
    const opened = [];
    const app = {
      vault: { getAbstractFileByPath: () => null, adapter: { getBasePath: () => base } },
    };
    const host = {
      require: (name) =>
        ({
          path: paths,
          get fs() {
            return assert.fail('Must not require fs');
          },
          electron: {
            shell: {
              openPath: async (target) => {
                opened.push(target);
                return '';
              },
            },
          },
        })[name],
    };
    await openNoteTarget(app, 'path', 'Project', host);
    assert.deepEqual(opened, [expected]);
  }
});

test('external absolute and home paths still open without fs', async () => {
  const opened = [];
  const app = { vault: { getAbstractFileByPath: () => null, adapter: {} } };
  const host = {
    require(name) {
      if (name === 'path') return path.posix;
      if (name === 'os') return { homedir: () => '/home/example' };
      assert.equal(name, 'electron');
      return {
        shell: {
          openPath: async (target) => {
            opened.push(target);
            return '';
          },
        },
      };
    },
  };
  await openNoteTarget(app, 'path', '~/Project', host);
  await openNoteTarget(app, 'path', '/external/Project', host);
  assert.deepEqual(opened, ['/home/example/Project', '/external/Project']);
  await assert.rejects(openNoteTarget(app, 'path', 'C:\\Project', host), /Windows path/);
});

test('Open path dispatches an Obsidian open URI without treating it as a local file', async (t) => {
  const { app } = fixture(t);
  const target = 'obsidian://open?vault=Clickhouse-analytics';
  app.metadataCache.getFileCache = () => ({ frontmatter: { path: target } });
  app.vault.getAbstractFileByPath = () => assert.fail('URI must not be resolved as a file');
  const opened = [];
  const host = {
    require(name) {
      assert.equal(name, 'electron');
      return { shell: { openExternal: async (uri) => opened.push(uri) } };
    },
  };
  const actions = menu();
  addNoteNavigationActions(actions, app, {}, host);
  assert.deepEqual(
    actions.items.map((item) => item.title),
    ['Open path']
  );
  await actions.items[0].submenu.items[0].click();
  assert.deepEqual(opened, [target]);
});

test('Obsidian URIs remain forbidden in url and non-open actions are rejected in path', async () => {
  const host = { require: () => assert.fail('No application should launch') };
  await assert.rejects(
    openNoteTarget({}, 'url', 'obsidian://open?vault=Clickhouse-analytics', host),
    /URL must use http:\/\/ or https:\/\//
  );
  for (const target of [
    'obsidian://new?vault=Other',
    'obsidian://open',
    'obsidian://open?',
    'obsidian://open/other?vault=Other',
    'obsidian://open.evil?vault=Other',
    'obsidian://[broken',
  ]) {
    await assert.rejects(openNoteTarget({}, 'path', target, host), /Obsidian/);
  }
});

test('Obsidian path URI preserves encoded values through the non-Electron fallback', async () => {
  const target = 'obsidian://open?vault=My%20vault&file=Folder%2FNote.md';
  const opened = [];
  await openNoteTarget({}, 'path', target, { open: (...args) => opened.push(args) });
  assert.deepEqual(opened, [[target, '_blank', 'noopener,noreferrer']]);
});

test('malformed URL is rejected and native path errors are reported without fs', async (t) => {
  const { app } = fixture(t);
  app.metadataCache.getFileCache = () => ({
    frontmatter: { url: 'javascript:alert(1)', path: '/missing' },
  });
  app.vault.getAbstractFileByPath = () => null;
  let opened = false;
  const host = {
    require: (name) =>
      ({
        path,
        get fs() {
          return assert.fail('Must not require fs');
        },
        electron: {
          shell: {
            openPath: async () => {
              opened = true;
              return 'File not found';
            },
            openExternal: async () => {
              opened = true;
            },
          },
        },
      })[name],
  };
  const actions = menu();
  addNoteNavigationActions(actions, app, {}, host);
  await actions.items[0].submenu.items[0].click();
  assert.match(notices.at(-1), /URL must use/);
  await actions.items[1].submenu.items[0].click();
  assert.match(notices.at(-1), /File not found/);
  assert.equal(opened, true);
});

// Model the native openFile contract verified in Obsidian 1.14.5 app.js:
// registered views use setViewState; other vault files use openWithDefaultApp.
function nativeFileLeaf(app, registry, opened) {
  return {
    async openFile(file) {
      const type = registry.get(file.extension);
      if (type) opened.push([type, file.path]);
      else app.openWithDefaultApp(file.path);
    },
  };
}

test('graph file clicks create native leaves only for registered internal views', async (t) => {
  const { app, view } = fixture(t);
  const opened = [];
  const external = [];
  const registry = new Map([
    ['md', 'markdown'],
    ['png', 'image'],
    ['pdf', 'pdf'],
    ['txt', 'plugin-text'],
    ['js', 'plugin-code'],
    ['custom', 'plugin-custom'],
  ]);
  app.viewRegistry = { getTypeByExtension: (extension) => registry.get(extension) };
  app.openWithDefaultApp = (path) => external.push(path);
  app.vault.getAbstractFileByPath = (path) => ({ path, extension: path.split('.').at(-1) });
  let leaves = 0;
  app.workspace.getLeaf = (newLeaf) => {
    assert.equal(newLeaf, true, 'preserve the graph tab');
    leaves++;
    return nativeFileLeaf(app, registry, opened);
  };
  view.leaf = { openFile: () => assert.fail('Must not replace graph tab') };
  for (const extension of [...registry.keys(), 'unsupported']) {
    await view.openNodeFile(`file.${extension}`);
  }
  assert.equal(leaves, 6);
  assert.deepEqual(
    opened,
    [...registry].map(([extension, type]) => [type, `file.${extension}`])
  );
  assert.deepEqual(external, ['file.unsupported']);
  registry.delete('txt');
  await view.openNodeFile('file.txt');
  assert.equal(leaves, 6, 'unregistered extensions must not create a blank leaf');
  assert.deepEqual(external, ['file.unsupported', 'file.txt'], 'respect plugin unregistration');
});

test('external graph files never create a leaf or change the active graph tab', async (t) => {
  const { app, view } = fixture(t);
  const graphLeaf = { view };
  app.workspace.activeLeaf = graphLeaf;
  app.viewRegistry = { getTypeByExtension: () => undefined };
  app.vault.getAbstractFileByPath = (path) => ({ path, extension: 'unsupported' });
  app.workspace.getLeaf = () => assert.fail('External opens must not create a leaf');
  app.workspace.setActiveLeaf = () => assert.fail('External opens must not move graph focus');
  const opened = [];
  app.openWithDefaultApp = async (path) => opened.push(path);
  await view.openNodeFile('file.unsupported');
  assert.deepEqual(opened, ['file.unsupported']);
  assert.equal(app.workspace.activeLeaf, graphLeaf);

  const start = notices.length;
  for (const asynchronous of [false, true]) {
    app.openWithDefaultApp = () => {
      opened.push('failed');
      if (asynchronous) return Promise.reject(new Error('External failed'));
      throw new Error('External failed');
    };
    await assert.doesNotReject(view.openNodeFile('file.unsupported'));
    assert.equal(app.workspace.activeLeaf, graphLeaf);
  }
  assert.equal(opened.length, 3, 'failed external opens are not retried');
  assert.deepEqual(notices.slice(start), [
    'Cannot open file: External failed',
    'Cannot open file: External failed',
  ]);
});

test('graph opening ignores missing files, directories and malformed file targets', async (t) => {
  const { app, view } = fixture(t);
  app.workspace.getLeaf = () => assert.fail('Must not create a leaf');
  app.openWithDefaultApp = () => assert.fail('Must not launch an external app');
  for (const file of [null, { path: 'folder', children: [] }, { extension: 'png' }]) {
    app.vault.getAbstractFileByPath = () => file;
    await view.openNodeFile('target');
  }
});

test('graph file opening catches sync and async failures without an external retry', async (t) => {
  const { app, view } = fixture(t);
  const start = notices.length;
  app.viewRegistry = { getTypeByExtension: () => 'image' };
  app.vault.getAbstractFileByPath = () => ({ path: 'file.png', extension: 'png' });
  app.openWithDefaultApp = () => assert.fail('Must not double-launch after failure');
  let attempts = 0;
  app.workspace.getLeaf = () => ({
    async openFile() {
      attempts++;
      throw new Error('Viewer failed');
    },
  });
  await assert.doesNotReject(view.openNodeFile('file.png'));
  app.workspace.getLeaf = () => {
    throw new Error('Leaf failed');
  };
  await assert.doesNotReject(view.openNodeFile('file.png'));
  assert.equal(attempts, 1);
  assert.deepEqual(notices.slice(start), [
    'Cannot open file: Viewer failed',
    'Cannot open file: Leaf failed',
  ]);
});

test('graph synthetic nodes keep special routing and report rejected operations', async (t) => {
  const { app, view } = fixture(t);
  const calls = [];
  app.vault.getAbstractFileByPath = () => assert.fail('Synthetic nodes are not files');
  view.nodeById.set('group', { meta: { subgraph: true } });
  const gravity = { meta: { darkEnergy: true } };
  view.nodeById.set('gravity', gravity);
  view.openSubgraphSeparately = async (id) => calls.push(id);
  view.editDarkEnergy = (node) => calls.push(node);
  await view.openNodeFile('group');
  await view.openNodeFile('gravity');
  assert.deepEqual(calls, ['group', gravity]);
  const start = notices.length;
  view.editDarkEnergy = async () => {
    throw new Error('Gravity failed');
  };
  await assert.doesNotReject(view.openNodeFile('gravity'));
  assert.deepEqual(notices.slice(start), ['Cannot open file: Gravity failed']);
});
