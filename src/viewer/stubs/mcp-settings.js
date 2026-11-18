// The exported page has no MCP server: it runs in a browser, outside Obsidian.
import { PluginSettingTab } from 'obsidian';

class McpController {
  async load() {}
  async stop() {}
}

class GraphFrontierMcpSettingTab extends PluginSettingTab {}

export { McpController, GraphFrontierMcpSettingTab };
