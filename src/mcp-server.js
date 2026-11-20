import { Platform } from 'obsidian';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';
import { tools } from './mcp-definitions.js';
import { GraphApiError } from './api-errors.js';

const MAX_BODY = 64 * 1024;
const MAX_RESPONSE = 2 * 1024 * 1024;
const REQUEST_TIMEOUT = 60000;
const MAX_CONCURRENT = 8;
const MAX_REQUESTS = 120;
const SECRET_RE = /^[a-f0-9]{64}$/;
const encoder = new TextEncoder();

async function loadDesktopNode() {
  if (!Platform.isDesktop) throw new Error('MCP requires desktop Obsidian.');
  const [http, crypto] = await Promise.all([import('node:http'), import('node:crypto')]);
  return { http, crypto };
}

function createProtocolServer(api, version) {
  const server = new McpServer(
    { name: 'graphfrontier', version },
    {
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
      instructions:
        'Control GraphFrontier in this vault. Start with list_views, then get_configuration. Use current viewId/contextToken; refresh them after graph/layout changes. All global and node settings, lists, gravity, layouts, backups and HTML export are available. Saved layouts are automatically backed up before replacement/deletion. No arbitrary code execution. An export may contain note text; use includeContents=false when not requested. Only perform writes/deletions/exports requested by the user. Native third-party Obsidian menu callbacks are not exposed.',
    }
  );
  for (const { name, description, schema, method, readOnly: readOnlyHint, destructive } of tools) {
    server.registerTool(
      name,
      {
        description,
        inputSchema: schema,
        annotations: {
          readOnlyHint,
          destructiveHint: destructive,
          idempotentHint: readOnlyHint,
          openWorldHint: ['export_html', 'node_action'].includes(name),
        },
      },
      async (args, extra) => {
        try {
          const result = await (api.runTool
            ? api.runTool(method, args, readOnlyHint, extra.signal)
            : api[method](args));
          const text = JSON.stringify(result);
          if (encoder.encode(text).byteLength > MAX_RESPONSE)
            throw new GraphApiError('RESPONSE_TOO_LARGE', 'Request a smaller page.');
          return { content: [{ type: 'text', text }], structuredContent: result };
        } catch (error) {
          const result =
            error instanceof GraphApiError
              ? { code: error.code, message: error.message }
              : { code: 'INTERNAL_ERROR', message: 'Graph operation failed.' };
          return { isError: true, content: [{ type: 'text', text: JSON.stringify(result) }] };
        }
      }
    );
  }
  return server;
}

class GraphFrontierMcpServer {
  constructor(api, { port = 0, secret } = {}, version = '0.0.0') {
    if (typeof secret !== 'string' || !SECRET_RE.test(secret)) {
      throw new Error('Invalid MCP secret.');
    }
    this.api = api;
    this.preferredPort = Number.isInteger(port) && port >= 0 && port <= 65535 ? port : 0;
    this.secret = secret;
    this.version = version;
    this.port = 0;
    this.expectedPath = '/mcp/' + secret;
    this.expectedBytes = encoder.encode(this.expectedPath);
    this.url = '';
    this.closed = false;
    this.httpServer = null;
    this.timingSafeEqual = null;
    this.sockets = new Set();
    this.protocols = new Set();
    this.aborters = new Set();
    this.activeRequests = 0;
    this.rateStart = 0;
    this.rateCount = 0;
  }

