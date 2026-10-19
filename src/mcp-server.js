// Loaded only after the desktop/enabled check, never during mobile plugin import.
const { z } = require('./schema-runtime');
const http = require('node:http');
const { timingSafeEqual } = require('node:crypto');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const {
  StreamableHTTPServerTransport,
} = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { CfWorkerJsonSchemaValidator } = require('@modelcontextprotocol/sdk/validation/cfworker');
const { GraphApiError, MAX_PAGE } = require('./api');
const { EXTENDED_TOOLS } = require('./api-tools');

const MAX_BODY = 64 * 1024;
const MAX_RESPONSE = 2 * 1024 * 1024;
const REQUEST_TIMEOUT = 60000;
const MAX_CONCURRENT = 8;
const MAX_REQUESTS = 120;

function createProtocolServer(api, version) {
  const server = new McpServer(
    { name: 'graphfrontier', version },
    {
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
      instructions:
        'Control GraphFrontier in this vault. Start with list_views, then get_configuration. Use current viewId/contextToken; refresh them after graph/layout changes. All global and node settings, lists, gravity, layouts, backups and HTML export are available. Saved layouts are automatically backed up before replacement/deletion. No arbitrary code execution. An export may contain note text; use includeContents=false when not requested. Only perform writes/deletions/exports requested by the user. Native third-party Obsidian menu callbacks are not exposed.',
    }
  );
  const view = { viewId: z.string().min(1).max(200), contextToken: z.string().max(300).optional() };
  const page = {
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    limit: z.number().int().min(1).max(MAX_PAGE).optional(),
  };
  const nodes = {
    ...view,
    contextToken: z.string().min(1).max(300),
    nodeIds: z.array(z.string().min(1).max(4096)).max(MAX_PAGE),
  };
  const definitions = [
    [
      'list_views',
      'List open graphs, vault identity and context tokens. Does not open tabs.',
      {},
      'listViews',
      true,
    ],
    ['get_state', 'Read graph counts, active layout and camera.', view, 'getState', true],
    [
      'get_selection',
      'Read a page of explicit selection IDs; search focus is separate.',
      { ...view, ...page },
      'getSelection',
      true,
    ],
    [
      'get_graph',
      'Read a bounded page of node metadata or edges, not note contents. Default visibleOnly=true. Follow nextOffset; contextToken detects layout/graph changes.',
      {
        ...view,
        ...page,
        kind: z.enum(['nodes', 'edges']).optional(),
        visibleOnly: z.boolean().optional(),
      },
      'getGraph',
      true,
    ],
    [
      'select_nodes',
      'Replace selection with these visible node IDs. Empty list clears selection. Requires current contextToken; does not save layouts.',
      nodes,
      'selectNodes',
      false,
    ],
    [
      'frame_nodes',
      'Frame these visible nodes with the camera without moving nodes or saving a layout.',
      { ...nodes, nodeIds: nodes.nodeIds.min(1) },
      'frameNodes',
      false,
    ],
  ];
  const tools = [
    ...definitions.map(([name, description, inputSchema, method, readOnly]) => ({
      name,
      description,
      schema: z.object(inputSchema).strict(),
      method,
      readOnly,
      destructive: false,
    })),
    ...EXTENDED_TOOLS,
  ];
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
          if (Buffer.byteLength(text) > MAX_RESPONSE)
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
  constructor(api, settings, version = '0.0.0') {
    this.api = api;
    this.settings = { ...settings };
    this.version = version;
    this.sockets = new Set();
    this.protocols = new Set();
    this.activeRequests = 0;
    this.rateStart = 0;
    this.rateCount = 0;
    this.closed = false;
  }

  async start() {
    if (this.httpServer || this.closed) throw new Error('MCP server already started or stopped.');
    if (!/^[a-f0-9]{64}$/.test(this.settings.token)) throw new Error('Invalid MCP token.');
    this.httpServer = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    this.httpServer.requestTimeout = REQUEST_TIMEOUT;
    this.httpServer.headersTimeout = REQUEST_TIMEOUT;
    this.httpServer.maxConnections = 32;
    this.httpServer.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.setTimeout(REQUEST_TIMEOUT, () => socket.destroy());
      socket.on('close', () => this.sockets.delete(socket));
    });
    await new Promise((resolve, reject) => {
      this.httpServer.once('error', reject);
      this.httpServer.once('close', () => reject(new Error('MCP startup cancelled.')));
      this.httpServer.listen(this.settings.port, '127.0.0.1', resolve);
    });
    if (this.closed) {
      await this.stop();
      throw new Error('MCP startup cancelled.');
    }
    this.port = this.httpServer.address().port;
    return this;
  }

  async stop() {
    this.closed = true;
    const server = this.httpServer;
    if (!server) return;
    for (const socket of this.sockets) socket.destroy();
    await Promise.allSettled([...this.protocols].map((protocol) => protocol.close()));
    await new Promise((resolve) => server.close(resolve));
    this.httpServer = null;
  }

  reply(res, status, message) {
    if (res.headersSent || res.destroyed) return;
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: message }));
  }

  async handle(req, res) {
    let protocol;
    let timer;
    let counted = false;
    try {
      res.setHeader('Cache-Control', 'no-store');
      if (this.closed) return this.reply(res, 503, 'Server stopping.');
      const hosts = [`127.0.0.1:${this.port}`, `localhost:${this.port}`];
      if (
        !hosts.includes(req.headers.host) ||
        (req.headers.origin !== undefined &&
          !hosts.some((host) => req.headers.origin === `http://${host}`))
      ) {
        return this.reply(res, 403, 'Forbidden host or origin.');
      }
      if (req.url !== '/mcp') return this.reply(res, 404, 'Not found.');
      const authorization = req.headers.authorization || '';
      const expected = `Bearer ${this.settings.token}`;
      if (
        Buffer.byteLength(authorization) !== Buffer.byteLength(expected) ||
        !timingSafeEqual(Buffer.from(authorization), Buffer.from(expected))
      ) {
        res.setHeader('WWW-Authenticate', 'Bearer realm="GraphFrontier"');
        return this.reply(res, 401, 'Authentication required.');
      }
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return this.reply(res, 405, 'Only POST is supported (stateless MCP).');
      }
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
        return this.reply(res, 415, 'Use application/json.');
      }
      if (Date.now() - this.rateStart >= 10000) {
        this.rateStart = Date.now();
        this.rateCount = 0;
      }
      if (++this.rateCount > MAX_REQUESTS || this.activeRequests >= MAX_CONCURRENT) {
        res.setHeader('Retry-After', '10');
        return this.reply(res, 429, 'Too many requests.');
      }
      if (Number(req.headers['content-length']) > MAX_BODY)
        return this.reply(res, 413, 'Request too large.');
      this.activeRequests++;
      counted = true;
      timer = setTimeout(() => {
        this.reply(res, 408, 'Request timed out.');
        req.destroy();
      }, REQUEST_TIMEOUT);
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) return this.reply(res, 413, 'Request too large.');
        chunks.push(chunk);
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return this.reply(res, 400, 'Invalid JSON.');
      }
      if (this.closed || res.destroyed) return;
      protocol = createProtocolServer(this.api, this.version);
      this.protocols.add(protocol);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await protocol.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      this.reply(res, 500, 'MCP request failed.');
    } finally {
      clearTimeout(timer);
      if (counted) this.activeRequests--;
      if (protocol) {
        this.protocols.delete(protocol);
        await protocol.close().catch(() => {});
      }
    }
  }
}

module.exports = { GraphFrontierMcpServer, createProtocolServer };
