'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const STANDALONE_ROOT = path.resolve(__dirname, '..');
const GF_ROOT = path.resolve(process.env.GF_ROOT || path.join(STANDALONE_ROOT, '..', '..'));

const { indexVault, parseFrontmatter, extractMarkdownMetadata } = require('../src/indexer.cjs');
const { StateStore } = require('../src/state-store.cjs');
const { startStandaloneServer } = require('../src/server.cjs');

const { createRequire } = require('node:module');
const gfRequire = createRequire(path.join(GF_ROOT, 'package.json'));
const { Client } = gfRequire('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = gfRequire(
  '@modelcontextprotocol/sdk/client/streamableHttp.js'
);

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function httpGetRaw(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
  });
}

test('indexer parses frontmatter, inline tags, wikilinks, md links, canvas links, and ignore filters', (t) => {
  const dir = makeTempDir('gf-indexer-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.mkdirSync(path.join(dir, '.obsidian'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'deep/nested'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'ignored_dir'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.obsidian/app.json'),
    JSON.stringify({ userIgnoreFilters: ['ignored_dir/'] })
  );

  fs.writeFileSync(
    path.join(dir, 'alpha.md'),
    [
      '---',
      'tags:',
      '  - project',
      '  - core_layer',
      'aliases: [A1]',
      'status: active',
      '---',
      '# Alpha Title',
      'Link to [[beta|Beta Alias#Heading]] and [Gamma](./sub/gamma.md "tip") and [[dup]].',
      'Ignore code `#not-a-tag`, pure number #123456, and https://example.com/#frag.',
      'Real inline #DAG tag.',
      '```js',
      'const x = "[[beta]] #ignored_tag";',
      '```',
    ].join('\n')
  );
  fs.writeFileSync(path.join(dir, 'beta.md'), '# Beta\nBack to [[alpha]].\n');
  fs.writeFileSync(path.join(dir, 'sub/gamma.md'), '# Gamma\nUp to [Alpha](../alpha.md).\n');
  fs.writeFileSync(path.join(dir, 'dup.md'), 'root dup');
  fs.writeFileSync(path.join(dir, 'deep/nested/dup.md'), 'nested dup');
  fs.writeFileSync(path.join(dir, 'ignored_dir/secret.md'), '[[alpha]]');
  fs.writeFileSync(
    path.join(dir, 'board.canvas'),
    JSON.stringify({ nodes: [{ id: '1', type: 'file', file: 'sub/gamma.md' }], edges: [] })
  );

  const idx = indexVault(dir);
  const paths = idx.files.map((f) => f.path);
  assert.ok(!paths.some((p) => p.startsWith('ignored_dir/')));
  assert.ok(!paths.some((p) => p.startsWith('.obsidian/')));

  const alphaCache = idx.caches['alpha.md'];
  assert.deepEqual(alphaCache.frontmatter.tags, ['project', 'core_layer']);
  assert.deepEqual(alphaCache.frontmatter.aliases, ['A1']);
  assert.equal(alphaCache.frontmatter.status, 'active');
  assert.deepEqual(alphaCache.headings, [{ heading: 'Alpha Title', level: 1 }]);
  assert.deepEqual(
    alphaCache.tags.map((x) => x.tag),
    ['#DAG']
  );

  // Root `dup.md` wins shortest-path tie-break over `deep/nested/dup.md`.
  assert.deepEqual(Object.keys(idx.resolvedLinks['alpha.md']).sort(), [
    'beta.md',
    'dup.md',
    'sub/gamma.md',
  ]);
  assert.equal(idx.resolvedLinks['sub/gamma.md']['alpha.md'], 1);
  assert.equal(idx.resolvedLinks['board.canvas']['sub/gamma.md'], 1);

  const fmTest = parseFrontmatter('---\ntags: [one, two]\nflag: true\n---\nBody');
  assert.deepEqual(fmTest.frontmatter, { tags: ['one', 'two'], flag: true });
  const mdMeta = extractMarkdownMetadata('# H1\n## H2 ##\nInline #тест_тег');
  assert.deepEqual(mdMeta.cache.headings, [
    { heading: 'H1', level: 1 },
    { heading: 'H2', level: 2 },
  ]);
  assert.deepEqual(mdMeta.cache.tags, [{ tag: '#тест_тег' }]);
});

