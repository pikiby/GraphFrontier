const { Modal, Notice } = require('obsidian');

class SubgraphModal extends Modal {
  constructor(view, initial, onSave) {
    super(view.app);
    this.initial = initial;
    this.onSave = onSave;
  }

  onOpen() {
    const { contentEl, initial } = this;
    this.modalEl.addClass('graphfrontier-gravity-modal');
    contentEl.createEl('h2', { text: 'Subgraph', cls: 'graphfrontier-gravity-title' });
    const row = contentEl.createDiv({
      cls: 'graphfrontier-sidepanel-row graphfrontier-gravity-name',
    });
    row.createSpan({ text: 'Name', cls: 'graphfrontier-sidepanel-label' });
    const name = row.createEl('input', { type: 'text', cls: 'graphfrontier-group-query' });
    name.value = initial.name;
    name.setAttribute('aria-label', 'Subgraph name');
    const actions = contentEl.createDiv({ cls: 'graphfrontier-sidepanel-actions-row' });
    actions
      .createEl('button', { text: 'Save', cls: 'graphfrontier-sidepanel-save' })
      .addEventListener('click', () => {
        if (!name.value.trim()) {
          new Notice('Enter a subgraph name');
          return;
        }
        try {
          this.onSave({ ...initial, name: name.value.trim() });
          this.close();
        } catch (error) {
          new Notice(error.message);
        }
      });
    actions
      .createEl('button', { text: 'Cancel', cls: 'graphfrontier-sidepanel-save' })
      .addEventListener('click', () => this.close());
    name.focus();
  }

  onClose() {
    this.contentEl.empty();
  }
}

module.exports = { SubgraphModal };
