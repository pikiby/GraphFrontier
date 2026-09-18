const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { fixture, loadSource, notices } = require('./helpers/obsidian.cjs');
const { addNoteNavigationActions, openNoteTarget } = loadSource('note-navigation.js');

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
          fs: {
            promises: {
              stat: async (target) => {
                assert.equal(target, expected);
              },
            },
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

test('malformed URL and missing path report errors without launching an application', async (t) => {
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
        fs: {
          promises: {
            stat: async () => {
              throw new Error('ENOENT');
            },
          },
        },
        electron: {
          shell: {
            openPath: async () => {
              opened = true;
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
  assert.match(notices.at(-1), /Path not found/);
  assert.equal(opened, false);
});
