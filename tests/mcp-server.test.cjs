const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const {
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { GraphFrontierMcpServer } = require('../src/mcp-server');
const { GraphFrontierApi } = require('../src/api');
const { fixture } = require('./helpers/obsidian.cjs');
const token = 'a'.repeat(64);

async function setup(t) {
  const f = fixture(t);
  f.plugin.api = new GraphFrontierApi(f.plugin);
  const server = new GraphFrontierMcpServer(f.plugin.api, { port: 0, token }, '0.7.7');
  await server.start();
  t.after(() => server.stop());
  const url = `http://127.0.0.1:${server.port}/mcp`;
  return { ...f, server, url };
}

async function client(t, url, name = 'integration-test') {
  const connection = new Client({ name, version: '1.0.0' });
  await connection.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    })
  );
  t.after(() => connection.close());
  return connection;
}

function request(url, body, headers = {}, method = 'POST') {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json, text/event-stream',
          'Content-Type': 'application/json',
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, text }));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

test('official SDK handshake, tools/list and all graph tools work over authenticated HTTP', async (t) => {
  const { url, view, writes, preferences } = await setup(t);
  const c = await client(t, url);
  const tools = await c.listTools();
  assert.equal(tools.tools.length, 32);
  const call = (name, args = {}) => c.callTool({ name, arguments: args });
  const listed = await call('list_views');
  const ref = listed.structuredContent.views[0];
  assert.equal(JSON.stringify(listed).includes(token), false);
  assert.equal((await call('get_state', { viewId: ref.viewId })).structuredContent.nodeCount, 1);
  assert.equal(
    (await call('get_graph', { viewId: ref.viewId })).structuredContent.items[0].id,
    'alpha.md'
  );
  const args = { viewId: ref.viewId, contextToken: ref.contextToken, nodeIds: ['alpha.md'] };
  assert.equal((await call('select_nodes', args)).isError, undefined);
  assert.deepEqual(
    (await call('get_selection', { viewId: ref.viewId })).structuredContent.nodeIds,
    ['alpha.md']
  );
  assert.equal((await call('frame_nodes', args)).isError, undefined);
  assert.equal(view.camera.x, 25);
  assert.equal(writes.length, 0);
  assert.equal(preferences.length, 0);
});

test('extended tools validate schemas and await async file operations through the real protocol', async (t) => {
  const { url, plugin, files, view } = await setup(t);
  const c = await client(t, url);
  const call = (name, args = {}) => c.callTool({ name, arguments: args });
  const state = (await call('list_views')).structuredContent.views[0];
  const ref = { viewId: state.viewId, contextToken: state.contextToken };
  const tools = (await c.listTools()).tools;
  assert.equal(tools.find((t) => t.name === 'delete_layout').annotations.destructiveHint, true);
  assert.equal(tools.find((t) => t.name === 'get_configuration').annotations.readOnlyHint, true);
  const changed = await call('update_settings', {
    ...ref,
    settings: { node_color: '#aa0000', layout_autosave: false },
  });
  assert.equal(changed.structuredContent.settings.node_color, '#aa0000');
  const invalid = await call('update_settings', { ...ref, settings: { damping: 200 } });
  assert.equal(invalid.isError, true);
  assert.notEqual(plugin.getSettings().damping, 200);
  const created = await call('create_layout', { ...ref, name: 'protocol-copy', activate: false });
  assert.equal(created.isError, undefined);
  assert.equal(created.structuredContent.created, 'protocol-copy.json');
  assert.ok(files.has(plugin.getLayoutFileRelativePath('protocol-copy')));
  const backup = await call('backup_layout', { ...ref, name: 'protocol-copy' });
  assert.ok(backup.structuredContent.backupId);
  const camera = await call('set_camera', { ...ref, camera: { x: 50, y: 60, zoom: 2 } });
  assert.equal(camera.structuredContent.camera.x, 50);
  assert.equal(view.camera.x, 50);
  const original = plugin.writeLayoutFileData;
  plugin.writeLayoutFileData = async () => false;
  const failed = await call('create_layout', { ...ref, name: 'failed', activate: false });
  assert.equal(failed.isError, true);
  assert.equal(JSON.parse(failed.content[0].text).code, 'LAYOUT_WRITE_FAILED');
  plugin.writeLayoutFileData = original;
});

