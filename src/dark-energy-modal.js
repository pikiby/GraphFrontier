const { Modal, Notice } = require('obsidian');

class DarkEnergyModal extends Modal {
  constructor(view, initial, onSave) {
    super(view.app);
    this.view = view;
    this.initial = initial;
    this.onSave = onSave;
  }

  onOpen() {
    const { contentEl, view, initial } = this;
    this.modalEl?.addClass('graphfrontier-gravity-modal');
    contentEl.createEl('h2', { text: 'Gravity node', cls: 'graphfrontier-gravity-title' });
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
    });
    const rules = contentEl.createDiv({ cls: 'graphfrontier-gravity-rules' });
    const inputs = [];
    const addRule = (query = 'name:') => {
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
        const showTypes =
          !view.parseSearchQuery(input.value).query || input.selectionStart < prefix.length;
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
          },
          { title: pack.menuTitle || '' }
        );
      };
      input.addEventListener('beforeinput', (event) => view.protectQueryInputPrefix(input, event));
      input.addEventListener('input', () => {
        input.value = view.normalizeSearchInput(input.value, prefix);
        prefix = view.getSearchInputPrefix(input.value);
        suggest();
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
        } else if (event.key === 'Tab') {
          if (view.selectInputSuggestActive()) event.preventDefault();
        }
      });
      row
        .createEl('button', { cls: 'graphfrontier-group-remove', text: 'x' })
        .addEventListener('click', () => {
          if (view.inputSuggestInputEl === input) view.closeInputSuggestMenu();
          inputs.splice(inputs.indexOf(input), 1);
          row.remove();
        });
    };
    for (const query of initial.queries?.length ? initial.queries : ['name:']) addRule(query);
    addButton.addEventListener('click', () => addRule());
    const addForceSlider = (label, value) => {
      const strengthRow = contentEl.createDiv({ cls: 'graphfrontier-sidepanel-row is-slider' });
      strengthRow.createSpan({ text: label, cls: 'graphfrontier-sidepanel-label' });
      const strength = strengthRow.createEl('input', {
        type: 'range',
        cls: 'graphfrontier-sidepanel-slider',
      });
      strength.setAttribute('aria-label', `Gravity node ${label.toLowerCase()}`);
      strength.min = '0';
      strength.max = '100';
      strength.step = '1';
      strength.value = String(value);
      const strengthValue = strengthRow.createSpan({
        cls: 'graphfrontier-sidepanel-value',
        text: strength.value,
      });
      strength.addEventListener('input', () =>
        strengthValue.setText(view.formatSliderValue(Number(strength.value), 1))
      );
      return strength;
    };
    const strength = addForceSlider('Attraction', initial.strength ?? 10);
    const repulsion = addForceSlider('Repulsion', initial.repulsion ?? 0);
    const footer = contentEl.createDiv({ cls: 'graphfrontier-sidepanel-actions' });
    const actions = footer.createDiv({ cls: 'graphfrontier-sidepanel-actions-row' });
    actions
      .createEl('button', { text: 'Save', cls: 'graphfrontier-sidepanel-save' })
      .addEventListener('click', () => {
        const queries = inputs.map((input) => input.value.trim());
        if (
          !name.value.trim() ||
          !queries.length ||
          queries.some((query) => !view.plugin.parseGroupQuery(query)?.value)
        ) {
          new Notice('Enter a name and complete every query rule');
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
          queries,
          strength: value,
          repulsion: repulsionValue,
        });
        this.close();
      });
    actions
      .createEl('button', { text: 'Cancel', cls: 'graphfrontier-sidepanel-save' })
      .addEventListener('click', () => this.close());
  }

  onClose() {
    this.view.closeInputSuggestMenu();
    this.contentEl.empty();
  }
}

module.exports = { DarkEnergyModal };
