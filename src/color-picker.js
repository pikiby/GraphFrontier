const { Modal, Notice } = require('obsidian');

// Native color dialogs are controlled by the OS, not by plugin CSS.
function openColorPicker(app, initial, apply, isCurrent = () => true) {
  const modal = new Modal(app);
  modal.modalEl.addClass('graphfrontier-color-modal');
  modal.titleEl.setText('Choose color');
  const content = modal.contentEl;
  const preview = content.createDiv({ cls: 'graphfrontier-color-preview' });
  const hex = content.createEl('input', { type: 'text', attr: { 'aria-label': 'Hex color' } });
  hex.value = initial;
  const sliders = [];
  const sync = () => {
    save.disabled = !/^#[0-9a-f]{6}$/i.test(hex.value);
    if (save.disabled) return;
    preview.style.backgroundColor = hex.value;
    sliders.forEach((slider, i) => {
      slider.value = String(parseInt(hex.value.slice(1 + i * 2, 3 + i * 2), 16));
    });
  };
  for (const name of ['Red', 'Green', 'Blue']) {
    const row = content.createEl('label', { cls: 'graphfrontier-color-channel' });
    row.createSpan({ text: name });
    const slider = row.createEl('input', {
      type: 'range',
      attr: { min: '0', max: '255', step: '1', 'aria-label': name },
    });
    sliders.push(slider);
    slider.addEventListener('input', () => {
      hex.value = '#' + sliders.map((s) => Number(s.value).toString(16).padStart(2, '0')).join('');
      sync();
    });
  }
  const actions = content.createDiv({ cls: 'graphfrontier-coord-actions' });
  const cancel = actions.createEl('button', { text: 'Cancel' });
  const save = actions.createEl('button', { text: 'Apply' });
  hex.addEventListener('input', sync);
  cancel.addEventListener('click', () => modal.close());
  save.addEventListener('click', () => {
    if (save.disabled) return;
    if (!isCurrent()) {
      new Notice('Layout changed. Reopen the color picker.');
      modal.close();
      return;
    }
    apply(hex.value);
    modal.close();
  });
  sync();
  modal.open();
}

function bindColorPicker(app, input, getContext = () => null) {
  input.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const context = getContext();
    openColorPicker(
      app,
      input.value,
      (color) => {
        input.value = color;
        const Event = input.ownerDocument.defaultView.Event;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      },
      () => getContext() === context
    );
  });
}

module.exports = { bindColorPicker, openColorPicker };