test('invalid token, host, origin, content type, JSON and oversized body are rejected', async (t) => {
  const { url } = await setup(t);
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  for (const [headers, status] of [
    [{ Authorization: '' }, 401],
    [{ Authorization: 'Bearer bad' }, 401],
    [{ Host: 'attacker.example' }, 403],
    [{ Origin: 'https://attacker.example' }, 403],
    [{ 'Content-Type': 'text/plain' }, 415],
  ])
    assert.equal((await request(url, body, headers)).status, status);
  assert.equal((await request(url, '{bad')).status, 400);
  assert.equal((await request(url, 'x'.repeat(70000), { 'Content-Length': '70000' })).status, 413);
  assert.equal((await request(url, undefined, {}, 'GET')).status, 405);
  assert.equal((await request(url + '/unknown', body)).status, 404);
});

test('stateless connections support several clients without message-ID collisions', async (t) => {
  const { url } = await setup(t);
  const a = await client(t, url, 'client-a');
  const b = await client(t, url, 'client-b');
  // Independent clients can reuse request IDs, since transports are per request.
  const toolsA = await a.listTools();
  const toolsB = await b.listTools();
  assert.deepEqual(toolsA, toolsB);
  await a.close();
  assert.equal((await b.callTool({ name: 'list_views', arguments: {} })).isError, undefined);
});

test('tool errors are reported as MCP errors without exposing internals', async (t) => {
  const { url, view, plugin } = await setup(t);
  const c = await client(t, url);
  const listed = await c.callTool({ name: 'list_views', arguments: {} });
  const ref = listed.structuredContent.views[0];
  plugin.data = plugin.normalizeData(plugin.data);
  const stale = await c.callTool({
    name: 'select_nodes',
    arguments: { viewId: ref.viewId, contextToken: ref.contextToken, nodeIds: [] },
  });
  assert.equal(stale.isError, true);
  assert.equal(JSON.parse(stale.content[0].text).code, 'STATE_CHANGED');
  view.isOpen = false;
  const empty = await c.callTool({ name: 'list_views', arguments: {} });
  assert.deepEqual(empty.structuredContent.views, []);
  const missing = await c.callTool({ name: 'get_state', arguments: { viewId: ref.viewId } });
  assert.equal(JSON.parse(missing.content[0].text).code, 'VIEW_NOT_FOUND');
  const invalid = await c.callTool({
    name: 'get_graph',
    arguments: { viewId: ref.viewId, limit: 10000 },
  });
  assert.equal(invalid.isError, true);
});

test('supports commonly deployed protocol revisions; unload frees the port', async (t) => {
  const { url, server, plugin } = await setup(t);
  for (const protocolVersion of ['2025-03-26', '2025-06-18', '2025-11-25']) {
    const initialized = await request(
      url,
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion, capabilities: {}, clientInfo: { name: 'test', version: '1' } },
      })
    );
    assert.equal(initialized.status, 200);
    assert.equal(JSON.parse(initialized.text).result.protocolVersion, protocolVersion);
  }
  const port = server.port;
  await server.stop();
  const second = new GraphFrontierMcpServer(plugin.api, { port, token });
  await second.start();
  t.after(() => second.stop());
  assert.equal(second.port, port);
});

test('occupied ports fail cleanly without disturbing the existing server', async (t) => {
  const { server, plugin, url } = await setup(t);
  const duplicate = new GraphFrontierMcpServer(plugin.api, { port: server.port, token });
  await assert.rejects(duplicate.start(), { code: 'EADDRINUSE' });
  await duplicate.stop();
  const c = await client(t, url);
  assert.equal((await c.listTools()).tools.length, 32);
});

test('stop during startup settles without leaking a listener', { timeout: 2000 }, async () => {
  const server = new GraphFrontierMcpServer({}, { port: 0, token });
  const starting = server.start();
  const rejected = assert.rejects(starting, /cancelled/);
  await server.stop();
  await rejected;
  assert.equal(server.httpServer, null);
});

test('rate limit rejects excess authenticated requests and resets its window', async (t) => {
  const { server, url } = await setup(t);
  server.rateStart = Date.now();
  server.rateCount = 120;
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal((await request(url, body)).status, 429);
  server.rateStart = 0;
  assert.equal((await request(url, body)).status, 200);
  server.activeRequests = 8;
  assert.equal((await request(url, body)).status, 429);
  server.activeRequests = 0;
});
