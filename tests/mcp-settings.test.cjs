const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { fixture, deferred, loadSource } = require('./helpers/obsidian.cjs');
const { McpController } = loadSource('mcp-settings.js');

function setup(t, options = {}) {
  const f = fixture(t);
  const controller = new McpController(f.plugin, {
    desktop: true,
    defaultPort: 0,
    ...options,
  });
  t.after(() => controller.stop());
  return { ...f, controller };
}

test('fresh desktop install enables MCP, starts local server, and writes URL to mcp.json', async (t) => {
  const { controller, files, writes } = setup(t);
  await controller.load();
  assert.equal(controller.enabled, true);
  assert.ok(controller.port > 0);
  assert.match(controller.secret, /^[a-f0-9]{64}$/);
  assert.equal(controller.url, `http://127.0.0.1:${controller.port}/mcp/${controller.secret}`);
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(files.get(controller.path)), {
    enabled: true,
    port: controller.port,
    secret: controller.secret,
    url: controller.url,
  });
});

test('legacy preference drops obsolete token, adopts 64-hex token as secret, and omits url when disabled', async (t) => {
  {
    const { files, controller } = setup(t);
    files.set(
      controller.path,
      JSON.stringify({ enabled: false, port: 27125, token: 'obsolete', url: 'http://stale' })
    );
    await controller.load();
    assert.equal(controller.enabled, false);
    assert.equal(controller.server, null);
    assert.deepEqual(JSON.parse(files.get(controller.path)), { enabled: false, port: 27125 });
  }
  {
    const { files, controller } = setup(t);
    const hexToken = 'a'.repeat(64);
    files.set(controller.path, JSON.stringify({ enabled: false, port: 27125, token: hexToken }));
    await controller.load();
    assert.equal(controller.enabled, false);
    assert.deepEqual(JSON.parse(files.get(controller.path)), {
      enabled: false,
      port: 27125,
      secret: hexToken,
    });
  }
  {
    const { files, controller } = setup(t);
    const hexToken = 'b'.repeat(64);
    files.set(controller.path, JSON.stringify({ enabled: true, token: hexToken }));
    await controller.load();
    assert.equal(controller.enabled, true);
    assert.equal(controller.secret, hexToken);
    const stored = JSON.parse(files.get(controller.path));
    assert.equal(stored.token, undefined);
    assert.equal(stored.secret, hexToken);
    assert.equal(stored.url, `http://127.0.0.1:${stored.port}/mcp/${hexToken}`);
  }
});

test('toggling OFF stops server and removes url, ON restores the same url, and OFF survives restart', async (t) => {
  const { controller, plugin, files } = setup(t);
  await controller.load();
  const firstUrl = controller.url;
  const firstPort = controller.port;
  const firstSecret = controller.secret;

  const aliveRes = await fetch(firstUrl, { method: 'POST' });
  assert.equal(aliveRes.status, 415);

  await controller.update({ enabled: false });
  assert.equal(controller.enabled, false);
  assert.equal(controller.url, '');
  assert.equal(controller.server, null);
  assert.deepEqual(JSON.parse(files.get(controller.path)), {
    enabled: false,
    port: firstPort,
    secret: firstSecret,
  });
  await assert.rejects(fetch(firstUrl, { method: 'POST' }));

  const next = new McpController(plugin, { desktop: true, defaultPort: 0 });
  t.after(() => next.stop());
  await next.load();
  assert.equal(next.enabled, false);
  assert.equal(next.server, null);
  assert.equal(next.url, '');

  await next.update({ enabled: true });
  assert.equal(next.enabled, true);
  assert.equal(next.port, firstPort);
  assert.equal(next.secret, firstSecret);
  assert.equal(next.url, firstUrl);
  assert.equal(JSON.parse(files.get(next.path)).url, firstUrl);
});

test('port collision on preferred port automatically falls back to a free loopback port', async (t) => {
  const blocker = http.createServer((_req, res) => res.end());
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => blocker.close(resolve)));
  const takenPort = blocker.address().port;

  const { controller, files } = setup(t, { defaultPort: takenPort });
  await controller.load();
  assert.equal(controller.enabled, true);
  assert.notEqual(controller.port, takenPort);
  assert.ok(controller.port > 0);
  const stored = JSON.parse(files.get(controller.path));
  assert.equal(stored.port, controller.port);
  assert.equal(stored.url, controller.url);
});

test('malformed config fails closed and is never silently overwritten', async (t) => {
  for (const raw of [
    '{broken',
    JSON.stringify({ enabled: true, port: 80 }),
    JSON.stringify({ enabled: true, secret: 'too-short' }),
  ]) {
    const { controller, files, writes } = setup(t);
    files.set(controller.path, raw);
    await controller.load();
    assert.equal(controller.loadFailed, true);
    assert.equal(controller.server, null);
    await assert.rejects(controller.update({ enabled: true }), /Cannot load/);
    assert.equal(writes.length, 0);
    assert.equal(controller.enabled, false);
  }
});

test('mobile never reads credentials, loads Node modules, or starts a server', async (t) => {
  const { controller, reads, writes } = setup(t, { desktop: false });
  await controller.load();
  await assert.rejects(controller.update({ enabled: true }), /unavailable/);
  assert.equal(reads.length, 0);
  assert.equal(writes.length, 0);
  assert.equal(controller.enabled, false);
  assert.equal(controller.server, null);
});

test('unload while a configuration write is pending cannot leave a server running', async (t) => {
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
  assert.equal(controller.server, null);
  assert.equal(controller.url, '');
});
