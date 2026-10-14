const { PluginSettingTab, Setting, Notice, Platform } = require('obsidian');

const DEFAULT_MCP_SETTINGS = { enabled: false, port: 27125, token: '' };

function normalizeMcpSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid MCP settings.');
  const result = { ...DEFAULT_MCP_SETTINGS, ...value };
  if (
    typeof result.enabled !== 'boolean' ||
    !Number.isInteger(result.port) ||
    result.port < 1024 ||
    result.port > 65535 ||
    typeof result.token !== 'string' ||
    (result.token !== '' && !/^[a-f0-9]{64}$/.test(result.token))
  ) {
    throw new Error('Invalid MCP settings: use a port from 1024 to 65535 and a generated token.');
  }
  return { enabled: result.enabled, port: result.port, token: result.token };
}

function clientConfigs(port) {
  const url = `http://127.0.0.1:${port}/mcp`;
  return {
    codex: `[mcp_servers.graphfrontier]\nurl = "${url}"\nbearer_token_env_var = "GRAPHFRONTIER_MCP_TOKEN"\n`,
    claude: JSON.stringify(
      {
        mcpServers: {
          graphfrontier: {
            type: 'http',
            url,
            headers: { Authorization: 'Bearer ${GRAPHFRONTIER_MCP_TOKEN}' },
          },
        },
      },
      null,
      2
    ),
    opencode: JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        mcp: {
          graphfrontier: {
            type: 'remote',
            url,
            enabled: true,
            oauth: false,
            headers: { Authorization: 'Bearer {env:GRAPHFRONTIER_MCP_TOKEN}' },
          },
        },
      },
      null,
      2
    ),
  };
}

class McpController {
  constructor(plugin, options = {}) {
    this.plugin = plugin;
    this.desktop = options.desktop ?? Platform.isDesktopApp;
    this.settings = { ...DEFAULT_MCP_SETTINGS };
    this.queue = Promise.resolve();
    this.disposed = false;
    this.error = '';
    this.loadFailed = false;
    this.server = null;
    this.factory =
      options.factory ||
      ((settings) => {
        const { GraphFrontierMcpServer } = require('./mcp-server');
        return new GraphFrontierMcpServer(plugin.api, settings, plugin.manifest.version);
      });
    this.makeToken =
      options.makeToken || (() => require('node:crypto').randomBytes(32).toString('hex'));
    const dir = plugin.getLayoutsFolderRelativePath().replace(/\/layouts$/, '');
    this.path = `${dir}/mcp.json`;
  }

  async load() {
    if (!this.desktop) return;
    try {
      const adapter = this.plugin.app.vault.adapter;
      if (await adapter.exists(this.path)) {
        this.settings = normalizeMcpSettings(JSON.parse(await adapter.read(this.path)));
      }
      if (!this.disposed) await this.restart();
    } catch {
      this.loadFailed = true;
      this.settings = { ...DEFAULT_MCP_SETTINGS };
      this.error = 'Cannot read mcp.json. MCP is disabled; the file was not overwritten.';
    }
  }

  update(patch, rotateToken = false) {
    const run = async () => {
      if (this.disposed) throw new Error('GraphFrontier is unloaded.');
      if (!this.desktop) throw new Error('MCP is available on desktop only.');
      if (this.loadFailed) throw new Error(this.error);
      const next = normalizeMcpSettings({ ...this.settings, ...patch });
      if (rotateToken || (next.enabled && !next.token)) next.token = this.makeToken();
      normalizeMcpSettings(next);
      await this.plugin.app.vault.adapter.write(this.path, `${JSON.stringify(next, null, 2)}\n`);
      this.settings = next;
      if (!this.disposed) await this.restart();
    };
    const pending = this.queue.then(run);
    this.queue = pending.catch(() => {});
    return pending;
  }

  async restart() {
    const old = this.server;
    this.server = null;
    if (old) await old.stop();
    this.error = '';
    if (this.disposed || !this.desktop || !this.settings.enabled) return;
    if (!this.settings.token) {
      this.error = 'Generate a token before enabling MCP.';
      return;
    }
    let next;
    try {
      next = this.factory(this.settings);
      this.server = next;
      await next.start();
      if (this.disposed) await next.stop();
    } catch (error) {
      if (next) await next.stop();
      if (this.server === next) this.server = null;
      this.error =
        error.code === 'EADDRINUSE'
          ? 'MCP port is in use. Choose a different port.'
          : 'Cannot start MCP. It requires desktop Obsidian with Node 18+ and Web Fetch APIs.';
    }
  }

  async stop() {
    this.disposed = true;
    const server = this.server;
    this.server = null;
    if (server) await server.stop();
  }
}

class GraphFrontierMcpSettingTab extends PluginSettingTab {
  display() {
    const { containerEl } = this;
    const controller = this.plugin.mcp;
    containerEl.empty();
    containerEl.createEl('h3', { text: 'Local MCP' });
    containerEl.createEl('p', {
      text: 'Connect Codex, Claude Code or OpenCode to the open graph. Access is local and requires a token. Layout files do not contain these settings.',
    });
    if (!controller.desktop) {
      containerEl.createEl('p', {
        text: 'The MCP server is desktop-only. The graph remains available on mobile.',
      });
      return;
    }
    const update = async (patch, rotate = false) => {
      try {
        await controller.update(patch, rotate);
      } catch (error) {
        new Notice(error.message);
      }
      this.display();
    };
    new Setting(containerEl)
      .setName('Enable MCP')
      .addToggle((toggle) =>
        toggle.setValue(controller.settings.enabled).onChange((enabled) => update({ enabled }))
      );
    new Setting(containerEl)
      .setName('Port')
      .setDesc('Use a different port for each vault. Changes take effect on Apply.')
      .addText((text) => {
        this.portInput = text;
        text.setValue(String(controller.settings.port));
      })
      .addButton((button) =>
        button
          .setButtonText('Apply')
          .onClick(() => update({ port: Number(this.portInput.getValue()) }))
      );
    const status =
      controller.error ||
      (controller.server
        ? `Listening on http://127.0.0.1:${controller.settings.port}/mcp`
        : 'MCP is off.');
    containerEl.createEl('p', { text: status });
    new Setting(containerEl)
      .setName('Access token')
      .setDesc(
        'Stored in the plugin mcp.json, outside layouts. Keep this file private. Regenerating invalidates existing client access.'
      )
      .addButton((button) =>
        button
          .setButtonText('Copy token')
          .setDisabled(!controller.settings.token)
          .onClick(async () => {
            try {
              await containerEl.win.navigator.clipboard.writeText(controller.settings.token);
              new Notice('MCP token copied');
            } catch {
              new Notice('Cannot access clipboard');
            }
          })
      )
      .addButton((button) =>
        button.setButtonText('Generate new token').onClick(() => update({}, true))
      );
    const client = this.client || 'codex';
    new Setting(containerEl)
      .setName('Client configuration')
      .setDesc(
        'Set GRAPHFRONTIER_MCP_TOKEN in the client environment to the copied token. Merge this example into your config.'
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ codex: 'Codex', claude: 'Claude Code', opencode: 'OpenCode 1.x' })
          .setValue(client)
          .onChange((value) => {
            this.client = value;
            this.display();
          })
      );
    const textarea = containerEl.createEl('textarea', {
      cls: 'graphfrontier-mcp-config',
      attr: { 'aria-label': 'MCP client configuration', readonly: '' },
    });
    textarea.value = clientConfigs(controller.settings.port)[client];
    textarea.rows = 14;
  }
}

module.exports = { McpController, GraphFrontierMcpSettingTab, clientConfigs, normalizeMcpSettings };
