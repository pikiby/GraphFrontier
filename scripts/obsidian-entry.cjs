// Obsidian imports the plugin; a local MCP client runs this same installed file with Node.
if (require.main === module && process.argv[2] === '--mcp-stdio') {
  require('../src/mcp-stdio.js')
    .start(process.argv[3], __dirname)
    .catch((error) => {
      process.stderr.write(error.message + '\n');
      process.exitCode = 1;
    });
} else {
  module.exports = require('../src/main.js').default;
}
