const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const Module = require('node:module');
const vm = require('node:vm');
const { build } = require('esbuild');
const { createPluginBuildOptions } = require('../scripts/plugin-build-options.cjs');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const {
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { fixture, obsidian } = require('./helpers/obsidian.cjs');

let code;
test.before(async () => {
  const result = await build({
    ...createPluginBuildOptions({ production: true }),
    entryPoints: [path.resolve(__dirname, '../src/main.js')],
    write: false,
    sourcemap: false,
    logLevel: 'silent',
  });
  code = result.outputFiles[0].text;
});

test('runtime bundle has no direct filesystem imports', () => {
  assert.doesNotMatch(code, /(?:require|nodeRequire)\(["'](?:node:)?fs(?:\/promises)?["']\)/);
});

function loadBundle(desktop) {
  const imports = [];
  const compiled = { exports: {} };
  const requireBuiltin = (id) => {
    if (id === 'obsidian') return obsidian;
    imports.push(id);
    assert.equal(desktop, true, `Mobile tried loading ${id}`);
    assert.equal(Module.isBuiltin(id), true, `Unbundled dependency ${id}`);
    if (['http', 'https', 'node:http', 'node:https'].includes(id)) {
      return {
        ...require(id),
        request: () => assert.fail('Plugin must not originate HTTP requests in this scenario'),
        get: () => assert.fail('Plugin must not originate HTTP requests in this scenario'),
      };
    }
    return require(id);
  };
  const context = vm.createContext(
    {
      module: compiled,
      exports: compiled.exports,
      require: requireBuiltin,
      Buffer,
      console,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      Request,
      Response,
      Headers,
      FormData,
      Blob,
      File,
      Event,
      MessageEvent,
      crypto: require('node:crypto').webcrypto,
      atob,
      btoa,
      ReadableStream,
      WritableStream,
      TransformStream,
      AbortController,
      AbortSignal,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      queueMicrotask,
      structuredClone,
      window: globalThis.window,
    },
    { codeGeneration: { strings: false, wasm: false } }
  );
  context.global = context;
  const script = new vm.Script(`(function (exports, require, module) {\n${code}\n})`, {
    filename: path.join(__dirname, 'virtual-main.js'),
  });
  script.runInContext(context)(compiled.exports, requireBuiltin, compiled);
  return { Plugin: compiled.exports, imports, context };
}

test('bundle VM denies direct and aliased dynamic code generation', () => {
  const { context } = loadBundle(true);
  assert.throws(() => context.require('zod'), /Unbundled dependency zod/);
  for (const source of [
    'Function("return 1")()',
    'new Function("return 1")()',
    'const F = Function; new F("return 1")()',
    'eval("1")',
    '(0, eval)("1")',
    'const evaluate = eval; evaluate("1")',
    '(() => {}).constructor("return 1")()',
  ]) {
    assert.throws(() => vm.runInContext(`{ ${source}; }`, context), {
      name: 'EvalError',
      message: /Code generation from strings disallowed/,
    });
  }
  assert.throws(
    () =>
      vm.runInContext('new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]))', context),
    { name: 'CompileError', message: /Wasm code generation disallowed/ }
  );
});

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

test('CSP-restricted desktop bundle serves real MCP without vault node_modules; unload stops it', async (t) => {
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
  t.after(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    })
  );
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 33);
  assert(tools.tools.some((tool) => tool.name === 'subgraph_nodes'));
  const result = await client.callTool({ name: 'list_views', arguments: {} });
  assert.equal(result.structuredContent.views.length, 1);
  assert.equal(JSON.stringify(result).includes(token), false);
  const state = result.structuredContent.views[0];
  const ref = { viewId: state.viewId, contextToken: state.contextToken };
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  assert.equal((await call('get_state', ref)).structuredContent.nodeCount, 1);
  const changed = await call('update_settings', {
    ...ref,
    settings: { node_color: '#aa0000', layout_autosave: false },
  });
  assert.equal(changed.isError, undefined);
  assert.equal(changed.structuredContent.settings.node_color, '#aa0000');
  assert.equal(plugin.getSettings().node_color, '#aa0000');
  const before = JSON.stringify(plugin.data);
  const writesBefore = f.writes.length;
  const preferencesBefore = f.preferences.length;
  for (const settings of [
    { damping: 200, node_color: '#00ff00' },
    { damping: '0.5' },
    { search_mode: 'invalid' },
    { unexpected_setting: true },
  ]) {
    const invalid = await call('update_settings', { ...ref, settings });
    assert.equal(invalid.isError, true, JSON.stringify(settings));
    assert.equal(JSON.stringify(plugin.data), before, 'Invalid settings must not partially apply');
    assert.equal(f.writes.length, writesBefore);
    assert.equal(f.preferences.length, preferencesBefore);
  }
  const configuration = await call('get_configuration', ref);
  assert.equal(configuration.isError, undefined);
  assert.deepEqual(configuration.structuredContent.settings, JSON.parse(before).settings);
  const server = plugin.mcp.server;
  plugin.onunload();
  assert.equal(server.closed, true);
  assert.throws(() => plugin.api.listViews(), { code: 'API_CLOSED' });
});