test('server enforces read-only zero-disk-writes, host/origin checks, and path traversal guards', async (t) => {
  const dir = makeTempDir('gf-readonly-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.mkdirSync(path.join(dir, '.obsidian/plugins/graphfrontier/layouts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'one.md'), '# One\n[[two]]');
  fs.writeFileSync(path.join(dir, 'two.md'), '# Two');
  fs.writeFileSync(
    path.join(dir, '.obsidian/plugins/graphfrontier/data.json'),
    JSON.stringify({ active_layout_name: 'main.json', pins: { 'one.md': { mode: 'exact' } } })
  );
  fs.writeFileSync(
    path.join(dir, '.obsidian/plugins/graphfrontier/layouts/main.json'),
    JSON.stringify({ active_layout_name: 'main.json', pins: { 'one.md': { mode: 'exact' } } })
  );

  const srv = await startStandaloneServer({
    vaultDir: dir,
    port: 0,
    mcpPort: 0,
    readOnly: true,
    watch: false,
  });
  t.after(() => srv.close());

  // Attempt state writes inside read-only server: must keep diskWrites === 0 and not create .graphfrontier.
  srv.stateStore.savePluginData({ active_layout_name: 'changed.json' });
  srv.stateStore.adapterWrite('.obsidian/plugins/graphfrontier/layouts/temp.json', '{}');
  await srv.mcpHost.setEnabled(false);
  await srv.mcpHost.setEnabled(true);
  assert.equal(srv.stateStore.diskWrites, 0);
  assert.equal(fs.existsSync(path.join(dir, '.graphfrontier')), false);

  // Path traversal and dotfiles must be rejected with 403.
  const dotRes = await httpGetRaw(
    `${srv.url}/api/note?path=${encodeURIComponent('.obsidian/plugins/graphfrontier/data.json')}`
  );
  assert.equal(dotRes.status, 403);
  const travRes = await httpGetRaw(
    `${srv.url}/api/note?path=${encodeURIComponent('../../etc/passwd')}`
  );
  assert.equal(travRes.status, 403);

  // Disallowed Origin or Host must be rejected with 403.
  const badOrigin = await httpGetRaw(`${srv.url}/api/snapshot`, { Origin: 'https://evil.example' });
  assert.equal(badOrigin.status, 403);
  const badHost = await httpGetRaw(`${srv.url}/api/snapshot`, { Host: 'evil.example:8790' });
  assert.equal(badHost.status, 403);

  const okNote = await httpGetRaw(`${srv.url}/api/note?path=one.md`);
  assert.equal(okNote.status, 200);
  assert.match(okNote.body, /# One/);
});

