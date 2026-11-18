// The exported page has no MCP server: it runs in a browser, outside Obsidian.
const { PluginSettingTab } = require('obsidian');

class McpController {
  async load() {}
  async stop() {}
}

class GraphFrontierMcpSettingTab extends PluginSettingTab {}

module.exports = {
  McpController,
  GraphFrontierMcpSettingTab,
  clientConfigs: () => [],
  normalizeMcpSettings: (value) => value,
};