  async start() {
    if (this.closed) throw new Error('MCP startup cancelled.');
    const { http, crypto } = await loadDesktopNode();
    this.timingSafeEqual = crypto.timingSafeEqual;

    const listenOn = (portToTry) =>
      new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
          void this.handle(req, res);
        });
        server.unref();
        server.on('connection', (socket) => {
          this.sockets.add(socket);
          socket.on('close', () => this.sockets.delete(socket));
        });
        const onError = (error) => {
          server.removeListener('listening', onListening);
          server.close(() => {});
          reject(error);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          resolve(server);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(portToTry, '127.0.0.1');
      });

    let server;
    try {
      server = await listenOn(this.preferredPort);
    } catch (error) {
      if (this.preferredPort !== 0 && (error?.code === 'EADDRINUSE' || error?.code === 'EACCES')) {
        server = await listenOn(0);
      } else {
        throw error;
      }
    }

    this.httpServer = server;
    if (this.closed) {
      await this.stop();
      throw new Error('MCP startup cancelled.');
    }
    this.port = this.httpServer.address().port;
    this.url = 'http://127.0.0.1:' + this.port + this.expectedPath;
    return this;
  }

  async stop() {
    this.closed = true;
    for (const aborter of this.aborters) aborter.abort();
    const server = this.httpServer;
    this.httpServer = null;
    if (!server) return;
    for (const socket of this.sockets) socket.destroy();
    await Promise.allSettled([...this.protocols].map((protocol) => protocol.close()));
    await new Promise((resolve) => server.close(() => resolve()));
  }

  reply(res, status, message, extraHeaders = {}) {
    if (res.headersSent || res.destroyed) return;
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    });
    res.end(JSON.stringify({ error: message }), 'utf8');
  }

  async handle(req, res) {
    let protocol;
    let aborter;
    let counted = false;
    let timeoutArmed = false;
    const onTimeout = () => {
      aborter?.abort();
      this.reply(res, 408, 'Request timed out.');
      req.destroy();
    };
    try {
      res.setHeader('Cache-Control', 'no-store');
      if (this.closed) return this.reply(res, 503, 'Server stopping.');

      const hosts = ['127.0.0.1:' + this.port, 'localhost:' + this.port];
      if (
        !hosts.includes(req.headers.host) ||
        (req.headers.origin !== undefined &&
          !hosts.some((host) => req.headers.origin === 'http://' + host))
      ) {
        return this.reply(res, 403, 'Forbidden host or origin.');
      }

      const pathname = (req.url || '').split('?')[0];
      const actualBytes = encoder.encode(pathname);
      if (
        actualBytes.byteLength !== this.expectedBytes.byteLength ||
        !this.timingSafeEqual(actualBytes, this.expectedBytes)
      ) {
        return this.reply(res, 404, 'Not found.');
      }

      if (req.method !== 'POST') {
        return this.reply(res, 405, 'Only POST is supported (stateless MCP).', { Allow: 'POST' });
      }
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
        return this.reply(res, 415, 'Use application/json.');
      }

      const now = Date.now();
      if (now - this.rateStart >= 10000) {
        this.rateStart = now;
        this.rateCount = 0;
      }
      if (++this.rateCount > MAX_REQUESTS || this.activeRequests >= MAX_CONCURRENT) {
        return this.reply(res, 429, 'Too many requests.', { 'Retry-After': '10' });
      }
      if (Number(req.headers['content-length']) > MAX_BODY) {
        return this.reply(res, 413, 'Request too large.');
      }

      this.activeRequests++;
      counted = true;
      aborter = new AbortController();
      this.aborters.add(aborter);
      res.on('close', () => {
        if (!res.writableEnded) aborter.abort();
      });
      if (req.socket) {
        req.setTimeout(REQUEST_TIMEOUT, onTimeout);
        timeoutArmed = true;
      }

      let rawBody = '';
      let size = 0;
      req.setEncoding('utf8');
      for await (const chunk of req) {
        size += encoder.encode(chunk).byteLength;
        if (size > MAX_BODY) return this.reply(res, 413, 'Request too large.');
        rawBody += chunk;
      }

      let body;
      try {
        body = JSON.parse(rawBody);
      } catch {
        return this.reply(res, 400, 'Invalid JSON.');
      }

      if (this.closed || res.destroyed || aborter.signal.aborted) return;

      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) {
          for (const item of value) headers.append(key, item);
        } else if (value !== undefined) {
          headers.set(key, value);
        }
      }
      const webReq = new Request('http://' + req.headers.host + pathname, {
        method: 'POST',
        headers,
        body: rawBody,
        signal: aborter.signal,
      });

      protocol = createProtocolServer(this.api, this.version);
      this.protocols.add(protocol);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await protocol.connect(transport);
      const webRes = await transport.handleRequest(webReq, { parsedBody: body });

      const outHeaders = {};
      webRes.headers.forEach((value, key) => {
        outHeaders[key] = value;
      });
      outHeaders['Cache-Control'] = 'no-store';
      const responseText = await webRes.text();
      if (!res.headersSent && !res.destroyed && !aborter.signal.aborted) {
        res.writeHead(webRes.status, outHeaders);
        res.end(responseText, 'utf8');
      }
    } catch {
      if (!aborter?.signal.aborted) this.reply(res, 500, 'MCP request failed.');
    } finally {
      if (timeoutArmed && req.socket) req.setTimeout(0);
      req.removeListener('timeout', onTimeout);
      if (counted) this.activeRequests--;
      if (aborter) this.aborters.delete(aborter);
      if (protocol) {
        this.protocols.delete(protocol);
        await protocol.close().catch(() => {});
      }
    }
  }
}

export { GraphFrontierMcpServer, createProtocolServer };
