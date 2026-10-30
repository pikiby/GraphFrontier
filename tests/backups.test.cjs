const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, loadSource } = require('./helpers/obsidian.cjs');
const { mobileVault } = require('./helpers/mobile-vault.cjs');
const { BackupManager, backupFolder } = loadSource('backups.js');
const { NodeListStore } = loadSource('node-lists.js');
async function setup(t, prefs = {}) {
  const f = fixture(t);
  const m = mobileVault(t);
  Object.assign(f.app.vault, m.vault);
  f.app.vault.read = m.vault.cachedRead;
  f.app.vault.process = async (file, fn) => {
    m.contents.set(file.path, fn(m.contents.get(file.path)));
  };
  f.app.vault.delete = async (entry) => {
    m.contents.delete(entry.path);
    m.entries.delete(entry.path);
  };
  f.app.vault.rename = async (entry, path) => {
    assert(!m.entries.has(path));
    const raw = m.contents.get(entry.path);
    m.contents.delete(entry.path);
    m.entries.delete(entry.path);
    entry.path = path;
    m.entries.set(path, entry);
    m.contents.set(path, raw);
  };
  f.adapter.exists = async (path) =>
    f.files.has(path) || [...f.files.keys()].some((p) => p.startsWith(path + '/'));
  f.adapter.list = async (path) => ({
    files: [...f.files.keys()].filter((p) => p.startsWith(path + '/')),
    folders: [],
  });
  f.adapter.remove = async (path) => f.files.delete(path);
  f.plugin.nodeListStore = new NodeListStore(f.adapter, 'lists.json', () =>
    f.plugin.nodeListsChanged()
  );
  await f.plugin.nodeListStore.update({
    action: 'create',
    listId: 'ERROR',
    name: 'Errors',
    nodeIds: ['a.md'],
  });
  f.putLayout(f.plugin.data);
  f.putLayout(
    { ...f.plugin.data, groups: [{ id: 'g', query: 'tag:test', color: '#ffffff' }] },
    'other.json'
  );
  const manager = new BackupManager(f.plugin, prefs);
  f.plugin.backups = manager;
  await manager.initialize();
  return { ...f, ...m, manager };
}
test('default backup is one verified file, includes all layouts/lists and excludes tokens', async (t) => {
  const f = await setup(t);
  assert.equal(f.manager.preferences.enabled, true);
  f.plugin.data.token = 'secret';
  f.plugin.data.settings.apiToken = 'secret';
  await f.manager.write();
  const first = f.contents.get(f.manager.path);
  const b = JSON.parse(first);
  assert.equal(b.layouts.length, 2);
  assert.equal(b.lists[0].id, 'ERROR');
  assert(!first.includes('secret'));
  await f.plugin.updateNodeList({ action: 'add', listId: 'ERROR', nodeIds: ['b.md'] });
  await f.manager.write();
  assert.equal([...f.contents.keys()].length, 1);
  assert.equal(JSON.parse(f.contents.get(f.manager.path)).lists[0].nodeIds.length, 2);
});
test('reinstallation and Not now never overwrite an existing copy, including after restart', async (t) => {
  const f = await setup(t);
  await f.manager.write();
  const original = f.contents.get(f.manager.path);
  const fresh = new BackupManager(f.plugin, {});
  await fresh.initialize();
  assert(fresh.blocked);
  fresh.schedule();
  assert.equal(fresh.timer, null);
  await assert.rejects(fresh.write(), /protected/);
  assert.equal(f.contents.get(fresh.path), original);
  const restart = new BackupManager(f.plugin, fresh.preferences);
  await restart.initialize();
  assert(restart.blocked);
  await assert.rejects(restart.write({ replace: true, expectedRaw: 'stale' }), /changed/);
  await restart.write({ replace: true, expectedRaw: original });
  assert.equal(restart.blocked, false);
});
test('corrupt backup, unreadable layouts and failed writes do not publish success', async (t) => {
  const f = await setup(t);
  await f.manager.write();
  const original = f.contents.get(f.manager.path),
    last = f.manager.lastSuccess;
  f.adapter.list = async () => {
    throw new Error('read failure');
  };
  await assert.rejects(f.manager.write(), /read failure/);
  assert.equal(f.contents.get(f.manager.path), original);
  f.contents.set(f.manager.path, '{broken');
  const fresh = new BackupManager(f.plugin);
  await fresh.initialize();
  assert(fresh.blocked);
  assert(fresh.error);
  assert.equal(f.contents.get(f.manager.path), '{broken');
  assert.equal(f.manager.lastSuccess, last);
});
test('disabled automatic backups stay disabled while manual backup remains available', async (t) => {
  const f = await setup(t);
  await f.manager.configure({ enabled: false });
  f.manager.schedule();
  assert.equal(f.manager.timer, null);
  await f.manager.write();
  assert(f.contents.has(f.manager.path));
});
test('restore checks confirmation snapshot, restores lists and layouts and keeps unrelated layouts', async (t) => {
  const f = await setup(t);
  await f.manager.write();
  const raw = f.contents.get(f.manager.path);
  await f.plugin.updateNodeList({ action: 'replace', listId: 'ERROR', nodeIds: [] });
  f.putLayout(f.plugin.data, 'extra.json');
  await assert.rejects(f.manager.restore('old'), /changed/);
  await f.manager.restore(raw);
  assert.deepEqual(f.plugin.getNodeLists()[0].nodeIds, ['a.md']);
  assert(f.files.has(f.layoutPath('extra.json')));
  assert.equal(f.contents.get(f.manager.path), raw);
  assert.equal(f.manager.blocked, false);
});
test('partial restore failure rolls working files back and protects backup', async (t) => {
  const f = await setup(t);
  await f.manager.write();
  const raw = f.contents.get(f.manager.path);
  await f.plugin.updateNodeList({ action: 'replace', listId: 'ERROR', nodeIds: ['working.md'] });
  const previous = new Map(f.files);
  const write = f.adapter.write.bind(f.adapter);
  let count = 0;
  f.adapter.write = async (path, text) => {
    if (++count === 2) throw new Error('write failure');
    return write(path, text);
  };
  await assert.rejects(f.manager.restore(raw), /write failure/);
  for (const [path, text] of previous) assert.equal(f.files.get(path), text);
  assert.deepEqual(f.plugin.getNodeLists()[0].nodeIds, ['working.md']);
  assert.equal(f.contents.get(f.manager.path), raw);
  assert(f.manager.blocked);
});
test('folder validation rejects outside/config/hidden paths', () => {
  for (const path of ['/tmp', '../x', '.obsidian/x', 'C:/x', 'a//b', 'settings/x'])
    assert.throws(() => backupFolder(path, 'settings'));
  assert.equal(backupFolder('GraphFrontier backups', '.obsidian'), 'GraphFrontier backups');
});

