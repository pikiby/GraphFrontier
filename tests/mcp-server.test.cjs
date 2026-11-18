const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { createProtocolServer } = require('../src/mcp-server');
const { cliBridge } = require('../src/mcp-stdio');
const { fixture, loadSource } = require('./helpers/obsidian.cjs');
const { GraphFrontierApi } = loadSource('api.js');
const { McpController } = loadSource('mcp-settings.js');
async function setup(t) {
  const f = fixture(t);
  f.plugin.api = new GraphFrontierApi(f.plugin);
  const controller = new McpController(f.plugin, { desktop: true });
  const dir = '/vault/plugins/graphfrontier';
  f.adapter.getFullPath = () => dir;
  await controller.load();
  const url = cliBridge('vault', dir, async (command, argv, options) => {
    assert.equal(command, 'obsidian');
    assert.equal(options.shell, false);
    assert.deepEqual(argv.slice(0, 2), ['vault=vault', 'eval']);
    const input = argv[2].match(
      /^code=await app\.plugins\.plugins\.graphfrontier\.mcp\.dispatch\('([A-Za-z0-9+/=]+)'\)$/
    )[1];
    return { stdout: await controller.dispatch(input) };
  });
  return { ...f, url, controller };
}
async function client(t, bridge, name = 'integration-test') {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createProtocolServer(bridge, '1.0.0'),
    c = new Client({ name, version: '1.0.0' });
  await server.connect(a);
  await c.connect(b);
  t.after(() => c.close());
  return c;
}
test('same connection observes OFF and ON immediately', async (t) => {
  const { url, controller } = await setup(t),
    c = await client(t, url);
  const list = () => c.callTool({ name: 'list_views', arguments: {} });
  assert.ok((await list()).structuredContent.views);
  await controller.update({ enabled: false });
  assert.equal(JSON.parse((await list()).content[0].text).code, 'MCP_OFF');
  await controller.update({ enabled: true });
  assert.ok((await list()).structuredContent.views);
});
test('official SDK handshake, tools/list and all graph tools work over the CLI bridge', async (t) => {
  const { url, view, writes, preferences } = await setup(t);
  const c = await client(t, url);
  const tools = await c.listTools();
  assert.equal(tools.tools.length, 35);
  assert(tools.tools.some((tool) => tool.name === 'subgraph_nodes'));
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
