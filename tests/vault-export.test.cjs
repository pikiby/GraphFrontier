const assert = require('node:assert/strict');
const test = require('node:test');
const { loadSource } = require('./helpers/obsidian.cjs');
const { mobileVault } = require('./helpers/mobile-vault.cjs');
const { resolveVaultExportPath, writeVaultExport } = loadSource('vault-export.js');

test('concurrent exports cannot overwrite each other without permission', async (t) => {
  const { vault, contents } = mobileVault(t, false);
  const results = await Promise.allSettled([
    writeVaultExport(vault, 'Exports/graph.html', 'first', { overwrite: false }),
    writeVaultExport(vault, 'Exports/graph.html', 'second', { overwrite: false }),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.match(results[1].reason.message, /already exists/);
  assert.equal(contents.get('Exports/graph.html'), 'first');
  await writeVaultExport(vault, 'Exports/graph.html', 'third', { overwrite: true });
  assert.equal(contents.get('Exports/graph.html'), 'third');
});

test('state changes while creating export parents prevent writing stale HTML', async (t) => {
  const { vault, contents } = mobileVault(t, false);
  const createFolder = vault.createFolder;
  let current = true;
  vault.createFolder = async (path) => {
    await createFolder(path);
    current = false;
  };
  await assert.rejects(
    writeVaultExport(vault, 'Exports/graph.html', 'stale', {
      assertCurrent: () => {
        if (!current) throw new Error('State changed');
      },
    }),
    /State changed/
  );
  assert.equal(contents.has('Exports/graph.html'), false);
});

test('failed exports do not poison the queue or cross vault boundaries', async (t) => {
  const { vault, file, contents } = mobileVault(t, false);
  file('graph.html', 'original');
  await assert.rejects(writeVaultExport(vault, 'graph.html', 'no', { overwrite: false }));
  await writeVaultExport(vault, 'other.html', 'ok', { overwrite: false });
  assert.equal(contents.get('graph.html'), 'original');
  assert.equal(contents.get('other.html'), 'ok');
});

test('mobile export resolves vault filenames and folders without Node paths', (t) => {
  const { vault, folder } = mobileVault(t);
  folder('Exports');
  for (const [input, expected] of [
    ['graph', 'graph.html'],
    ['graph.md', 'graph.html'],
    ['graph.htm', 'graph.htm'],
    ['Exports', 'Exports/graphfrontier-static.html'],
    ['New/', 'New/graphfrontier-static.html'],
    ['  Exports\\graph.HTML  ', 'Exports/graph.HTML'],
    ['Exports//graph.html', 'Exports/graph.html'],
    ['\u0413\u0440\u0430\u0444.html', '\u0413\u0440\u0430\u0444.html'],
  ])
    assert.equal(resolveVaultExportPath(vault, input), expected);
});

test('mobile export rejects outside-vault, hidden, URL and unsafe paths before writing', (t) => {
  const { vault, calls } = mobileVault(t);
  for (const input of [
    '',
    '/tmp/file',
    'C:\\file.html',
    'C:file',
    '\\\\server\\file',
    '~/file',
    '../file',
    'Exports/../file',
    './file',
    '.obsidian/file',
    'https://host/file',
    'file:///tmp/file',
    'obsidian://open?vault=x',
    'x/CON.html',
    'file?.html',
    'x\x00.html',
    'x./file',
  ]) {
    assert.throws(() => resolveVaultExportPath(vault, input), undefined, input);
  }
  assert.deepEqual(calls, []);
});

test('mobile writes create parents and use Vault.modify only for existing exports', async (t) => {
  const { vault, contents, calls } = mobileVault(t);
  await writeVaultExport(vault, 'Exports/Nested/graph.html', 'first');
  await writeVaultExport(vault, 'Exports/Nested/graph.html', 'second');
  assert.equal(contents.get('Exports/Nested/graph.html'), 'second');
  assert.deepEqual(calls, [
    ['mkdir', 'Exports'],
    ['mkdir', 'Exports/Nested'],
    ['create', 'Exports/Nested/graph.html'],
    ['modify', 'Exports/Nested/graph.html'],
  ]);
});

test('mobile export does not overwrite a file used as parent or a folder used as target', async (t) => {
  const { vault, file, folder, contents } = mobileVault(t);
  file('blocked', 'keep');
  folder('graph.html');
  await assert.rejects(writeVaultExport(vault, 'blocked/graph.html', 'new'), /Not a folder/);
  await assert.rejects(writeVaultExport(vault, 'graph.html', 'new'), /points to a folder/);
  assert.equal(contents.get('blocked'), 'keep');
});

test('mobile export propagates storage errors and handles another writer creating a folder', async (t) => {
  const { vault, folder } = mobileVault(t);
  vault.createFolder = async (path) => {
    folder(path);
    throw new Error('already exists');
  };
  await writeVaultExport(vault, 'Exports/graph.html', 'ok');
  vault.modify = async () => {
    throw new Error('read-only');
  };
  await assert.rejects(writeVaultExport(vault, 'Exports/graph.html', 'no'), /read-only/);
  vault.createFolder = async () => {
    throw new Error('permission denied');
  };
  await assert.rejects(writeVaultExport(vault, 'Other/graph.html', 'no'), /permission denied/);
});
