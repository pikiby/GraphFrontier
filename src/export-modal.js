const { Modal, TFile, TFolder, AbstractInputSuggest } = require('obsidian');
const { buildVaultExportPath } = require('./vault-export');

// Keep typed folder entry working on older hosts without AbstractInputSuggest.
class VaultFolderSuggest extends (AbstractInputSuggest || class {}) {
  constructor(modal) {
    super(modal.app, modal.folderInput);
    this.modal = modal;
    this.limit = 8;
  }

  getSuggestions(query) {
    if (this.modal.closed || this.modal.busy || this.modal.completed) return [];
    const search = query.trim().replace(/\\/g, '/').toLowerCase();
    const paths = this.modal.app.vault.getAllLoadedFiles().flatMap((entry) => {
      if (!(entry instanceof TFolder) || !entry.path || entry.path === '/') return [];
      try {
        buildVaultExportPath('graph', entry.path);
        return [entry.path];
      } catch {
        return [];
      }
    });
    return ['', ...paths.sort((a, b) => a.localeCompare(b))].filter((path) =>
      (path || 'Vault root').toLowerCase().includes(search)
    );
  }

  renderSuggestion(path, el) {
    el.setText(path || 'Vault root');
  }

  selectSuggestion(path, event) {
    event?.preventDefault();
    event?.stopPropagation();
    if (!this.modal.closed && !this.modal.busy && !this.modal.completed) {
      this.setValue(path);
      this.modal.refreshDestination();
    }
    this.close();
  }
}

class ExportModal extends Modal {
  constructor(app, exportHtml) {
    super(app);
    this.exportHtml = exportHtml;
    this.busy = false;
    this.completed = false;
    this.closed = false;
  }