test(
  'e2e Chromium runtime + HTTP MCP tool mutations + SSE live update + persistence across restart',
  {
    skip: !process.env.GRAPHFRONTIER_PLAYWRIGHT_MODULE || !process.env.GRAPHFRONTIER_CHROMIUM,
  },
  async (t) => {
    const dir = makeTempDir('gf-e2e-');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    fs.mkdirSync(path.join(dir, '.obsidian'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.obsidian/appearance.json'),
      JSON.stringify({ theme: 'obsidian' })
    );
    fs.writeFileSync(path.join(dir, 'a.md'), '---\ntags: [core]\n---\n# Alpha Note\nHello [[b]]');
    fs.writeFileSync(path.join(dir, 'b.md'), '---\ntags: [leaf]\n---\n# Beta Note\nFrom [[a]]');
    fs.writeFileSync(path.join(dir, 'c.md'), '# Gamma Note\nStandalone');

    const { chromium } = require(process.env.GRAPHFRONTIER_PLAYWRIGHT_MODULE);
    const browser = await chromium.launch({
      executablePath: process.env.GRAPHFRONTIER_CHROMIUM,
      headless: true,
    });
    t.after(() => browser.close());

    const srv = await startStandaloneServer({
      vaultDir: dir,
      port: 0,
      mcpPort: 0,
      readOnly: false,
      watch: false,
    });
    const pageErrors = [];
    const consoleErrors = [];
    let mcpClient = null;
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      page.on('pageerror', (err) => pageErrors.push(err.message));
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });

      await page.goto(srv.url, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__graphFrontierStandalone?.view?.isOpen === true);

      const initialNodes = await page.evaluate(
        () => window.__graphFrontierStandalone.view.nodes.length
      );
      // Fresh DEFAULT_DATA enables hide_orphans: true, so unlinked c.md starts hidden (a.md + b.md = 2).
      assert.equal(initialNodes, 2);

      // Open note reader via workspace API.
      await page.evaluate(async () => {
        const { app } = window.__graphFrontierStandalone;
        const f = app.vault.getAbstractFileByPath('a.md');
        await app.workspace.getLeaf().openFile(f);
      });
      await page.waitForSelector('.graphfrontier-reader.is-open');
      const readerTitle = await page.textContent('.graphfrontier-reader-title');
      assert.equal(readerTitle, 'a');
      await page.click('.graphfrontier-reader-close');

      // Real Streamable HTTP MCP client over loopback.
      assert.equal(srv.mcpHost.enabled, true);
      mcpClient = new Client({ name: 'standalone-e2e', version: '1.0.0' });
      await mcpClient.connect(new StreamableHTTPClientTransport(new URL(srv.mcpHost.url)));

      const viewsRes = await mcpClient.callTool({ name: 'list_views', arguments: {} });
      const viewRef = viewsRes.structuredContent.views[0];
      assert.ok(viewRef?.viewId && viewRef?.contextToken);

      const cfgRes = await mcpClient.callTool({
        name: 'get_configuration',
        arguments: { viewId: viewRef.viewId },
      });
      assert.equal(cfgRes.structuredContent.layout, 'data.json');

      const searchRes = await mcpClient.callTool({
        name: 'search_nodes',
        arguments: { viewId: viewRef.viewId, query: 'tag:core' },
      });
      assert.deepEqual(searchRes.structuredContent.nodeIds, ['a.md']);

      const showOrphansRes = await mcpClient.callTool({
        name: 'update_settings',
        arguments: {
          viewId: viewRef.viewId,
          contextToken: viewRef.contextToken,
          settings: { hide_orphans: false },
        },
      });
      assert.equal(showOrphansRes.isError, undefined);
      await page.waitForFunction(() => window.__graphFrontierStandalone.view.nodes.length === 3);

      const viewsAfter = await mcpClient.callTool({ name: 'list_views', arguments: {} });
      const nextToken = viewsAfter.structuredContent.views[0].contextToken;
      const pinRes = await mcpClient.callTool({
        name: 'pin_nodes',
        arguments: {
          viewId: viewRef.viewId,
          contextToken: nextToken,
          nodeIds: ['a.md'],
          mode: 'exact',
        },
      });
      assert.equal(pinRes.isError, undefined, `pin_nodes failed: ${JSON.stringify(pinRes)}`);

      // Flush debounced plugin persist cleanly before restart check.
      await page.evaluate(async () => {
        const { plugin } = window.__graphFrontierStandalone;
        await plugin.persistPluginDataOnly();
      });

      const livePins = await page.evaluate(
        () => window.__graphFrontierStandalone.plugin.data.pins['a.md']
      );
      assert.equal(livePins?.mode, 'exact');
      assert.ok(fs.existsSync(path.join(dir, '.graphfrontier/data.json')));

      // Add a new file and push SSE vault-update.
      fs.writeFileSync(path.join(dir, 'd.md'), '# Delta\n[[a]]');
      srv.triggerReindex();
      await page.waitForFunction(
        () => window.__graphFrontierStandalone.view.nodes.length === 4,
        null,
        { timeout: 5000 }
      );
    } finally {
      if (mcpClient) await mcpClient.close().catch(() => {});
      await srv.close();
    }

    // Restart server and verify persisted pin survived on disk.
    const srv2 = await startStandaloneServer({
      vaultDir: dir,
      port: 0,
      mcpPort: 0,
      readOnly: false,
      watch: false,
    });
    t.after(() => srv2.close());
    assert.equal(srv2.stateStore.getPluginData()?.pins?.['a.md']?.mode, 'exact');
    assert.equal(srv2.getIndex().files.filter((f) => f.path.endsWith('.md')).length, 4);
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(consoleErrors, []);
  }
);

