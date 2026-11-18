const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, deferred, loadSource } = require('./helpers/obsidian.cjs');
const { McpController } = loadSource('mcp-settings.js');
function setup(t, options = {}) {
  const f = fixture(t);
  return { ...f, controller: new McpController(f.plugin, { desktop: true, ...options }) };
}
test('fresh desktop install enables MCP without writing credentials', async (t) => {
  const { controller, writes } = setup(t);
  await controller.load();
  assert.equal(controller.enabled, true);
  assert.equal(writes.length, 0);
});
for (const enabled of [true, false])
  test('legacy preference preserves ' + enabled + ' and drops credentials', async (t) => {
    const { files, controller } = setup(t);
    files.set(controller.path, JSON.stringify({ enabled, port: 27125, token: 'obsolete' }));
    await controller.load();
    assert.equal(controller.enabled, enabled);
    assert.deepEqual(JSON.parse(files.get(controller.path)), { enabled });
  });
test('OFF survives a restart', async (t) => {
  const { controller, plugin } = setup(t);
  await controller.load();
  await controller.update({ enabled: false });
  const next = new McpController(plugin, { desktop: true });
  await next.load();
  assert.equal(next.enabled, false);
});
test('malformed config fails closed and is never silently overwritten', async (t) => {
  const { controller, files, writes } = setup(t);
  files.set(controller.path, '{broken');
  await controller.load();
  assert.equal(controller.loadFailed, true);
  await assert.rejects(controller.update({ enabled: true }), /Cannot load/);
  assert.equal(writes.length, 0);
  assert.equal(controller.enabled, false);
});

test('mobile never reads credentials, loads Node modules, or starts a server', async (t) => {
  const { controller, reads, writes } = setup(t, { desktop: false });
  await controller.load();
  await assert.rejects(controller.update({ enabled: true }), /unavailable/);
  assert.equal(reads.length, 0);
  assert.equal(writes.length, 0);
  assert.equal(controller.enabled, false);
});

test('unload while a configuration write is pending cannot start a server later', async (t) => {
  const { controller, adapter } = setup(t);
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
  assert.equal(controller.enabled, false);
});
