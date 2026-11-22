const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const {
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { fixture, loadSource } = require('./helpers/obsidian.cjs');
const { GraphFrontierApi } = loadSource('api.js');
const { McpController } = loadSource('mcp-settings.js');

async function setup(t) {
  const f = fixture(t);
  f.plugin.api = new GraphFrontierApi(f.plugin);
  const controller = new McpController(f.plugin, { desktop: true, defaultPort: 0 });
  t.after(() => controller.stop());
  await controller.load();
  return { ...f, url: controller.url, controller };
}

async function client(t, url, name = 'integration-test') {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const c = new Client({ name, version: '1.0.0' });
  await c.connect(transport);
  t.after(() => c.close());
  return c;
}

function rawRequest({ port, method = 'POST', path, headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('same connection observes OFF and ON immediately', async (t) => {
  const { url, controller } = await setup(t);
  const c = await client(t, url);
  const list = () => c.callTool({ name: 'list_views', arguments: {} });
  assert.ok((await list()).structuredContent.views);
  await controller.update({ enabled: false });
  await assert.rejects(list());
  await controller.update({ enabled: true });
  assert.equal(controller.url, url);
  assert.ok((await list()).structuredContent.views);
});

test('official SDK handshake, tools/list and all graph tools work over loopback HTTP', async (t) => {
  const { url, view, writes, preferences } = await setup(t);
  const c = await client(t, url);
  const tools = await c.listTools();
  assert.equal(tools.tools.length, 37);
  assert(tools.tools.some((tool) => tool.name === 'subgraph_nodes'));
  assert(tools.tools.some((tool) => tool.name === 'edit_links'));
  assert(tools.tools.some((tool) => tool.name === 'edit_annotations'));
  const call = (name, args = {}) => c.callTool({ name, arguments: args });
  const listed = await call('list_views');
  const ref = listed.structuredContent.views[0];
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
  assert.equal(writes.length, 1);
  assert.equal(preferences.length, 0);
});

test('extended tools validate schemas and await async file operations through the real protocol', async (t) => {
  const { url, plugin, files, view } = await setup(t);
  const c = await client(t, url);
  const call = (name, args = {}) => c.callTool({ name, arguments: args });
  const state = (await call('list_views')).structuredContent.views[0];
  const ref = { viewId: state.viewId, contextToken: state.contextToken };
  const tools = (await c.listTools()).tools;
  assert.equal(
    tools.find((tool) => tool.name === 'delete_layout').annotations.destructiveHint,
    true
  );
  assert.equal(
    tools.find((tool) => tool.name === 'get_configuration').annotations.readOnlyHint,
    true
  );
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

test('stateless connections support several clients without message-ID collisions', async (t) => {
  const { url } = await setup(t);
  const a = await client(t, url, 'client-a');
  const b = await client(t, url, 'client-b');
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

test('HTTP security boundaries enforce host, origin, secret path, method, content-type and size', async (t) => {
  const { controller } = await setup(t);
  const port = controller.port;
  const validPath = '/mcp/' + controller.secret;
  const wrongPath =
    '/mcp/' + (controller.secret[0] === '0' ? '1' : '0') + controller.secret.slice(1);
  const baseHeaders = { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json' };

  assert.equal(
    (await rawRequest({ port, path: '/mcp', headers: baseHeaders, body: '{}' })).status,
    404
  );
  assert.equal(
    (await rawRequest({ port, path: wrongPath, headers: baseHeaders, body: '{}' })).status,
    404
  );
  assert.equal(
    (
      await rawRequest({
        port,
        path: validPath,
        headers: { Host: `evil.example:${port}`, 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).status,
    403
  );
  assert.equal(
    (
      await rawRequest({
        port,
        path: validPath,
        headers: { ...baseHeaders, Origin: 'http://evil.example' },
        body: '{}',
      })
    ).status,
    403
  );
  const getRes = await rawRequest({
    port,
    method: 'GET',
    path: validPath,
    headers: { Host: `127.0.0.1:${port}` },
  });
  assert.equal(getRes.status, 405);
  assert.equal(getRes.headers.allow, 'POST');
  assert.equal(
    (
      await rawRequest({
        port,
        method: 'DELETE',
        path: validPath,
        headers: { Host: `127.0.0.1:${port}` },
      })
    ).status,
    405
  );
  assert.equal(
    (
      await rawRequest({
        port,
        path: validPath,
        headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'text/plain' },
        body: '{}',
      })
    ).status,
    415
  );
  assert.equal(
    (await rawRequest({ port, path: validPath, headers: baseHeaders, body: '{bad' })).status,
    400
  );
  assert.equal(
    (
      await rawRequest({
        port,
        path: validPath,
        headers: baseHeaders,
        body: JSON.stringify({ pad: 'x'.repeat(65 * 1024) }),
      })
    ).status,
    413
  );
});
