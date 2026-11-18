const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');
const vm = require('node:vm');
const { build } = require('esbuild');
const { createPluginBuildOptions } = require('../scripts/plugin-build-options.cjs');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { fixture, obsidian } = require('./helpers/obsidian.cjs');

let code;
test.before(async () => {
  const result = await build({
    ...createPluginBuildOptions({ production: true }),
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

test('bundled stdio subprocess negotiates tools without a vault node_modules', async (t) => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gf-stdio-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const entry = path.join(dir, 'main.js');
  fs.writeFileSync(entry, code);
  const c = new Client({ name: 'bundle-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, '--mcp-stdio', 'fixture'],
    env: { PATH: dir },
  });
  t.after(() => c.close());
  await c.connect(transport);
  assert.equal((await c.listTools()).tools.length, 35);
  const result = await c.callTool({ name: 'list_views', arguments: {} });
  assert.equal(JSON.parse(result.content[0].text).code, 'CLI_UNAVAILABLE');
});