test('failed backup write preserves the previous file and does not advance success', async (t) => {
  const f = await setup(t);
  await f.manager.write();
  const raw = f.contents.get(f.manager.path),
    time = f.manager.lastSuccess;
  f.app.vault.process = async () => {
    throw new Error('storage unavailable');
  };
  await assert.rejects(f.manager.write(), /storage unavailable/);
  assert.equal(f.contents.get(f.manager.path), raw);
  assert.equal(f.manager.lastSuccess, time);
});

test('leaving protected Backups settings does not authorize replacement and menu exposes both tools', async (t) => {
  const { BackupsPanel } = loadSource('backups-modal.js');
  const { obsidian } = require('./helpers/obsidian.cjs');
  const f = await setup(t);
  await f.manager.write();
  const raw = f.contents.get(f.manager.path);
  const fresh = new BackupManager(f.plugin);
  await fresh.initialize();
  f.plugin.backups = fresh;
  const modal = new BackupsPanel(f.plugin, new obsidian.Modal(f.app).contentEl);
  modal.onOpen();
  modal.onClose();
  assert(fresh.blocked);
  assert.equal(f.contents.get(fresh.path), raw);
  const menu = new obsidian.Menu();
  f.view.onPaneMenu(menu);
  assert(menu.items.some((i) => i.title === 'Node lists...'));
  assert(menu.items.some((i) => i.title === 'Backups...'));
});

test('partial overwrite keeps a verified recovery copy across restart and explicit restore', async (t) => {
  const f = await setup(t);
  await f.manager.write();
  const raw = f.contents.get(f.manager.path),
    last = f.manager.lastSuccess;
  const process = f.app.vault.process;
  f.app.vault.process = async (file, fn) => {
    f.contents.set(file.path, fn(f.contents.get(file.path)).slice(0, 25));
    throw new Error('ENOSPC');
  };
  await assert.rejects(f.manager.write(), /ENOSPC/);
  assert.equal(f.contents.get(f.manager.recoveryPath), raw);
  assert.equal(f.manager.lastSuccess, last);
  const restart = new BackupManager(f.plugin, f.manager.preferences);
  f.plugin.backups = restart;
  await restart.initialize();
  assert(restart.blocked);
  assert.equal((await restart.read()).raw, raw);
  assert((await restart.read()).recovered);
  await assert.rejects(restart.write(), /protected/);
  f.app.vault.process = process;
  await restart.restore(raw);
  assert.equal(f.contents.get(restart.path), raw);
  assert(!f.contents.has(restart.recoveryPath));
  await restart.write();
  assert.equal(restart.blocked, false);
});
test('failed recovery copy never touches the last complete backup', async (t) => {
  const f = await setup(t);
  await f.manager.write();
  const raw = f.contents.get(f.manager.path);
  const create = f.app.vault.create;
  f.app.vault.create = async (path, text) => {
    if (path === f.manager.recoveryPath) {
      f.file(path, text.slice(0, 20));
      throw new Error('ENOSPC');
    }
    return create(path, text);
  };
  await assert.rejects(f.manager.write(), /ENOSPC/);
  assert.equal(f.contents.get(f.manager.path), raw);
  f.app.vault.create = create;
  await f.manager.write();
  assert(!f.contents.has(f.manager.recoveryPath));
});
test('failed first write leaves no corrupted final backup', async (t) => {
  const f = await setup(t);
  f.app.vault.create = async (path, text) => {
    f.file(path, text.slice(0, 20));
    throw new Error('ENOSPC');
  };
  await assert.rejects(f.manager.write(), /ENOSPC/);
  assert(!f.contents.has(f.manager.path));
  assert.equal(f.contents.size, 0);
});
test('backup verifies content before deleting the recovery copy', async (t) => {
  const f = await setup(t);
  await f.manager.write();
  const raw = f.contents.get(f.manager.path);
  f.app.vault.process = async (file, fn) => {
    fn(raw);
    f.contents.set(file.path, '{broken');
  };
  await assert.rejects(f.manager.write());
  assert.equal(f.contents.get(f.manager.recoveryPath), raw);
});
test('Windows reserved folder names are rejected on every platform', () => {
  for (const name of [
    'CON',
    'NUL',
    'PRN',
    'AUX',
    'COM1',
    'LPT9',
    'con.txt',
    'Backup/NUL',
    'com\u00b9',
    'lpt\u00b2.log',
  ])
    assert.throws(() => backupFolder(name, '.obsidian'), undefined, name);
  for (const name of ['Console', 'Company', 'COM10', 'Резерв/Копия'])
    assert.equal(backupFolder(name, '.obsidian'), name);
});
