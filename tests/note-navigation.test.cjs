const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { fixture, loadSource, notices } = require('./helpers/obsidian.cjs');
const { addNoteNavigationActions, openNoteTarget } = loadSource('note-navigation.js');
const { mobileVault } = require('./helpers/mobile-vault.cjs');

function menu() {
  return {
    items: [],
    addItem(build) {
      const item = {
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
  await first.items[0].click();
  await first.items[1].click();
  assert.deepEqual(opened, ['https://example.com/', 'target.md']);
  frontmatter = { url: 'https://example.org', path: ' ' };
  const second = menu();
  addNoteNavigationActions(second, app, file, host);
  assert.equal(second.items.length, 1);
  await second.items[0].click();
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
  await actions.items[0].click();
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
  await actions.items[0].click();
  assert.match(notices.at(-1), /URL must use/);
  await actions.items[1].click();
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
