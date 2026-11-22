'use strict';

const path = require('node:path');

// In dev/node-test mode, load the prebuilt MCP runtime bundle from packages/standalone.
// When build-vscode.cjs builds dist/extension.cjs, this module is replaced with direct source bundling from root src/mcp-server.js.
module.exports = require(path.resolve(__dirname, '..', '..', 'standalone', 'dist', 'mcp-node.cjs'));
