'use strict';

const nodeCrypto = require('node:crypto');
const path = require('node:path');

const { GraphFrontierMcpServer, GraphApiError } = require('../dist/mcp-node.cjs');

const SECRET_RE = /^[a-f0-9]{64}$/;
const RPC_TIMEOUT_MS = 55000;
const WAIT_CLIENT_MS = 1500;

function defaultMcpPortForKey(key) {
  const text = String(key || 'graphfrontier-standalone');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return 37125 + ((hash >>> 0) % 10000);
}

class McpHost {
  constructor({ vaultDir, stateStore, preferredPort, version = '0.9.7', getClient, sendEvent }) {
    this.vaultDir = path.resolve(vaultDir);
    this.stateStore = stateStore;
    this.preferredPort =
      preferredPort !== undefined && preferredPort !== null
        ? Number(preferredPort)
        : defaultMcpPortForKey(this.vaultDir);
    this.version = version;
    this.getClient = getClient;
    this.sendEvent = sendEvent;

    this.enabled = false;
    this.port = 0;
    this.secret = '';
    this.url = '';
    this.error = '';
    this.server = null;
    this.closed = false;
    this.pendingCalls = new Map();
    this.callSeq = 0;
    this.opQueue = Promise.resolve();
  }

  async waitForClient() {
    const first = this.getClient?.();
    if (first) return first;
    const deadline = Date.now() + WAIT_CLIENT_MS;
    while (Date.now() < deadline && !this.closed) {
      await new Promise((r) => setTimeout(r, 50));
      const client = this.getClient?.();
      if (client) return client;
    }
    return null;
  }

  async dispatchToolCall(method, args, readOnly, signal) {
    if (this.closed) throw new GraphApiError('API_CLOSED', 'GraphFrontier is closed.');
    if (signal?.aborted) throw new GraphApiError('REQUEST_CANCELLED', 'Request cancelled.');

    const client = await this.waitForClient();
    if (!client) {
      throw new GraphApiError(
        'VIEW_NOT_FOUND',
        'Open the GraphFrontier browser tab first before calling MCP tools.'
      );
    }

    const callId = `rpc-${++this.callSeq}-${Date.now().toString(36)}`;
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        this.pendingCalls.delete(callId);
      };
      const finishResolve = (val) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(val);
      };
      const finishReject = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      const onAbort = () => {
        try {
          this.sendEvent(client, 'mcp-abort', { callId });
        } catch {
          // Client may already have disconnected.
        }
        finishReject(new GraphApiError('REQUEST_CANCELLED', 'Request cancelled.'));
      };

      const timer = setTimeout(() => {
        finishReject(new GraphApiError('TIMEOUT', 'Browser graph view did not reply in time.'));
      }, RPC_TIMEOUT_MS);

      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      this.pendingCalls.set(callId, {
        clientId: client.clientId,
        resolve: finishResolve,
        reject: finishReject,
      });

      try {
        this.sendEvent(client, 'mcp-rpc', { callId, method, args, readOnly: !!readOnly });
      } catch {
        finishReject(new GraphApiError('VIEW_NOT_FOUND', 'Browser tab disconnected.'));
      }
    });
  }

  handleRpcResult(payload) {
    const entry = this.pendingCalls.get(payload?.callId);
    if (!entry) return false;
    if (payload.ok) {
      entry.resolve(payload.result);
    } else {
      const code = typeof payload.error?.code === 'string' ? payload.error.code : 'INTERNAL_ERROR';
      const msg = payload.error?.message || 'Graph operation failed.';
      entry.reject(new GraphApiError(code, msg));
    }
    return true;
  }

  cancelClientCalls(clientId) {
    for (const [callId, entry] of this.pendingCalls.entries()) {
      if (entry.clientId === clientId) {
        entry.reject(new GraphApiError('VIEW_NOT_FOUND', 'Browser tab disconnected.'));
        this.pendingCalls.delete(callId);
      }
    }
  }

  persistState(enabled) {
    const out = enabled
      ? { enabled: true, port: this.port, secret: this.secret, url: this.url }
      : {
          enabled: false,
          ...(this.port ? { port: this.port } : {}),
          ...(this.secret ? { secret: this.secret } : {}),
        };
    this.stateStore.writeMcpState(out);
  }

  async startServer() {
    await this.stopServer();
    if (this.closed) return;
    if (!SECRET_RE.test(this.secret)) {
      this.secret = nodeCrypto.randomBytes(32).toString('hex');
    }
    const api = {
      runTool: (method, args, readOnly, signal) =>
        this.dispatchToolCall(method, args, readOnly, signal),
    };
    const srv = new GraphFrontierMcpServer(
      api,
      { port: this.port || this.preferredPort, secret: this.secret },
      this.version
    );
    await srv.start();
    this.server = srv;
    this.port = srv.port;
    this.url = srv.url;
    this.enabled = true;
    this.error = '';
  }

  async stopServer() {
    const srv = this.server;
    this.server = null;
    if (srv) await srv.stop().catch(() => {});
    for (const [callId, entry] of this.pendingCalls.entries()) {
      entry.reject(new GraphApiError('API_CLOSED', 'MCP server stopped.'));
      this.pendingCalls.delete(callId);
    }
  }

  async init() {
    const stored = this.stateStore.readMcpState();
    if (stored && typeof stored.enabled === 'boolean') {
      if (SECRET_RE.test(stored.secret || '')) this.secret = stored.secret;
      if (this.preferredPort !== 0 && Number.isInteger(stored.port) && stored.port > 0) {
        this.port = stored.port;
      } else {
        this.port = this.preferredPort;
      }
      if (!stored.enabled) {
        this.enabled = false;
        this.url = '';
        return this.getStatus();
      }
    } else {
      this.port = this.preferredPort;
    }
    try {
      await this.startServer();
      this.persistState(true);
    } catch (error) {
      this.enabled = false;
      this.url = '';
      this.error = error?.message || 'Failed to start MCP server.';
    }
    return this.getStatus();
  }

  setEnabled(enabled) {
    const job = this.opQueue
      .catch(() => {})
      .then(async () => {
        if (this.closed) throw new Error('MCP host is closed.');
        if (!enabled) {
          this.enabled = false;
          this.url = '';
          this.error = '';
          await this.stopServer();
          this.persistState(false);
          return this.getStatus();
        }
        try {
          await this.startServer();
          this.persistState(true);
        } catch (error) {
          this.enabled = false;
          this.url = '';
          this.error = error?.message || 'Failed to start MCP server.';
        }
        return this.getStatus();
      });
    this.opQueue = job.catch(() => {});
    return job;
  }

  getStatus() {
    return {
      enabled: this.enabled,
      port: this.port,
      url: this.url,
      error: this.error,
    };
  }

  async close() {
    this.closed = true;
    this.enabled = false;
    this.url = '';
    await this.stopServer();
  }
}

module.exports = { McpHost, defaultMcpPortForKey };
