const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, deferred, loadSource } = require('./helpers/obsidian.cjs');
const { McpController, normalizeMcpSettings, clientConfigs } = loadSource('mcp-settings.js');
const token = 'a'.repeat(64);

function setup(t, options = {}) {
  const f = fixture(t);
  const servers = [];
  const controller = new McpController(f.plugin, {
    desktop: true,
    makeToken: () => token,
    factory: (settings) => {
      const server = {
        settings,
        started: false,
        stopped: false,
        async start() {
          this.started = true;
        },
        async stop() {
          this.stopped = true;
        },
      };
      servers.push(server);
      return server;
    },
    ...options,
  });
  return { ...f, controller, servers };
}

test('MCP is off on first load without creating any file', async (t) => {
  const { controller, writes, servers } = setup(t);
  await controller.load();
  assert.equal(controller.settings.enabled, false);
  assert.equal(writes.length, 0);
  assert.equal(servers.length, 0);
});

test('settings use mcp.json outside layouts and survive layout switches', async (t) => {
  const { controller, plugin, putLayout, writes, servers } = setup(t);
  await controller.update({ enabled: true });
  assert.equal(servers[0].started, true);
  assert.equal(controller.settings.token, token);
  assert.equal(writes[0].name, '.test-config/plugins/graphfrontier/mcp.json');
  assert.equal(JSON.stringify(plugin.data).includes(token), false);
  putLayout({ settings: { damping: 0.5 } }, 'another.json');
  await plugin.setActiveLayoutFile('another.json');
  assert.equal(controller.settings.token, token);
  assert.equal(controller.settings.enabled, true);
  await controller.update({ enabled: false });
  assert.equal(servers[0].stopped, true);
  assert.equal(controller.server, null);
});

test('malformed config fails closed and is never silently overwritten', async (t) => {
  const { controller, files, writes, servers } = setup(t);
  files.set(controller.path, '{broken');
  await controller.load();
  assert.equal(controller.loadFailed, true);
  await assert.rejects(controller.update({ enabled: true }), /Cannot read/);
  assert.equal(writes.length, 0);
  assert.equal(servers.length, 0);
});

test('mobile never reads credentials, loads Node modules, or starts a server', async (t) => {
  const { controller, reads, writes, servers } = setup(t, { desktop: false });
  await controller.load();
  await assert.rejects(controller.update({ enabled: true }), /desktop only/);
  assert.equal(reads.length, 0);
  assert.equal(writes.length, 0);
  assert.equal(servers.length, 0);
});

test('unload while a configuration write is pending cannot start a server later', async (t) => {
  const { controller, adapter, servers } = setup(t);
  const gate = deferred();
  const entered = deferred();
  adapter.write = async () => {
    entered.resolve();
    await gate.promise;
  };
  const changing = controller.update({ enabled: true });
  await entered.promise;
  await controller.stop();
  gate.resolve();
  await changing;
  assert.equal(servers.length, 0);
});

test('busy port does not reject plugin load and does not leave a server active', async (t) => {
  const { controller, files } = setup(t, {
    factory: () => ({
      async start() {
        throw Object.assign(new Error('in use'), { code: 'EADDRINUSE' });
      },
      async stop() {},
    }),
  });
  files.set(controller.path, JSON.stringify({ enabled: true, port: 27125, token }));
  await controller.load();
  assert.match(controller.error, /port is in use/);
  assert.equal(controller.server, null);
});

test('settings validation and client configs use a shared URL with no real credentials', () => {
  assert.throws(() => normalizeMcpSettings({ port: 80 }));
  assert.throws(() => normalizeMcpSettings({ enabled: 'yes' }));
  assert.throws(() => normalizeMcpSettings({ token: 'short' }));
  const configs = clientConfigs(27125);
  for (const value of Object.values(configs)) {
    assert.match(value, /http:\/\/127.0.0.1:27125\/mcp/);
    assert.match(value, /GRAPHFRONTIER_MCP_TOKEN/);
    assert.equal(value.includes(token), false);
  }
  assert.equal(JSON.parse(configs.claude).mcpServers.graphfrontier.type, 'http');
  assert.equal(JSON.parse(configs.opencode).mcp.graphfrontier.oauth, false);
});
