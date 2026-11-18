import manifest from '../manifest.json' with { type: 'json' };
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createProtocolServer } from './mcp-server.js';
import { GraphApiError } from './api-errors.js';
const run = promisify(execFile);

function cliBridge(vault, dir, execute = run) {
  if (!vault || Array.from(vault).some((c) => c.charCodeAt(0) < 32))
    throw new Error('Pass the target vault name or ID after --mcp-stdio.');
  return {
    async runTool(name, args, _readOnly, signal) {
      const data = Buffer.from(JSON.stringify({ dir, name, args }));
      if (data.length > 65536)
        throw new GraphApiError('REQUEST_TOO_LARGE', 'Split the request into smaller parts.');
      // The CLI receives a fixed expression with base64 data, never interpolated tool code.
      const code =
        "await app.plugins.plugins.graphfrontier.mcp.dispatch('" + data.toString('base64') + "')";
      let stdout;
      try {
        ({ stdout } = await execute('obsidian', ['vault=' + vault, 'eval', 'code=' + code], {
          shell: false,
          // GUI-launched MCP clients may omit the user's Linux runtime directory.
          env:
            process.platform === 'linux' && !process.env.XDG_RUNTIME_DIR
              ? { ...process.env, XDG_RUNTIME_DIR: '/run/user/' + process.getuid() }
              : process.env,
          windowsHide: true,
          timeout: 60000,
          maxBuffer: 4 * 1024 * 1024,
          signal,
        }));
      } catch {
        throw new GraphApiError(
          'CLI_UNAVAILABLE',
          'Open the target vault in desktop Obsidian and enable its CLI. If a write timed out, check its result before retrying.'
        );
      }
      const match = String(stdout).match(/GF_RESULT:([A-Za-z0-9+/]+=*)/);
      if (!match)
        throw new GraphApiError(
          'PLUGIN_UNAVAILABLE',
          'GraphFrontier did not respond. Check the vault and plugin version.'
        );
      const result = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
      if (result.error) throw new GraphApiError(result.error.code, result.error.message);
      return result.value;
    },
  };
}

async function start(vault, dir) {
  const server = createProtocolServer(cliBridge(vault, dir), manifest.version);
  await server.connect(new StdioServerTransport());
}
export { start, cliBridge };
