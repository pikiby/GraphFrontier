import { PluginSettingTab, Notice, Platform, Setting } from 'obsidian';

import { NodeListsPanel } from './node-lists-modal.js';
import { BackupsPanel } from './backups-modal.js';

import { tools } from './mcp-definitions.js';
import { GraphApiError } from './api-errors.js';
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
    this.session = new AbortController();
  }

  async load() {
    if (!this.desktop) return;
    try {
      const adapter = this.plugin.app.vault.adapter;
      if (!(await adapter.exists(this.path))) {
        this.enabled = !this.disposed;
        return;
      }
      const stored = JSON.parse(await adapter.read(this.path));
      if (typeof stored?.enabled !== 'boolean') throw new Error();
      // Preserve the previous choice, but discard obsolete HTTP credentials.
      if (Object.keys(stored).some((key) => key !== 'enabled')) await this.persist(stored.enabled);
      this.enabled = !this.disposed && stored.enabled;
    } catch {
      this.loadFailed = true;
      this.error = 'Cannot load MCP preferences. MCP remains off.';
    }
  }

  persist(enabled) {
    return this.plugin.app.vault.adapter.write(this.path, JSON.stringify({ enabled }) + '\n');
  }

  update({ enabled }) {
    const pending = this.queue
      .then(async () => {
        if (!this.desktop || this.disposed || this.loadFailed || typeof enabled !== 'boolean')
          throw new Error(this.error || 'MCP unavailable.');
        if (!enabled) {
          this.enabled = false;
          this.session.abort();
        }
        await this.persist(enabled);
        if (enabled && !this.disposed) {
          if (this.session.signal.aborted) this.session = new AbortController();
          this.enabled = true;
        }
      })
      .finally(() => this.refreshToggles());
    this.queue = pending.catch(() => {});
    return pending;
  }

  async dispatch(encoded) {
    const pack = (data) => 'GF_RESULT:' + Buffer.from(JSON.stringify(data)).toString('base64');
    try {
      if (!this.desktop || !this.enabled || this.disposed)
        throw new GraphApiError('MCP_OFF', 'Turn MCP ON in GraphFrontier.');
      if (typeof encoded !== 'string' || encoded.length > 87384)
        throw new GraphApiError('REQUEST_TOO_LARGE', 'Request too large.');
      const { dir, name, args } = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      const path = await import('node:path');
      const actual = this.plugin.app.vault.adapter.getFullPath(this.dir);
      if (typeof dir !== 'string' || path.relative(actual, dir) !== '')
        throw new GraphApiError('WRONG_VAULT', 'Connector and CLI target different vaults.');
      const tool = tools.find((entry) => entry.name === name);
      if (!tool) throw new GraphApiError('UNKNOWN_TOOL', 'Unknown GraphFrontier tool.');
      const parsed = tool.schema.safeParse(args);
      if (!parsed.success)
        throw new GraphApiError('INVALID_ARGUMENT', 'Invalid arguments for ' + tool.name);
      const value = await this.plugin.api.runTool(
        tool.method,
        parsed.data,
        tool.readOnly,
        this.session.signal
      );
      if (Buffer.byteLength(JSON.stringify(value)) > 2 * 1024 * 1024)
        throw new GraphApiError('RESPONSE_TOO_LARGE', 'Request a smaller page.');
      return pack({ value });
    } catch (e) {
      return pack({
        error:
          e instanceof GraphApiError
            ? { code: e.code, message: e.message }
            : { code: 'INTERNAL_ERROR', message: 'Graph operation failed.' },
      });
    }
  }

  renderToggle(el) {
    if (!this.desktop) return;
    el.createDiv({
      cls: 'setting-item-description',
      text: 'Let local AI agents read and change graphs in this vault through the Obsidian CLI.',
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
    this.session.abort();
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
