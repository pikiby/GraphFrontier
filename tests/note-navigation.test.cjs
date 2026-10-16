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
