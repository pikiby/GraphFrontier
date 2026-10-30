const { Modal } = require('obsidian');
class DataConfirmModal extends Modal {
  static ask(app, title, message, action = 'Confirm') {
    return new Promise((resolve) =>
      new DataConfirmModal(app, title, message, action, resolve).open()
    );
  }
  constructor(app, title, message, action, resolve) {
    super(app);
    Object.assign(this, { heading: title, message, action, resolve, accepted: false });
  }
  onOpen() {
    this.setTitle(this.heading);
    this.contentEl.createEl('p', { text: this.message });
    const actions = this.contentEl.createDiv({ cls: 'graphfrontier-node-list-actions' });
    actions.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    actions
      .createEl('button', { text: this.action, cls: 'mod-warning' })
      .addEventListener('click', () => {
        this.accepted = true;
        this.close();
      });
  }
  onClose() {
    this.resolve(this.accepted);
    this.contentEl.empty();
  }
}
module.exports = { DataConfirmModal };
