#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { startStandaloneServer } = require('../src/server.cjs');

function printHelp() {
  console.log(`GraphFrontier Standalone CLI

Usage:
  graphfrontier [vaultDir] [options]

Options:
  --port <n>            HTTP server port (default: 8790, 0 = ephemeral)
  --mcp-port <n>        Preferred MCP HTTP port (default: deterministic per-vault hash)
  --read-only           Never write plugin state or layouts to disk
  --state-dir <dir>     Store plugin state/layouts in a custom directory
  --obsidian-config     Read and write directly under <vault>/.obsidian/plugins/graphfrontier
  --no-watch            Disable live filesystem watcher
  --open                Open browser automatically
  -h, --help            Show this help message
`);
}

function parseArgs(argv) {
  const opts = {
    vaultDir: process.cwd(),
    port: 8790,
    mcpPort: undefined,
    readOnly: false,
    stateDir: null,
    useObsidianConfig: false,
    watch: true,
    open: false,
    help: false,
  };

  let positionalSet = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      opts.help = true;
    } else if (arg === '--port' && i + 1 < argv.length) {
      opts.port = Number(argv[++i]);
    } else if (arg.startsWith('--port=')) {
      opts.port = Number(arg.slice('--port='.length));
    } else if (arg === '--mcp-port' && i + 1 < argv.length) {
      opts.mcpPort = Number(argv[++i]);
    } else if (arg.startsWith('--mcp-port=')) {
      opts.mcpPort = Number(arg.slice('--mcp-port='.length));
    } else if (arg === '--state-dir' && i + 1 < argv.length) {
      opts.stateDir = path.resolve(argv[++i]);
    } else if (arg.startsWith('--state-dir=')) {
      opts.stateDir = path.resolve(arg.slice('--state-dir='.length));
    } else if (arg === '--read-only') {
      opts.readOnly = true;
    } else if (arg === '--obsidian-config') {
      opts.useObsidianConfig = true;
    } else if (arg === '--no-watch') {
      opts.watch = false;
    } else if (arg === '--open') {
      opts.open = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!positionalSet) {
      opts.vaultDir = path.resolve(arg);
      positionalSet = true;
    } else {
      throw new Error(`Unexpected extra argument: ${arg}`);
    }
  }

  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
    throw new Error(`Invalid --port: ${opts.port}`);
  }
  if (
    opts.mcpPort !== undefined &&
    (!Number.isInteger(opts.mcpPort) || opts.mcpPort < 0 || opts.mcpPort > 65535)
  ) {
    throw new Error(`Invalid --mcp-port: ${opts.mcpPort}`);
  }
  return opts;
}

function openBrowserUrl(url) {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.unref();
  } catch {
    // Ignore desktop open failure on headless servers.
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const srv = await startStandaloneServer(opts);
  const idx = srv.getIndex();
  const mcp = srv.mcpHost.getStatus();
  const mdCount = Object.keys(idx.caches).length;

  console.log(`GraphFrontier Standalone ready:`);
  console.log(`  Vault:     ${srv.vaultDir}`);
  console.log(
    `  Mode:      ${srv.readOnly ? 'read-only (zero disk writes)' : `read-write (${srv.stateStore.activeDir})`}`
  );
  console.log(`  Indexed:   ${mdCount} markdown notes, ${idx.files.length} files`);
  console.log(`  Layout:    ${srv.stateStore.pluginData?.active_layout_name || 'default'}`);
  console.log(`  Web UI:    ${srv.url}`);
  console.log(
    `  MCP URL:   ${mcp.enabled ? mcp.url : `(off${mcp.error ? `: ${mcp.error}` : ''})`}`
  );

  if (opts.open) openBrowserUrl(srv.url);

  const shutdown = async () => {
    await srv.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(`Error: ${error?.message || error}`);
  process.exit(1);
});
