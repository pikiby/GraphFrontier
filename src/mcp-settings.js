import { PluginSettingTab, Notice, Platform, Setting } from 'obsidian';

import { NodeListsPanel } from './node-lists-modal.js';
import { BackupsPanel } from './backups-modal.js';

const SECRET_RE = /^[a-f0-9]{64}$/;

function defaultPortForKey(key) {
  const text = String(key || 'graphfrontier');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return 27125 + ((hash >>> 0) % 10000);
}

function generateSecret() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function parseStoredMcpConfig(raw) {
  const stored = JSON.parse(raw);
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    throw new Error('Invalid MCP settings.');
  }
  if (typeof stored.enabled !== 'boolean') {
    throw new Error('Invalid MCP settings.');
  }
  let port;
  if (stored.port !== undefined) {
    if (!Number.isInteger(stored.port) || stored.port < 1024 || stored.port > 65535) {
      throw new Error('Invalid MCP port.');
    }
    port = stored.port;
  }
  let secret;
  if (stored.secret !== undefined) {
    if (typeof stored.secret !== 'string' || !SECRET_RE.test(stored.secret)) {
      throw new Error('Invalid MCP secret.');
    }
    secret = stored.secret;
  }
  if (stored.token !== undefined) {
    if (typeof stored.token !== 'string') {
      throw new Error('Invalid legacy MCP token.');
    }
    if (secret === undefined && SECRET_RE.test(stored.token)) {
      secret = stored.token;
    }
  }
  if (stored.url !== undefined && typeof stored.url !== 'string') {
    throw new Error('Invalid MCP url.');
  }
  return { enabled: stored.enabled, port, secret };
}

class McpController {
  constructor(plugin, options = {}) {
    this.plugin = plugin;
    this.desktop = options.desktop ?? Platform.isDesktopApp;
    this.enabled = false;
    this.disposed = false;
    this.error = '';
    this.loadFailed = false;
    this.queue = Promise.resolve();
    this.switches = new Set();
    this.dir = plugin.getLayoutsFolderRelativePath().replace(/\/layouts$/, '');
    this.path = this.dir + '/mcp.json';
    this.makeSecret = options.makeSecret || generateSecret;
    const vaultKey =
      plugin.app?.vault?.adapter?.getFullPath?.(this.dir) ||
      plugin.app?.vault?.getName?.() ||
      this.dir;
    this.preferredPort = options.defaultPort ?? defaultPortForKey(vaultKey);
    this.factory =
      options.factory ||
      (async (config) => {
        const { GraphFrontierMcpServer } = await import('./mcp-server.js');
        return new GraphFrontierMcpServer(
          this.plugin.api,
          config,
          this.plugin.manifest?.version || '0.0.0'
        );
      });
    this.port = 0;
    this.secret = '';
    this.url = '';
    this.server = null;
  }

  serialize(enabled) {
    if (enabled) {
      return { enabled: true, port: this.port, secret: this.secret, url: this.url };
    }
    const data = { enabled: false };
    if (this.port) data.port = this.port;
    if (this.secret) data.secret = this.secret;
    return data;
  }

  persistState(enabled) {
    return this.plugin.app.vault.adapter.write(
      this.path,
      JSON.stringify(this.serialize(enabled)) + '\n'
    );
  }

  async startServer() {
    await this.stopServer();
    if (this.disposed) return;
    const server = await this.factory({ port: this.port, secret: this.secret });
    if (this.disposed) {
      await server.stop().catch(() => {});
      return;
    }
    this.server = server;
    try {
      await server.start();
    } catch (error) {
      if (this.server === server) this.server = null;
      await server.stop().catch(() => {});
      throw error;
    }
    if (this.disposed) {
      await this.stopServer();
      return;
    }
    this.port = server.port;
    this.url = server.url;
  }

  async stopServer() {
    const server = this.server;
    this.server = null;
    if (server) await server.stop();
  }