test('StateStore merges fallback layouts and node-lists from .obsidian after .graphfrontier/data.json is written', (t) => {
  const dir = makeTempDir('gf-statestore-merge-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const obsDir = path.join(dir, '.obsidian', 'plugins', 'graphfrontier');
  fs.mkdirSync(path.join(obsDir, 'layouts', 'backups'), { recursive: true });
  fs.writeFileSync(
    path.join(obsDir, 'data.json'),
    JSON.stringify({ active_layout_name: 'new.json', pins: { 'a.md': { mode: 'exact' } } })
  );
  fs.writeFileSync(
    path.join(obsDir, 'layouts', 'new.json'),
    JSON.stringify({
      active_layout_name: 'new.json',
      saved_positions: { 'a.md': { x: 10, y: 20 } },
    })
  );
  fs.writeFileSync(
    path.join(obsDir, 'layouts', 'backups', 'new.json'),
    JSON.stringify({ snapshots: [] })
  );
  fs.writeFileSync(
    path.join(obsDir, 'node-lists.json'),
    JSON.stringify({ version: 1, lists: [{ id: 'list-1', name: 'Core', items: ['a.md'] }] })
  );

  const store1 = new StateStore({ vaultDir: dir, readOnly: false });
  store1.savePluginData({ active_layout_name: 'new.json', pins: { 'a.md': { mode: 'exact' } } });
  assert.ok(fs.existsSync(path.join(dir, '.graphfrontier', 'data.json')));
  assert.equal(fs.existsSync(path.join(dir, '.graphfrontier', 'layouts')), false);

  const store2 = new StateStore({ vaultDir: dir, readOnly: false });
  const files = store2.getPluginFilesObject();
  assert.ok(
    files['.obsidian/plugins/graphfrontier/layouts/new.json'],
    'fallback layout must still be loaded'
  );
  assert.ok(
    files['.obsidian/plugins/graphfrontier/layouts/backups/new.json'],
    'fallback layout backup must still be loaded'
  );
  assert.ok(
    files['.obsidian/plugins/graphfrontier/node-lists.json'],
    'fallback node-lists must still be loaded'
  );
});

test('StateStore isolated mode ignores Obsidian/.graphfrontier configs and persists local-view state separately', (t) => {
  const dir = makeTempDir('gf-statestore-isolated-');
  const customVsCodeDir = makeTempDir('gf-statestore-vscode-dir-');
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(customVsCodeDir, { recursive: true, force: true });
  });

  const obsDir = path.join(dir, '.obsidian', 'plugins', 'graphfrontier');
  fs.mkdirSync(path.join(obsDir, 'layouts'), { recursive: true });
  fs.writeFileSync(path.join(obsDir, 'manifest.json'), JSON.stringify({ name: 'FromObsidian' }));
  fs.writeFileSync(
    path.join(obsDir, 'data.json'),
    JSON.stringify({ active_layout_name: 'obsidian.json', pins: { 'a.md': { mode: 'exact' } } })
  );
  fs.writeFileSync(
    path.join(obsDir, 'layouts', 'obsidian.json'),
    JSON.stringify({ active_layout_name: 'obsidian.json' })
  );
  fs.writeFileSync(
    path.join(obsDir, 'node-lists.json'),
    JSON.stringify({ version: 1, lists: [{ id: 'obs-list', name: 'Obsidian', items: ['a.md'] }] })
  );

  const store = new StateStore({ vaultDir: dir, stateDir: customVsCodeDir, isolated: true });
  assert.equal(store.getPluginData(), null);
  assert.deepEqual(store.getPluginFilesObject(), {});
  assert.equal(store.manifest.name, 'GraphFrontier');

  store.savePluginData({ active_layout_name: 'vscode.json', pins: { 'b.md': { mode: 'exact' } } });
  store.writeLocalViewState({ local: { path: 'b.md', data: { settings: { show_grid: false } } } });

  assert.equal(fs.existsSync(path.join(dir, '.graphfrontier')), false);
  assert.ok(fs.existsSync(path.join(customVsCodeDir, 'data.json')));
  assert.ok(fs.existsSync(path.join(customVsCodeDir, 'local-view.json')));

  const reloaded = new StateStore({ vaultDir: dir, stateDir: customVsCodeDir, isolated: true });
  assert.equal(reloaded.getPluginData()?.active_layout_name, 'vscode.json');
  assert.equal(reloaded.readLocalViewState()?.local?.path, 'b.md');
});

