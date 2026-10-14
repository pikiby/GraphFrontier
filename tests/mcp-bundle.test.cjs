const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const Module = require('node:module');
const { buildSync } = require('esbuild');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const {
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { fixture, obsidian } = require('./helpers/obsidian.cjs');

const code = buildSync({
  entryPoints: [path.resolve(__dirname, '../src/main.js')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: 'es2018',
  external: ['obsidian', ...Module.builtinModules, 'node:*'],
}).outputFiles[0].text;

function loadBundle(desktop) {
  const imports = [];
  const compiled = new Module('graphfrontier-bundle-test');
  compiled.require = (id) => {
    if (id === 'obsidian') return obsidian;
    imports.push(id);
    assert.equal(desktop, true, `Mobile tried loading ${id}`);
    assert.equal(Module.isBuiltin(id), true, `Unbundled dependency ${id}`);
    return require(id);
  };
  compiled._compile(code, path.join(__dirname, 'virtual-main.js'));
  return { Plugin: compiled.exports, imports };
}

async function unusedPort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('bundled mobile plugin opens without requiring any Node or MCP module', async (t) => {
  const f = fixture(t);
  const old = { ...obsidian.Platform };
  obsidian.Platform.isDesktopApp = false;
  obsidian.Platform.isMobile = true;
  t.after(() => Object.assign(obsidian.Platform, old));
  const { Plugin, imports } = loadBundle(false);
  const plugin = new Plugin(f.app, { id: 'graphfrontier', version: '0.7.7' });
  plugin.loadData = f.plugin.loadData;
  plugin.saveData = f.plugin.saveData;
  await plugin.onload();
  assert.equal(plugin.mcp.desktop, false);
  assert.deepEqual(imports, []);
  plugin.onunload();
});

test('desktop bundle serves real MCP without vault node_modules; plugin unload stops it', async (t) => {
  const f = fixture(t);
  const { Plugin, imports } = loadBundle(true);
  assert.deepEqual(imports, []); // Disabled/unloaded transport remains lazy.
  const plugin = new Plugin(f.app, { id: 'graphfrontier', version: '0.7.7' });
  plugin.loadData = f.plugin.loadData;
  plugin.saveData = f.plugin.saveData;
  const port = await unusedPort();
  const token = 'b'.repeat(64);
  f.files.set(
    '.test-config/plugins/graphfrontier/mcp.json',
    JSON.stringify({ enabled: true, port, token })
  );
  await plugin.onload();
  t.after(() => plugin.mcp.stop());
  assert.equal(plugin.mcp.error, '');
  assert.ok(imports.includes('node:http'));
  const client = new Client({ name: 'bundle-test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    })
  );
  t.after(() => client.close());
  assert.equal((await client.listTools()).tools.length, 32);
  const result = await client.callTool({ name: 'list_views', arguments: {} });
  assert.equal(result.structuredContent.views.length, 1);
  const server = plugin.mcp.server;
  plugin.onunload();
  assert.equal(server.closed, true);
  assert.throws(() => plugin.api.listViews(), { code: 'API_CLOSED' });
});
