import { Modal, Notice } from 'obsidian';

class DarkEnergyModal extends Modal {
  constructor(view, initial, onSave, options = {}) {
    super(view.app);
    this.view = view;
    this.initial = initial;
    this.onSave = onSave;
    this.onChange = typeof options.onChange === 'function' ? options.onChange : null;
    this.onDelete = typeof options.onDelete === 'function' ? options.onDelete : null;
    this.onCancel = typeof options.onCancel === 'function' ? options.onCancel : null;
  }

  renderEditor(contentEl, closeFn = () => this.close(), { floating = false } = {}) {
    const { view, initial } = this;
    const header = floating ? contentEl.createDiv({ cls: 'graphfrontier-floating-header' }) : null;
    if (header) {
      header.createSpan({ text: 'Gravity node', cls: 'graphfrontier-sidepanel-title' });
      header
        .createEl('button', {
          text: 'x',
          cls: 'graphfrontier-preview-close',
          type: 'button',
          attr: { 'aria-label': 'Close editor' },
        })
        .addEventListener('click', () => {
          this.onCancel?.();
          closeFn();
        });
    } else {
      contentEl.createEl('h2', { text: 'Gravity node', cls: 'graphfrontier-gravity-title' });
    }
    const nameRow = contentEl.createDiv({
      cls: 'graphfrontier-sidepanel-row graphfrontier-gravity-name',
    });
    nameRow.createSpan({ text: 'Name', cls: 'graphfrontier-sidepanel-label' });
    const name = nameRow.createEl('input', { type: 'text', cls: 'graphfrontier-group-query' });
    name.value = initial.name === 'Dark energy' ? 'Gravity node' : initial.name || 'Gravity node';
    name.setAttribute('aria-label', 'Gravity node name');
    const ruleHeader = contentEl.createDiv({ cls: 'graphfrontier-sidepanel-row' });
    ruleHeader.createSpan({ text: 'Rules (any match)', cls: 'graphfrontier-sidepanel-label' });
    const addButton = ruleHeader.createEl('button', {
      text: '+ Rule',
      cls: 'graphfrontier-sidepanel-save',
      type: 'button',
    });
    const rules = contentEl.createDiv({ cls: 'graphfrontier-gravity-rules' });
    const inputs = [];
    let strength;
    let repulsion;
    const emitLive = () => {
      if (!this.onChange || !strength || !repulsion) return;
      const queries = inputs
        .map((input) => input.value.trim())
        .filter((q) => !!view.plugin.parseGroupQuery(q)?.value);
      if (!name.value.trim()) return;
      this.onChange({
        ...initial,
        name: name.value.trim(),
        queries,
        strength: Number(strength.value),
        repulsion: Number(repulsion.value),
      });
    };
    name.addEventListener('input', emitLive);
    const addRule = (query = 'tag:') => {
      const row = rules.createDiv({ cls: 'graphfrontier-group-row' });
      const wrap = row.createDiv({
        cls: 'graphfrontier-group-query-wrap graphfrontier-input-anchor',
      });
      const input = wrap.createEl('input', { cls: 'graphfrontier-group-query', type: 'text' });
      input.value = view.normalizeSearchInput(query);
      input.setAttribute('aria-label', 'Gravity node query');
      inputs.push(input);
      let prefix = view.getSearchInputPrefix(input.value);
      const suggest = () => {
        const showTypes = !prefix || input.selectionStart < prefix.length;
        const pack = showTypes
          ? {
              items: view.getQueryTypeSuggestions('', { allowName: true }),
              menuTitle: 'Search options',
            }
          : view.getGroupQuerySuggestions(input.value);
        view.showInputSuggestMenu(
          input,
          pack.items,
          (value, suggestion) => {
            const suffix = view.parseSearchQuery(input.value).query;
            input.value = suggestion?.kind === 'source' ? value + suffix : value;
            prefix = view.getSearchInputPrefix(input.value);
            input.setSelectionRange(input.value.length, input.value.length);
            emitLive();
          },
          { title: pack.menuTitle || '' }
        );
      };
      input.addEventListener('beforeinput', (event) => view.protectQueryInputPrefix(input, event));
      input.addEventListener('input', () => {
        input.value = view.normalizeSearchInput(input.value, prefix);
        prefix = view.getSearchInputPrefix(input.value);
        suggest();
        emitLive();
      });
      input.addEventListener('click', suggest);
      input.addEventListener('keydown', (event) => {
        if (view.inputSuggestInputEl !== input) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          view.moveInputSuggestSelection(event.key === 'ArrowDown' ? 1 : -1);
        } else if (event.key === 'Enter' || event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          // Enter keeps the typed rule; suggestions can be chosen with Tab or a click.
          view.closeInputSuggestMenu();
          emitLive();
        } else if (event.key === 'Tab') {
          if (view.selectInputSuggestActive()) event.preventDefault();
        }
      });
      row
        .createEl('button', { cls: 'graphfrontier-group-remove', text: 'x', type: 'button' })
        .addEventListener('click', () => {
          if (view.inputSuggestInputEl === input) view.closeInputSuggestMenu();
          inputs.splice(inputs.indexOf(input), 1);
          row.remove();
          emitLive();
        });
    };
    for (const query of initial.queries?.length ? initial.queries : ['tag:']) addRule(query);
    addButton.addEventListener('click', () => addRule());
    const addForceSlider = (label, value) => {
      const strengthRow = contentEl.createDiv({ cls: 'graphfrontier-sidepanel-row is-slider' });
      strengthRow.createSpan({ text: label, cls: 'graphfrontier-sidepanel-label' });
      const slider = strengthRow.createEl('input', {
        type: 'range',
        cls: 'graphfrontier-sidepanel-slider',
      });
      slider.setAttribute('aria-label', `Gravity node ${label.toLowerCase()}`);
      slider.min = '0';
      slider.max = '100';
      slider.step = '1';
      slider.value = String(value);
      const strengthValue = strengthRow.createSpan({
        cls: 'graphfrontier-sidepanel-value',
        text: slider.value,
      });
      slider.addEventListener('input', () => {
        strengthValue.setText(view.formatSliderValue(Number(slider.value), 1));
        emitLive();
      });
      return slider;
    };
    strength = addForceSlider('Attraction', initial.strength ?? 10);
    repulsion = addForceSlider('Repulsion', initial.repulsion ?? 0);
    const footer = contentEl.createDiv({ cls: 'graphfrontier-sidepanel-actions' });
    const actions = footer.createDiv({ cls: 'graphfrontier-sidepanel-actions-row' });
    actions
      .createEl('button', {
        text: floating ? 'Done' : 'Save',
        cls: 'graphfrontier-sidepanel-save',
        type: 'button',
      })
      .addEventListener('click', () => {
        const rawQueries = inputs.map((input) => input.value.trim());
        const validQueries = rawQueries.filter((q) => !!view.plugin.parseGroupQuery(q)?.value);
        if (!floating) {
          if (
            !name.value.trim() ||
            !rawQueries.length ||
            validQueries.length !== rawQueries.length
          ) {
            new Notice('Enter a name and complete every query rule');
            return;
          }
        } else if (!name.value.trim()) {
          new Notice('Enter a gravity node name');
          return;
        }
        const value = Number(strength.value);
        const repulsionValue = Number(repulsion.value);
        if (
          [strength, repulsion].some(
            (input) =>
              !input.value.trim() ||
              !Number.isFinite(Number(input.value)) ||
              Number(input.value) < 0 ||
              Number(input.value) > 100
          )
        ) {
          new Notice('Strength must be between 0 and 100');
          return;
        }
        this.onSave({
          ...initial,
          name: name.value.trim(),
          queries: floating ? validQueries : rawQueries,
          strength: value,
          repulsion: repulsionValue,
        });
        closeFn();
      });
    if (this.onDelete) {
      actions
        .createEl('button', { text: 'Delete', cls: 'graphfrontier-sidepanel-save', type: 'button' })
        .addEventListener('click', () => {
          this.onDelete();
          closeFn();
        });
    } else {
      actions
        .createEl('button', { text: 'Cancel', cls: 'graphfrontier-sidepanel-save', type: 'button' })
        .addEventListener('click', () => {
          this.onCancel?.();
          closeFn();
        });
    }
  }

  onOpen() {
    this.modalEl?.addClass('graphfrontier-gravity-modal');
    this.renderEditor(this.contentEl, () => this.close());
  }

  onClose() {
    this.view.closeInputSuggestMenu();
    this.contentEl.empty();
  }
}

export { DarkEnergyModal };