  onOpen() {
    this.modalEl.addClass('graphfrontier-export-modal');
    this.setTitle('Export graph');
    const { contentEl } = this;
    this.vaultName = this.app.vault.getName();
    const vault = contentEl.createEl('p', {
      cls: 'graphfrontier-export-hint',
      text: 'Save inside vault: ',
    });
    vault.createEl('code', { text: this.vaultName });

    this.form = contentEl.createEl('form', { cls: 'graphfrontier-export-form' });
    const folderLabel = this.form.createEl('label', { text: 'Folder' });
    this.folderInput = folderLabel.createEl('input', {
      type: 'text',
      placeholder: 'Vault root',
    });
    this.folderInput.value = '';
    this.folderInput.setAttribute('aria-label', 'Folder inside vault (optional)');
    this.folderInput.setAttribute('autocapitalize', 'off');
    this.folderInput.setAttribute('spellcheck', 'false');
    const filenameLabel = this.form.createEl('label', { text: 'Filename' });
    this.filenameInput = filenameLabel.createEl('input', { type: 'text' });
    this.filenameInput.value = 'graphfrontier-static.html';
    this.filenameInput.setAttribute('aria-label', 'Export filename');
    this.filenameInput.setAttribute('autocapitalize', 'off');
    this.filenameInput.setAttribute('spellcheck', 'false');
    this.errorEl = contentEl.createDiv({ cls: 'graphfrontier-export-error' });
    this.errorEl.setAttribute('role', 'alert');
    this.successEl = contentEl.createDiv({ cls: 'graphfrontier-export-success' });
    this.successEl.setAttribute('role', 'status');
    this.successEl.hidden = true;
    const actions = contentEl.createDiv({ cls: 'graphfrontier-export-actions' });
    this.cancelButton = actions.createEl('button', { text: 'Cancel', type: 'button' });
    this.openButton = actions.createEl('button', {
      text: 'Open file',
      type: 'button',
      cls: 'mod-cta',
    });
    this.openButton.hidden = true;
    this.openButton.addEventListener('click', () => this.openFile());
    this.submitButton = actions.createEl('button', {
      text: 'Export',
      type: 'button',
      cls: 'mod-cta',
    });
    this.cancelButton.addEventListener('click', () => {
      if (!this.busy) this.close();
    });
    this.submitButton.addEventListener('click', () => this.submit(this.replacePath));
    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
    });
    for (const input of [this.filenameInput, this.folderInput]) {
      input.addEventListener('input', () => this.refreshDestination());
    }
    // Folder Enter belongs to the native suggestion selector, never to export.
    this.filenameInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.isComposing) return;
      event.preventDefault();
      void this.submit();
    });
    if (typeof AbstractInputSuggest === 'function')
      this.folderSuggest = new VaultFolderSuggest(this);
    this.refreshDestination();
    this.filenameInput.focus();
    this.filenameInput.setSelectionRange(0, this.filenameInput.value.length - 5);
  }

  showError(message = '') {
    this.errorEl.setText(message);
    this.errorEl.hidden = !message;
  }

  refreshDestination() {
    this.showError();
    this.replacePath = null;
    this.submitButton.disabled = this.busy || this.completed;
    try {
      const path = buildVaultExportPath(this.filenameInput.value, this.folderInput.value);
      this.destinationPath = path;
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing && !(existing instanceof TFile)) {
        throw new Error('The export filename points to a folder. Choose another filename.');
      }
      this.replacePath = existing ? path : null;
      this.submitButton.setText(this.replacePath ? 'Replace file' : 'Export');
      return path;
    } catch (error) {
      this.destinationPath = null;
      this.showError(error?.message || 'Unable to check the export destination.');
      this.submitButton.disabled = true;
      this.submitButton.setText('Export');
      return null;
    }
  }

  setBusy(busy) {
    this.busy = busy;
    for (const input of [this.filenameInput, this.folderInput]) {
      input.disabled = busy || this.completed;
    }
    this.cancelButton.disabled = busy;
    this.submitButton.disabled = busy || this.completed || !this.destinationPath;
    this.submitButton.setText(busy ? 'Exporting...' : this.replacePath ? 'Replace file' : 'Export');
    this.contentEl.setAttribute('aria-busy', String(busy));
    if (busy) this.folderSuggest?.close();
  }

  async submit(replacePath = null) {
    if (this.busy || this.completed || this.closed) return;
    const consentPath = replacePath === this.destinationPath ? replacePath : null;
    const path = this.refreshDestination();
    if (!path) return;
    const overwrite = this.replacePath === path && consentPath === path;
    if (this.replacePath && !overwrite) {
      this.showError('File exists. Confirm replacement with Replace file.');
      return;
    }
    this.setBusy(true);
    try {
      const result = await this.exportHtml({
        exportPath: path,
        overwrite,
        assertCurrent: () => {
          if (this.closed) throw new Error('Export cancelled');
        },
      });
      if (this.closed) return;
      if (!result || result.path !== path) {
        throw new Error('The export did not complete. No successful save was reported.');
      }
      this.completed = true;
      this.resultPath = result.path;
      this.form.hidden = true;
      this.submitButton.hidden = true;
      this.showError();
      this.successEl.hidden = false;
      this.successEl.createEl('strong', { text: 'Saved' });
      this.successEl.createEl('code', { text: result.path });
      this.openButton.hidden = false;
      this.cancelButton.setText('Close');
    } catch (error) {
      if (!this.closed) {
        // Refresh after a race so a newly created target can be explicitly replaced.
        this.refreshDestination();
        this.showError(error?.message || 'Export failed. Try again.');
      }
    } finally {
      this.busy = false;
      if (!this.closed) {
        this.setBusy(false);
        if (this.completed) this.cancelButton.focus();
      }
    }
  }

  async openFile() {
    if (this.closed || !this.completed || this.opening) return;
    this.opening = true;
    this.openButton.disabled = true;
    this.showError();
    try {
      if (typeof this.app.openWithDefaultApp !== 'function') {
        throw new Error('Opening files is unavailable on this device. Use the saved path.');
      }
      await this.app.openWithDefaultApp(this.resultPath);
    } catch (error) {
      if (!this.closed) this.showError(error?.message || 'Could not open the saved file.');
    } finally {
      this.opening = false;
      if (!this.closed) this.openButton.disabled = false;
    }
  }

  onClose() {
    this.closed = true;
    this.folderSuggest?.close();
    this.contentEl.empty();
  }
}

module.exports = { ExportModal };
