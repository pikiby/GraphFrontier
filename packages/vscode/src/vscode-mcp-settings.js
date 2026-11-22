import { PluginSettingTab, Notice, Setting } from 'obsidian';
import { NodeListsPanel } from '@gf/node-lists-modal.js';
import { BackupsPanel } from '@gf/backups-modal.js';

function vscRpc(action, payload) {
  if (typeof window.__gfVscodeRpc !== 'function') {
    return Promise.reject(new Error('VS Code bridge unavailable.'));
  }
  return window.__gfVscodeRpc(action, payload);
}

class McpController {
  constructor(plugin) {
    this.plugin = plugin;
    this.desktop = true;
    this.enabled = false;
    this.disposed = false;
    this.error = '';
    this.port = 0;
    this.url = '';
    this.switches = new Set();
    this.urlBoxes = new Set();
  }

  applyState(state) {
    if (!state || typeof state !== 'object') return;
    this.enabled = !!state.enabled;
    this.port = Number(state.port || 0);
    this.url = typeof state.url === 'string' ? state.url : '';
    this.error = typeof state.error === 'string' ? state.error : '';
    this.refreshToggles();
  }

  async load() {
    try {
      this.applyState(await vscRpc('mcp-get'));
    } catch (error) {
      this.enabled = false;
      this.url = '';
      this.error = error?.message || 'Cannot load MCP status.';
    }
  }

  async update({ enabled }) {
    const status = await vscRpc('mcp-set', { enabled: !!enabled });
    this.applyState(status);
    return status;
  }

  renderToggle(el) {
    if (!this.desktop) return;
    el.createDiv({
      cls: 'setting-item-description',
      text: 'Let local AI agents read and change graphs in this workspace.',
    });
    const row = el.createDiv({ cls: 'graphfrontier-sidepanel-row' });
    row.createSpan({ text: 'Allow agent access', cls: 'graphfrontier-sidepanel-label' });
    const button = row.createEl('button', {
      cls: 'graphfrontier-toggle-btn',
      attr: { type: 'button', role: 'switch', 'aria-label': 'Allow agent access' },
    });
    const urlBox = el.createDiv({ cls: 'gf-vsc-mcp-url' });
    this.switches.add(new WeakRef(button));
    this.urlBoxes.add(new WeakRef(urlBox));
    this.syncUrlBox(urlBox);
    button.toggleClass('is-on', this.enabled);
    button.setAttribute('aria-checked', String(this.enabled));

    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await this.update({ enabled: !this.enabled });
        if (this.error) new Notice(this.error);
      } catch (error) {
        new Notice(error?.message || 'Failed to update MCP state.');
      } finally {
        button.disabled = false;
      }
    });
  }

  syncUrlBox(urlBox) {
    urlBox.empty();
    if (this.enabled && this.url) {
      urlBox.createEl('code', { text: this.url });
      urlBox.show();
    } else {
      urlBox.hide();
    }
  }

  refreshToggles() {
    for (const ref of this.switches) {
      const button = ref.deref();
      if (!button || button.isConnected === false) this.switches.delete(ref);
      else {
        button.toggleClass('is-on', this.enabled);
        button.setAttribute('aria-checked', String(this.enabled));
      }
    }
    for (const ref of this.urlBoxes) {
      const urlBox = ref.deref();
      if (!urlBox || urlBox.isConnected === false) this.urlBoxes.delete(ref);
      else this.syncUrlBox(urlBox);
    }
  }

  async stop() {
    this.disposed = true;
    this.enabled = false;
    this.url = '';
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
            new Notice('Copied to clipboard');
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
    if (description) {
      section.createEl('p', {
        text: description,
        cls: 'setting-item-description graphfrontier-settings-description',
      });
    }
    return section.createDiv();
  }
}

export { McpController, GraphFrontierMcpSettingTab };