  async load() {
    if (!this.desktop) return;
    try {
      const adapter = this.plugin.app.vault.adapter;
      if (!(await adapter.exists(this.path))) {
        this.secret = this.makeSecret();
        this.port = this.preferredPort;
        if (this.disposed) return;
        await this.startServer();
        if (this.disposed) {
          await this.stopServer();
          return;
        }
        await this.persistState(true);
        if (this.disposed) {
          await this.stopServer();
          return;
        }
        this.enabled = true;
        return;
      }

      const raw = await adapter.read(this.path);
      const parsed = parseStoredMcpConfig(raw);
      if (!parsed.enabled) {
        this.port = parsed.port ?? 0;
        this.secret = parsed.secret ?? '';
        this.enabled = false;
        this.url = '';
        const expected = JSON.stringify(this.serialize(false)) + '\n';
        if (raw !== expected) await adapter.write(this.path, expected);
        return;
      }

      this.port = parsed.port ?? this.preferredPort;
      this.secret = parsed.secret || this.makeSecret();
      if (this.disposed) return;
      await this.startServer();
      if (this.disposed) {
        await this.stopServer();
        return;
      }
      const expected = JSON.stringify(this.serialize(true)) + '\n';
      if (raw !== expected) await adapter.write(this.path, expected);
      if (this.disposed) {
        await this.stopServer();
        return;
      }
      this.enabled = true;
    } catch {
      await this.stopServer();
      this.loadFailed = true;
      this.enabled = false;
      this.url = '';
      this.error = 'Cannot load MCP preferences. MCP remains off.';
    }
  }

  update({ enabled }) {
    const pending = this.queue
      .then(async () => {
        if (!this.desktop || this.disposed || this.loadFailed || typeof enabled !== 'boolean')
          throw new Error(this.error || 'MCP unavailable.');
        if (!enabled) {
          this.enabled = false;
          this.url = '';
          await this.stopServer();
          await this.persistState(false);
          return;
        }
        if (!this.secret) this.secret = this.makeSecret();
        if (!this.port) this.port = this.preferredPort;
        await this.startServer();
        if (this.disposed) {
          await this.stopServer();
          this.enabled = false;
          this.url = '';
          return;
        }
        await this.persistState(true);
        if (this.disposed) {
          await this.stopServer();
          this.enabled = false;
          this.url = '';
          return;
        }
        this.enabled = true;
      })
      .finally(() => this.refreshToggles());
    this.queue = pending.catch(() => {});
    return pending;
  }

  renderToggle(el) {
    if (!this.desktop) return;
    el.createDiv({
      cls: 'setting-item-description',
      text: 'Let local AI agents read and change graphs in this vault.',
    });
    const row = el.createDiv({ cls: 'graphfrontier-sidepanel-row' });
    row.createSpan({ text: 'Allow agent access', cls: 'graphfrontier-sidepanel-label' });
    const button = row.createEl('button', {
      cls: 'graphfrontier-toggle-btn',
      attr: { type: 'button', role: 'switch', 'aria-label': 'Allow agent access' },
    });
    this.switches.add(new WeakRef(button));
    this.syncToggle(button);
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await this.update({ enabled: !this.enabled });
        if (this.error) new Notice(this.error);
      } catch (error) {
        new Notice(error.message);
      } finally {
        button.disabled = false;
      }
    });
  }

  syncToggle(button) {
    const on = this.enabled;
    button.toggleClass('is-on', on);
    button.setAttribute('aria-checked', String(on));
  }

  refreshToggles() {
    for (const ref of this.switches) {
      const button = ref.deref();
      if (!button || button.isConnected === false) this.switches.delete(ref);
      else this.syncToggle(button);
    }
  }

  async stop() {
    this.disposed = true;
    this.enabled = false;
    this.url = '';
    await this.stopServer();
    this.refreshToggles();
  }
}

class GraphFrontierMcpSettingTab extends PluginSettingTab {
  hide() {
    this.listsPanel?.onClose();
    this.backupsPanel?.onClose();
  }

  display() {
    this.hide();
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('graphfrontier-settings');
    if (this.plugin.mcp.desktop) this.plugin.mcp.renderToggle(this.section('MCP'));
    const listsEl = this.section('Node lists', 'Files used by group filters and the API.');
    this.listsPanel = new NodeListsPanel(
      {
        app: this.app,
        plugin: this.plugin,
        copyTextToClipboard: async (text) => {
          try {
            await navigator.clipboard.writeText(text);
          } catch {
            new Notice('Could not copy list ID.');
          }
        },
      },
      listsEl
    );
    this.listsPanel.onOpen();
    const backupsEl = this.section(
      'Backups',
      'One current copy of layouts, lists and preferences. Access tokens are excluded.'
    );
    this.backupsPanel = new BackupsPanel(this.plugin, backupsEl);
    this.backupsPanel.onOpen();
  }

  section(title, description) {
    const section = this.containerEl.createDiv({ cls: 'graphfrontier-settings-section' });
    new Setting(section).setName(title).setHeading();
    if (description)
      section.createEl('p', {
        text: description,
        cls: 'setting-item-description graphfrontier-settings-description',
      });
    return section.createDiv();
  }
}

export { McpController, GraphFrontierMcpSettingTab };
