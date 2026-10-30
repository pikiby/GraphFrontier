const { Notice } = require('obsidian');
const { DataConfirmModal } = require('./data-confirm-modal');
class BackupsPanel {
  constructor(plugin, containerEl) {
    this.app = plugin.app;
    this.contentEl = containerEl;
    this.plugin = plugin;
    this.manager = plugin.backups;
    this.opened = false;
    this.busy = false;
  }
  onOpen() {
    this.opened = true;
    this.render();
  }
  async run(action) {
    if (this.busy) return;
    this.busy = true;
    try {
      await action();
    } catch (error) {
      new Notice(`Backups: ${error.message}`);
    } finally {
      this.busy = false;
      if (this.opened) this.render();
    }
  }
  render() {
    this.contentEl.empty();
    const m = this.manager;
    if (!m?.ready) {
      this.contentEl.createEl('p', {
        text: 'Backups are initializing. Reopen settings shortly.',
      });
      return;
    }
    const automatic = this.row('Automatic backup', 'Keep the current backup up to date.');
    const label = automatic.createEl('label', { cls: 'checkbox-container' });
    const enabled = label.createEl('input', { type: 'checkbox' });
    enabled.checked = m.preferences.enabled;
    enabled.setAttribute('aria-label', 'Automatic backup');
    label.toggleClass('is-enabled', enabled.checked);
    enabled.addEventListener('change', () =>
      this.run(() => m.configure({ enabled: enabled.checked }))
    );
    const folderRow = this.row('Backup folder', 'Relative to the vault root.');
    const folder = folderRow.createEl('input', {
      type: 'text',
      placeholder: 'Backup folder inside vault',
    });
    folder.value = m.preferences.folder;
    folder.setAttribute('aria-label', 'Backup folder inside vault');
    folderRow
      .createEl('button', { text: 'Apply' })
      .addEventListener('click', () => this.run(() => m.configure({ folder: folder.value })));
    const buttons = this.row(
      'Backup and restore',
      `Last saved: ${m.lastSuccess ? new Date(m.lastSuccess).toLocaleString() : 'Not yet created'}`
    );
    if (m.blocked)
      this.contentEl.createEl('p', {
        text: 'Existing backup is protected. Leaving settings will not delete or overwrite it.',
        cls: 'graphfrontier-backup-warning',
      });
    if (m.error)
      this.contentEl.createEl('p', { text: m.error, cls: 'graphfrontier-backup-warning' });
    const backup = buttons.createEl('button', {
      text: m.blocked ? 'Replace with current data...' : 'Back up now',
    });
    backup.disabled = (m.blocked && !!m.error) || m.busy;
    backup.addEventListener('click', () =>
      this.run(async () => {
        if (m.blocked) {
          const found = await m.read();
          if (!found) throw new Error('Backup not found.');
          if (
            !(await DataConfirmModal.ask(
              this.app,
              'Replace protected backup?',
              'This replaces the previous backup with the current installation data.',
              'Replace'
            ))
          )
            return;
          await m.write({ replace: true, expectedRaw: found.raw });
        } else await m.write();
        new Notice('Backup saved and verified.');
      })
    );
    buttons.createEl('button', { text: 'Restore...' }).addEventListener('click', () =>
      this.run(async () => {
        const found = await m.read();
        if (!found) throw new Error('No backup in this folder.');
        const b = found.bundle;
        if (
          !(await DataConfirmModal.ask(
            this.app,
            'Restore GraphFrontier backup?',
            `${b.layouts.length} layouts and ${b.lists.length} lists, saved ${b.createdAt}. Replaces matching layouts, all lists and current preferences. Other layouts are kept. Current unsaved changes will be replaced.`,
            'Restore'
          ))
        )
          return;
        await m.restore(found.raw);
        new Notice('Backup restored.');
      })
    );
  }
  row(name, description) {
    const row = this.contentEl.createDiv({ cls: 'setting-item' });
    const info = row.createDiv({ cls: 'setting-item-info' });
    info.createDiv({ cls: 'setting-item-name', text: name });
    info.createDiv({ cls: 'setting-item-description', text: description });
    return row.createDiv({ cls: 'setting-item-control' });
  }
  onClose() {
    this.opened = false;
    this.contentEl.empty();
  }
}
module.exports = { BackupsPanel };
