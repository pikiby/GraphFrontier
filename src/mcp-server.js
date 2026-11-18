import { tools } from './mcp-definitions.js';
import { GraphApiError } from './api-errors.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';
const MAX_RESPONSE = 2 * 1024 * 1024;
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
            ? api.runTool(name, args, readOnlyHint, extra.signal)
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

export { createProtocolServer };
