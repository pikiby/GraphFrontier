'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { indexVault } = require('./indexer.cjs');
const { StateStore } = require('./state-store.cjs');
const { McpHost } = require('./mcp-host.cjs');

const STANDALONE_ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(STANDALONE_ROOT, 'dist');
const ICONS_PATH = path.join(STANDALONE_ROOT, 'src', 'icons.json');

const MAX_BODY_BYTES = 32 * 1024 * 1024;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const contentLength = Number(req.headers['content-length']);
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      reject(Object.assign(new Error('Payload too large'), { status: 413 }));
      return;
    }
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', (err) => reject(err));
  });
}

function sendJson(res, status, data, extraHeaders = {}) {
  if (res.headersSent || res.destroyed) return;
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body, 'utf8');
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  });
  res.end(text, 'utf8');
}

function buildShellHtml(vaultName) {
  const safeTitle = String(vaultName || 'GraphFrontier')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>GraphFrontier — ${safeTitle}</title>
  <link rel="stylesheet" href="/dist/standalone.css" />
  <style id="gf-vault-theme"></style>
</head>
<body>
  <div id="graphfrontier-root"></div>
  <script src="/dist/standalone-bundle.js"></script>
</body>
</html>
`;
}

function validateVaultNoteRelPath(vaultDir, vaultRealDir, rawPath) {
  const normalized = String(rawPath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/+/g, '/');
  if (!normalized || normalized.includes('\0')) return null;
  const parts = normalized.split('/');
  if (
    parts.some((p) => !p || p === '.' || p === '..' || p.startsWith('.') || p === 'node_modules')
  ) {
    return null;
  }
  const resolved = path.resolve(vaultDir, normalized);
  if (!resolved.startsWith(vaultDir + path.sep)) return null;
  try {
    const real = fs.realpathSync(resolved);
    if (!real.startsWith(vaultRealDir + path.sep)) return null;
    return { normalized, real };
  } catch {
    return null;
  }
}

async function startStandaloneServer(options = {}) {
  const vaultDir = path.resolve(options.vaultDir || process.cwd());
  if (!fs.existsSync(vaultDir) || !fs.statSync(vaultDir).isDirectory()) {
    throw new Error(`Vault directory does not exist: ${vaultDir}`);
  }
  const vaultRealDir = fs.realpathSync(vaultDir);
  const port = options.port !== undefined && options.port !== null ? Number(options.port) : 8790;
  const readOnly = !!options.readOnly;
  const watchEnabled = options.watch !== false;

  const icons = JSON.parse(fs.readFileSync(ICONS_PATH, 'utf8'));
  const stateStore = new StateStore({
    vaultDir,
    readOnly,
    stateDir: options.stateDir || null,
    useObsidianConfig: !!options.useObsidianConfig,
  });

  let currentIndex = indexVault(vaultDir);
  let snapshotJsonCache = null;

  const buildSnapshotObject = () => ({
    manifest: stateStore.manifest,
    vaultName: currentIndex.vaultName,
    vaultPath: vaultDir,
    configDir: '.obsidian',
    readOnly: stateStore.readOnly,
    pluginData: stateStore.getPluginData(),
    pluginFiles: stateStore.getPluginFilesObject(),
    files: currentIndex.files,
    caches: currentIndex.caches,
    resolvedLinks: currentIndex.resolvedLinks,
    unresolvedLinks: currentIndex.unresolvedLinks,
    icons,
    bodyClasses: currentIndex.bodyClasses,
    themeName: currentIndex.themeName,
    vaultThemeCss: currentIndex.vaultThemeCss,
  });

  const sseClients = new Map();
  let nextClientSeq = 0;
  const sockets = new Set();

  const sendSseEvent = (client, eventName, dataObj) => {
    if (!client?.res || client.res.destroyed || client.res.writableEnded) return;
    client.res.write(`event: ${eventName}\ndata: ${JSON.stringify(dataObj)}\n\n`);
  };

  const broadcastEvent = (eventName, dataObj) => {
    for (const client of sseClients.values()) {
      sendSseEvent(client, eventName, dataObj);
    }
  };

  const getLatestClient = () => {
    let latest = null;
    for (const client of sseClients.values()) {
      if (!client.res.destroyed && !client.res.writableEnded) latest = client;
    }
    return latest;
  };

  const mcpHost = new McpHost({
    vaultDir,
    stateStore,
    preferredPort: options.mcpPort,
    version: stateStore.manifest.version || '0.9.7',
    getClient: getLatestClient,
    sendEvent: sendSseEvent,
  });
  await mcpHost.init();

  let boundPort = 0;

  const isAllowedApiRequest = (req) => {
    const allowedHosts = new Set([`127.0.0.1:${boundPort}`, `localhost:${boundPort}`]);
    if (!allowedHosts.has(req.headers.host)) return false;
    if (req.headers.origin !== undefined) {
      const allowedOrigins = new Set([
        `http://127.0.0.1:${boundPort}`,
        `http://localhost:${boundPort}`,
      ]);
      if (!allowedOrigins.has(req.headers.origin)) return false;
    }
    return true;
  };

  const server = http.createServer(async (req, res) => {
    try {
      const reqUrl = new URL(
        req.url || '/',
        `http://${req.headers.host || `127.0.0.1:${boundPort}`}`
      );
      const pathname = reqUrl.pathname;

      if (pathname === '/' || pathname === '/index.html') {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
        return sendText(
          res,
          200,
          buildShellHtml(currentIndex.vaultName),
          'text/html; charset=utf-8'
        );
      }

      if (pathname === '/dist/standalone.css') {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
        return sendText(
          res,
          200,
          fs.readFileSync(path.join(DIST_DIR, 'standalone.css'), 'utf8'),
          'text/css; charset=utf-8'
        );
      }

      if (pathname === '/dist/standalone-bundle.js') {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
        return sendText(
          res,
          200,
          fs.readFileSync(path.join(DIST_DIR, 'standalone-bundle.js'), 'utf8'),
          'application/javascript; charset=utf-8'
        );
      }

      if (pathname.startsWith('/api/')) {
        if (!isAllowedApiRequest(req)) {
          return sendJson(res, 403, { error: 'Forbidden host or origin' });
        }

        if (pathname === '/api/snapshot' && req.method === 'GET') {
          if (!snapshotJsonCache) snapshotJsonCache = JSON.stringify(buildSnapshotObject());
          return sendText(res, 200, snapshotJsonCache, 'application/json; charset=utf-8');
        }

        if (pathname === '/api/note' && req.method === 'GET') {
          const targetParam = reqUrl.searchParams.get('path') || '';
          const valid = validateVaultNoteRelPath(vaultDir, vaultRealDir, targetParam);
          if (!valid) return sendJson(res, 403, { error: 'Invalid note path' });
          try {
            const text = fs.readFileSync(valid.real, 'utf8');
            return sendText(res, 200, text, 'text/plain; charset=utf-8');
          } catch {
            return sendJson(res, 404, { error: 'Note not found' });
          }
        }

        if (pathname === '/api/notes-all' && req.method === 'GET') {
          const map = {};
          for (const f of currentIndex.files) {
            if (!f.path.toLowerCase().endsWith('.md')) continue;
            const valid = validateVaultNoteRelPath(vaultDir, vaultRealDir, f.path);
            if (!valid) continue;
            try {
              map[f.path] = fs.readFileSync(valid.real, 'utf8');
            } catch {
              // Skip unreadable file.
            }
          }
          return sendJson(res, 200, map);
        }

        if (pathname === '/api/plugin-data' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const result = stateStore.savePluginData(body);
          snapshotJsonCache = null;
          return sendJson(res, 200, result);
        }

        if (pathname === '/api/adapter' && req.method === 'POST') {
          const body = await readJsonBody(req);
          let result;
          if (body.op === 'write') result = stateStore.adapterWrite(body.path, body.content);
          else if (body.op === 'remove') result = stateStore.adapterRemove(body.path);
          else if (body.op === 'rename') result = stateStore.adapterRename(body.from, body.to);
          else if (body.op === 'mkdir') result = stateStore.adapterMkdir(body.path);
          else return sendJson(res, 400, { error: 'Unsupported adapter op' });
          snapshotJsonCache = null;
          return sendJson(res, 200, result);
        }

        if (pathname === '/api/mcp' && req.method === 'GET') {
          return sendJson(res, 200, mcpHost.getStatus());
        }

        if (pathname === '/api/mcp' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const status = await mcpHost.setEnabled(!!body.enabled);
          return sendJson(res, 200, status);
        }

        if (pathname === '/api/mcp-rpc-result' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const handled = mcpHost.handleRpcResult(body);
          return sendJson(res, 200, { handled });
        }

        if (pathname === '/api/events' && req.method === 'GET') {
          const clientId = reqUrl.searchParams.get('clientId') || `sse-${++nextClientSeq}`;
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          res.write(`retry: 1000\n\n`);
          const client = { clientId, res };
          sseClients.set(clientId, client);
          req.on('close', () => {
            sseClients.delete(clientId);
            mcpHost.cancelClientCalls(clientId);
          });
          return;
        }
      }

      return sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      return sendJson(res, status, { error: error?.message || 'Internal error' });
    }
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  boundPort = server.address().port;
  const url = `http://127.0.0.1:${boundPort}`;

  const heartbeat = setInterval(() => {
    for (const client of sseClients.values()) {
      if (!client.res.destroyed && !client.res.writableEnded) client.res.write(': ping\n\n');
    }
  }, 20000);
  heartbeat.unref();

  let watcher = null;
  let reindexTimer = null;
  const triggerReindex = () => {
    const prevMtimes = new Map(currentIndex.files.map((f) => [f.path, f.mtime]));
    const nextIndex = indexVault(vaultDir);
    const nextMtimes = new Map(nextIndex.files.map((f) => [f.path, f.mtime]));
    const changed = [];
    const removed = [];
    for (const [p, mtime] of nextMtimes.entries()) {
      if (prevMtimes.get(p) !== mtime) changed.push(p);
    }
    for (const p of prevMtimes.keys()) {
      if (!nextMtimes.has(p)) removed.push(p);
    }
    currentIndex = nextIndex;
    snapshotJsonCache = null;
    if (changed.length || removed.length) {
      broadcastEvent('vault-update', {
        files: nextIndex.files,
        caches: nextIndex.caches,
        resolvedLinks: nextIndex.resolvedLinks,
        unresolvedLinks: nextIndex.unresolvedLinks,
        changed,
        removed,
        mcpState: mcpHost.getStatus(),
      });
    }
    return { changed, removed };
  };

  if (watchEnabled) {
    try {
      watcher = fs.watch(vaultDir, { recursive: true }, (_eventType, filename) => {
        if (!filename) return;
        const rel = String(filename).replace(/\\/g, '/');
        if (rel.split('/').some((part) => part.startsWith('.') || part === 'node_modules')) {
          return;
        }
        if (reindexTimer) clearTimeout(reindexTimer);
        reindexTimer = setTimeout(() => {
          reindexTimer = null;
          triggerReindex();
        }, 250);
      });
      watcher.on('error', () => {});
    } catch {
      watcher = null;
    }
  }

  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    clearInterval(heartbeat);
    if (reindexTimer) clearTimeout(reindexTimer);
    if (watcher) watcher.close();
    for (const client of sseClients.values()) {
      try {
        client.res.end();
      } catch {
        // Ignore.
      }
    }
    sseClients.clear();
    await mcpHost.close();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(() => resolve()));
  }

  return {
    port: boundPort,
    url,
    vaultDir,
    readOnly,
    stateStore,
    mcpHost,
    getIndex: () => currentIndex,
    triggerReindex,
    close,
  };
}

module.exports = { startStandaloneServer };