test('StateStore importFromObsidian copies saves into isolated dir without touching local-view.json or .obsidian', (t) => {
  const dir = makeTempDir('gf-statestore-import-');
  const targetDir = makeTempDir('gf-statestore-import-target-');
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
  });

  const obsDir = path.join(dir, '.obsidian', 'plugins', 'graphfrontier');
  fs.mkdirSync(path.join(obsDir, 'layouts', 'backups'), { recursive: true });
  fs.writeFileSync(
    path.join(obsDir, 'data.json'),
    JSON.stringify({ active_layout_name: 'new.json', pins: { 'a.md': { mode: 'exact' } } })
  );
  fs.writeFileSync(
    path.join(obsDir, 'layouts', 'new.json'),
    JSON.stringify({
      active_layout_name: 'new.json',
      saved_positions: { 'a.md': { x: 11, y: 22 } },
    })
  );
  fs.writeFileSync(
    path.join(obsDir, 'layouts', 'backups', 'new.json'),
    JSON.stringify({ snapshots: [] })
  );
  fs.writeFileSync(
    path.join(obsDir, 'node-lists.json'),
    JSON.stringify({ version: 1, lists: [{ id: 'l1', name: 'List', items: ['a.md'] }] })
  );

  const store = new StateStore({ vaultDir: dir, stateDir: targetDir, isolated: true });
  store.writeLocalViewState({ local: { path: 'keep.md' } });

  const res = store.importFromObsidian();
  assert.equal(res.imported, true);
  assert.equal(res.activeLayout, 'new.json');
  assert.equal(res.layoutsCount, 1);
  assert.equal(store.getPluginData()?.pins?.['a.md']?.mode, 'exact');
  assert.ok(store.getPluginFilesObject()['.obsidian/plugins/graphfrontier/layouts/new.json']);
  assert.ok(
    store.getPluginFilesObject()['.obsidian/plugins/graphfrontier/layouts/backups/new.json']
  );
  assert.ok(store.getPluginFilesObject()['.obsidian/plugins/graphfrontier/node-lists.json']);
  assert.equal(store.readLocalViewState()?.local?.path, 'keep.md');

  const reloaded = new StateStore({ vaultDir: dir, stateDir: targetDir, isolated: true });
  assert.equal(reloaded.getPluginData()?.active_layout_name, 'new.json');
  assert.ok(fs.existsSync(path.join(obsDir, 'data.json')));
});
