const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadSource } = require('./helpers/obsidian.cjs');
const { GraphFrontierView } = loadSource('view.js');

function setup() {
  const input = {
    style: {},
    events: {},
    focus() {
      this.focused = true;
    },
    click() {
      this.clicked = true;
    },
    remove() {
      this.removed = true;
    },
  };
  const applied = [];
  const doc = { createElement: () => input, body: { appendChild() {} } };
  let layout = 'main';
  const view = Object.assign(Object.create(GraphFrontierView.prototype), {
    contentEl: { ownerDocument: doc, win: { innerWidth: 800, innerHeight: 600 } },
    selectedNodeIds: new Set(['a']),
    nodeById: new Map([
      ['a', { id: 'a' }],
      ['b', { id: 'b' }],
    ]),
    plugin: {
      data: {},
      getActiveLayoutFileName: () => layout,
      getPaintedEdgeColor: () => '#446688',
      setPaintedEdgeColor: (id, color) => applied.push({ id, color }),
      renderAllViews() {},
    },
    registerDomEvent: (el, event, handler) => {
      el.events[event] = handler;
    },
  });
  return {
    view,
    input,
    applied,
    setLayout: (value) => {
      layout = value;
    },
  };
}

test('edge color opens the native color input at the pointer', async () => {
  const { view, input } = setup();
  await GraphFrontierView.prototype.promptPickPaintedEdgeColor.call(view, 'a', 120, 160);
  assert.equal(input.type, 'color');
  assert.equal(input.value, '#446688');
  assert.equal(input.style.left, '120px');
  assert.equal(input.style.top, '160px');
  assert.equal(input.clicked, true);
});

test('native color input and change apply the selected edge color', async () => {
  const { view, input, applied } = setup();
  await GraphFrontierView.prototype.promptPickPaintedEdgeColor.call(view, 'a');
  assert.equal(input.style.left, '400px');
  input.value = '#123456';
  input.events.input();
  input.events.change();
  assert.deepEqual(applied, [
    { id: 'a', color: '#123456' },
    { id: 'a', color: '#123456' },
  ]);
});

for (const [name, invalidate] of [
  [
    'data replacement',
    ({ view }) => {
      view.plugin.data = {};
    },
  ],
  [
    'layout switch',
    ({ setLayout }) => {
      setLayout('other');
    },
  ],
  [
    'scope switch',
    ({ view }) => {
      view.subgraphScope = { id: 'other' };
    },
  ],
  [
    'node removal',
    ({ view }) => {
      view.nodeById.delete('a');
    },
  ],
]) {
  for (const event of ['input', 'change']) {
    test(`native edge picker cleans up on ${name} during ${event} without retargeting`, async () => {
      const fixture = setup();
      const { view, input, applied } = fixture;
      await view.promptPickPaintedEdgeColor('a');
      invalidate(fixture);
      view.selectedNodeIds = new Set(['b']);
      input.value = '#123456';
      input.events[event]();
      assert.deepEqual(applied, []);
      assert.equal(input.removed, true);
    });
  }
}

test('swatches retain compact styling without a replacement color modal', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/view.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../src/static/styles.css'), 'utf8');
  assert.doesNotMatch(source, /bindColorPicker|openColorPicker/);
  assert.doesNotMatch(css, /graphfrontier-color-modal/);
  assert.match(css, /input\.graphfrontier-group-color-input\s*\{\s*width: 26px/);
});

function attachmentPopoverFixture() {
  const eventTarget = () => ({
    events: new Map(),
    addEventListener(name, handler) {
      if (!this.events.has(name)) this.events.set(name, new Set());
      this.events.get(name).add(handler);
    },
    removeEventListener(name, handler) {
      this.events.get(name)?.delete(handler);
    },
    fire(name, event = {}) {
      for (const handler of [...(this.events.get(name) || [])]) handler(event);
    },
  });
  const win = Object.assign(eventTarget(), {
    innerWidth: 1920,
    innerHeight: 1080,
    requestAnimationFrame() {},
    setTimeout() {},
  });
  win.visualViewport = Object.assign(eventTarget(), { width: 1920, height: 1080 });
  const doc = Object.assign(eventTarget(), { defaultView: win });
  const element = (tag, options = {}) =>
    Object.assign(eventTarget(), {
      tag,
      ...options,
      children: [],
      style: {},
      attributes: { ...options.attr },
      ownerDocument: doc,
      isConnected: true,
      offsetHeight: 300,
      value: '',
      classList: { add() {}, remove() {} },
      toggleClass() {},
      scrollIntoView() {},
      setSelectionRange(start, end) {
        this.selectionStart = start;
        this.selectionEnd = end;
      },
      appendChild(child) {
        child.parentElement = this;
        this.children.push(child);
      },
      createEl(tag, options) {
        const child = element(tag, options);
        this.appendChild(child);
        return child;
      },
      createDiv(options) {
        return this.createEl('div', options);
      },
      createSpan(options) {
        return this.createEl('span', options);
      },
      empty() {
        this.children = [];
      },
      setText(text) {
        this.text = text;
      },
      setAttr(key, value) {
        this.attributes[key] = value;
      },
      setAttribute(key, value) {
        this.setAttr(key, value);
      },
      contains(target) {
        return target === this || this.children.some((child) => child.contains(target));
      },
      remove() {
        this.isConnected = false;
        this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
      },
      focus() {
        this.focused = true;
        if (doc.activeElement === this) return;
        doc.activeElement = this;
        this.fire('focus');
      },
      getBoundingClientRect() {
        return { left: 1662, top: 800, bottom: 830, width: 250 };
      },
    });
  doc.body = element('body');
  doc.createElement = (tag) => element(tag);
  const parent = element('div');
  let inventory = [
    ['png', 8],
    ['pdf', 2],
    ['', 1],
  ];
  let enumerations = 0;
  let refreshes = 0;
  const view = Object.assign(Object.create(GraphFrontierView.prototype), {
    contentEl: { ownerDocument: doc, win },
    registerDomEvent(el, name, handler) {
      el.addEventListener(name, handler);
    },
    plugin: {
      data: { settings: { excluded_attachment_extensions: [] } },
      schedulePersist() {},
      getAttachmentExtensionInventory() {
        enumerations++;
        return inventory;
      },
    },
    applyRefreshMode(mode) {
      assert.equal(mode, 'data');
      refreshes++;
    },
  });
  GraphFrontierView.prototype.buildAttachmentFileTypesControl.call(view, parent);
  const row = parent.children[0];
  const wrap = row.children[0];
  const [trigger, clear] = wrap.children;
  return {
    view,
    row,
    wrap,
    trigger,
    clear,
    doc,
    win,
    element,
    select(value) {
      const entry = view.inputSuggestMenu.selectableEntries.find(
        (item) => item.suggestion.value === value
      );
      entry.itemEl.fire('click', { preventDefault() {}, stopPropagation() {} });
      return entry;
    },
    open() {
      trigger.fire('click');
      return doc.body.children.at(-1);
    },
    setInventory(next) {
      inventory = next;
    },
    get enumerations() {
      return enumerations;
    },
    get refreshes() {
      return refreshes;
    },
  };
}

test('attachment types reuse the shared full-width search and keep selection open', () => {
  const f = attachmentPopoverFixture();
  assert.equal(f.row.cls, 'graphfrontier-find-row');
  assert.equal(f.row.children.length, 1, 'no separate label');
  assert.match(f.wrap.cls, /graphfrontier-search-input-wrap graphfrontier-input-anchor/);
  assert.equal(f.trigger.tag, 'input');
  assert.equal(f.trigger.type, 'text');
  assert.equal(f.trigger.placeholder, 'File types');
  assert.equal(f.trigger.cls, 'graphfrontier-find-input');
  assert.equal(f.trigger.value, 'File type: All file types');
  assert.equal(f.clear.cls, 'graphfrontier-search-inline-clear');
  assert.equal(f.enumerations, 1);
  const popup = f.open();
  assert.equal(f.trigger.value, 'File type: ');
  assert.equal(popup.className, 'graphfrontier-input-menu');
  const item = popup.children[1].children[0];
  assert.equal(item.className, 'graphfrontier-input-menu-item');
  assert.equal(item.children[1].className, 'graphfrontier-input-menu-main');
  assert.equal(item.children[2].className, 'graphfrontier-input-menu-count');
  assert.equal(item.children[2].textContent, '8');
  assert.equal(popup.style.width, '250px');
  assert.equal(popup.style.left, '1662px');
  assert.equal(popup.style.top, '548px');
  assert.equal(popup.style.maxHeight, '248px');
  const checkbox = item.children[0];
  checkbox.checked = false;
  checkbox.fire('change');
  assert.deepEqual(f.view.plugin.data.settings.excluded_attachment_extensions, ['png']);
  assert.equal(checkbox.checked, false);
  assert.equal(f.refreshes, 1);
  assert.equal(f.trigger.value, 'File type: .pdf, No extension');
  assert.equal(popup.isConnected, true);
  assert.equal(popup.children[1].children[0].children[0], checkbox, 'keep menu DOM intact');
  assert.equal(f.trigger.attributes['aria-expanded'], 'true');
  assert.equal(f.trigger.focused, undefined, 'no graph or trigger autofocus on construction/open');
  f.trigger.fire('beforeinput', { inputType: 'insertText', data: 'p', preventDefault() {} });
  assert.equal(f.trigger.value, 'File type: ', 'next typing replaces the summary, not the prefix');
  f.trigger.value += 'p';
  f.trigger.fire('input');
  assert.equal(f.view.inputSuggestMenu.selectableEntries.length, 4);
  assert.deepEqual(f.view.plugin.data.settings.excluded_attachment_extensions, ['png']);
});

test('attachment search narrows All/None inventory, clear preserves selections, reopening refreshes counts', () => {
  const f = attachmentPopoverFixture();
  f.view.plugin.data.settings.excluded_attachment_extensions = ['absent'];
  f.open();
  const search = f.trigger;
  search.value = '.PnG';
  search.fire('input');
  assert.equal(f.view.inputSuggestMenu.selectableEntries.length, 3);
  f.select('none');
  assert.deepEqual(f.view.plugin.data.settings.excluded_attachment_extensions, ['absent', 'png']);
  f.select('all');
  assert.deepEqual(f.view.plugin.data.settings.excluded_attachment_extensions, ['absent']);
  f.select('none');
  f.clear.fire('click', { preventDefault() {}, stopPropagation() {} });
  assert.equal(search.value, 'File type: ');
  assert.deepEqual(f.view.plugin.data.settings.excluded_attachment_extensions, ['absent', 'png']);
  f.select('none');
  assert.deepEqual(f.view.plugin.data.settings.excluded_attachment_extensions, [
    'absent',
    'png',
    'pdf',
    '',
  ]);
  f.select('all');
  assert.deepEqual(f.view.plugin.data.settings.excluded_attachment_extensions, ['absent']);
  f.doc.fire('mousedown', { target: f.doc.body });
  f.setInventory([['webp', 12]]);
  const reopened = f.open();
  assert.equal(reopened.children[1].children[0].children[1].textContent, '.webp');
  assert.equal(reopened.children[1].children[0].children[2].textContent, '12');
  assert.equal(f.enumerations, 3);
});

test('shared attachment menu closes outside/on Escape/blur and removes listeners', () => {
  const f = attachmentPopoverFixture();
  for (let i = 0; i < 3; i++) {
    const popup = f.open();
    f.doc.fire('mousedown', { target: popup.children[0] });
    assert.equal(popup.isConnected, true);
    let stopped = false;
    f.trigger.fire('keydown', {
      key: 'a',
      stopPropagation() {
        stopped = true;
      },
    });
    assert.equal(stopped, true);
    if (i === 0) f.doc.fire('mousedown', { target: f.doc.body });
    else if (i === 1)
      f.trigger.fire('keydown', {
        key: 'Escape',
        preventDefault() {},
        stopPropagation() {},
      });
    else f.trigger.fire('blur');
    assert.equal(popup.isConnected, false);
    assert.equal(f.trigger.attributes['aria-expanded'], 'false');
    assert.equal(f.trigger.value, 'File type: All file types');
    assert.equal(f.doc.body.children.length, 0, 'closing never reopens');
    for (const target of [f.doc, f.win, f.win.visualViewport]) {
      for (const handlers of target.events.values()) assert.equal(handlers.size, 0);
    }
  }
  assert.equal(f.trigger.focused, undefined, 'closing never forces focus');
});

test('attachment popover clamps to the mobile visual viewport and closes when its anchor detaches', () => {
  const f = attachmentPopoverFixture();
  Object.assign(f.win.visualViewport, { width: 230, height: 240, offsetTop: 40, offsetLeft: 5 });
  const popup = f.open();
  assert.equal(popup.style.width, '214px');
  assert.equal(popup.style.maxHeight, '224px');
  assert.equal(popup.style.left, '13px');
  assert.equal(popup.style.top, '48px');
  f.trigger.isConnected = false;
  f.win.visualViewport.fire('resize');
  assert.equal(popup.isConnected, false);
});

test('attachment lifecycle and compact dimensions use opt-in shared styles', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/view.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../src/static/styles.css'), 'utf8');
  assert.doesNotMatch(source, /closeAttachmentFileTypesPopover/);
  assert.match(
    source,
    /buildSidePanel\(\) \{\s*if \(!this\.sidePanelEl\) return;\s*this\.closeInputSuggestMenu\(\)/
  );
  assert.match(
    source,
    /if \(!this\.plugin\.data\.settings\.hide_attachments\) \{\s*this\.buildAttachmentFileTypesControl/
  );
  assert.doesNotMatch(source, /graphfrontier-attachment-types-hint/);
  assert.match(css, /\.graphfrontier-input-menu\s*\{[^}]*overflow-y: auto;/);
  assert.match(css, /\.graphfrontier-input-menu-count\s*\{[^}]*color: var\(--text-muted\)/);
  assert.match(css, /\.graphfrontier-input-menu-count\s*\{[^}]*font-size: 10px/);
  assert.doesNotMatch(css, /graphfrontier-attachment-types/);
  const popupStyles = css.match(/\.graphfrontier-input-menu-match-width\s*\{([^}]*)\}/)[1];
  assert.doesNotMatch(popupStyles, /background:|padding:|box-shadow:|border-radius:|z-index:/);
  assert.match(popupStyles, /min-width: 0/);
  const customField = css.match(
    /\.graphfrontier-file-types-search input\.graphfrontier-find-input\s*\{([^}]*)\}/
  )[1];
  assert.doesNotMatch(customField, /(?:height|font-size|padding):/);
  assert.match(
    css,
    /\.graphfrontier-sidepanel input\.graphfrontier-find-input,[^{]*\{[^}]*height: 28px;[^}]*font-size: 12px;/
  );
  assert.match(
    css,
    /\.graphfrontier-input-menu-list\s*\{[^}]*min-height: 0;[^}]*overflow-y: auto;/
  );
  assert.match(css, /\.graphfrontier-input-menu-controls\s*\{[^}]*flex: 0 0 auto;/);
});

test('file type prefix protects deletion and replacement without blocking suffix editing', () => {
  const f = attachmentPopoverFixture();
  f.open();
  const prefix = 'File type: ';
  for (const [start, end, inputType, blocked] of [
    [0, 0, 'deleteContentForward', true],
    [0, prefix.length, 'deleteContentBackward', true],
    [prefix.length, prefix.length, 'deleteContentBackward', true],
    [prefix.length, prefix.length, 'deleteContentForward', false],
    [0, prefix.length + 3, 'deleteByCut', false],
    [0, prefix.length + 3, 'insertFromPaste', false],
  ]) {
    f.trigger.value = prefix + 'png';
    f.trigger.setSelectionRange(start, end);
    let prevented = false;
    f.trigger.fire('beforeinput', {
      inputType,
      preventDefault() {
        prevented = true;
      },
    });
    assert.equal(prevented, blocked, inputType);
    if (!blocked && start < prefix.length) {
      assert.equal(f.trigger.selectionStart, prefix.length);
      assert.equal(f.trigger.selectionEnd, end);
    }
  }
});

test('multi menu fits available space on either side without crossing the input', () => {
  const f = attachmentPopoverFixture();
  Object.assign(f.win.visualViewport, { width: 390, height: 300, offsetTop: 40 });
  let top = 180;
  f.trigger.getBoundingClientRect = () => ({ left: 20, top, bottom: top + 28, width: 250 });
  const menu = f.open();
  assert.equal(menu.style.maxHeight, '128px');
  assert.equal(menu.style.top, '48px');
  assert.equal(menu.children[0].className, 'graphfrontier-input-menu-controls');
  assert(menu.children[0].children.every((child) => child.tag === 'button'));
  assert.equal(menu.children[1].className, 'graphfrontier-input-menu-list');
  top = 50;
  f.win.visualViewport.fire('scroll');
  assert.equal(menu.style.maxHeight, '248px');
  assert.equal(menu.style.top, '82px');
  f.win.visualViewport.height = 180;
  f.win.visualViewport.fire('resize');
  assert.equal(menu.style.maxHeight, '130px');
  assert.equal(menu.style.top, '82px');
});

test('attachment inline focus/click/input open one menu and typing retains focus without graph shortcuts', () => {
  const f = attachmentPopoverFixture();
  f.trigger.focus();
  const popup = f.doc.body.children.at(-1);
  assert.equal(f.enumerations, 2);
  f.trigger.fire('click');
  assert.equal(f.doc.body.children.length, 1, 'click after focus does not toggle or duplicate');
  assert.equal(popup.isConnected, true);
  f.doc.fire('mousedown', { target: f.trigger });
  assert.equal(popup.isConnected, true);
  for (const key of ['a', ' ', 'ArrowLeft', 'Backspace']) {
    for (const name of ['keydown', 'keypress', 'keyup']) {
      let stopped = false;
      let prevented = false;
      f.trigger.fire(name, {
        key,
        stopPropagation() {
          stopped = true;
        },
        preventDefault() {
          prevented = true;
        },
      });
      assert.equal(stopped, true);
      assert.equal(prevented, false, 'native text editing remains available');
    }
  }
  for (const [query, labels] of [
    [' PnG ', ['.png']],
    ['xyz', ['No matching file types']],
    ['', ['.png', '.pdf', 'No extension']],
  ]) {
    f.trigger.value = query;
    f.trigger.fire('input');
    const current = f.view.inputSuggestMenu;
    const matches = current.selectableEntries.filter((entry) => entry.checkbox);
    assert.deepEqual(
      matches.length
        ? matches.map((entry) => entry.suggestion.title)
        : [current.menuEl.children[1].children[0].textContent],
      labels
    );
    assert.equal(f.doc.activeElement, f.trigger);
    assert.equal(f.trigger.value, 'File type: ' + query);
    assert.equal(f.enumerations, 2, 'typing does not enumerate the vault again');
  }
  f.view.closeInputSuggestMenu();
});

test('attachment keyboard selection stays open and Escape shows selected summary without reopening', () => {
  const f = attachmentPopoverFixture();
  f.trigger.focus();
  const popup = f.doc.body.children.at(-1);
  const checkbox = popup.children[1].children[0].children[0];
  f.trigger.fire('keydown', { key: 'Enter', preventDefault() {}, stopPropagation() {} });
  assert.equal(popup.isConnected, true);
  assert.equal(checkbox.checked, false);
  assert.equal(f.doc.activeElement, f.trigger);
  f.trigger.fire('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(f.doc.activeElement, f.trigger);
  assert.equal(f.trigger.attributes['aria-expanded'], 'false');
  assert.equal(popup.isConnected, false);
  assert.equal(f.doc.body.children.length, 0, 'closing does not reopen');
  assert.equal(f.trigger.value, 'File type: .pdf, No extension');
  f.trigger.value = 'pdf';
  f.trigger.fire('input');
  const reopened = f.doc.body.children.at(-1);
  assert.equal(reopened.isConnected, true);
  assert.equal(reopened.children[1].children[0].children[1].textContent, '.pdf');
  assert.equal(f.doc.activeElement, f.trigger);
  assert.deepEqual(f.view.plugin.data.settings.excluded_attachment_extensions, ['png']);
  f.view.closeInputSuggestMenu();
});

test('attachment inline Escape replaces query with summary and click starts an empty query', () => {
  const f = attachmentPopoverFixture();
  f.trigger.focus();
  f.trigger.value = 'png';
  f.trigger.fire('input');
  f.trigger.fire('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(f.trigger.attributes['aria-expanded'], 'false');
  assert.equal(f.trigger.value, 'File type: All file types');
  assert.equal(f.enumerations, 2);
  const popup = f.open();
  assert.equal(popup.children[0].children.length, 2, 'pinned bulk buttons');
  assert.equal(popup.children[1].children.length, 3, 'separate format list');
  assert.equal(f.trigger.value, 'File type: ');
  assert.equal(f.enumerations, 3);
  f.view.closeInputSuggestMenu();
});

test('No extension maps to the empty exclusion for mouse and keyboard without closing', () => {
  const f = attachmentPopoverFixture();
  f.open();
  const menu = f.view.inputSuggestMenu;
  f.select('__no_extension__');
  assert.deepEqual(f.view.plugin.data.settings.excluded_attachment_extensions, ['']);
  menu.activeIndex = 2;
  assert.equal(f.view.selectInputSuggestActive(), true);
  assert.deepEqual(f.view.plugin.data.settings.excluded_attachment_extensions, []);
  assert.equal(menu.selectableEntries[2].checkbox.checked, true);
  assert.equal(f.view.inputSuggestMenu, menu);
});

test('actual Find and group callers retain shared single mouse and keyboard selection', (t) => {
  const { fixture } = require('./helpers/obsidian.cjs');
  const { view } = fixture(t);
  const dom = attachmentPopoverFixture();
  view.contentEl.ownerDocument = dom.doc;
  view.contentEl.win = dom.win;
  view.registerDomEvent = (el, name, handler) => el.addEventListener(name, handler);
  view.buildFindSection(dom.element('div'));
  view.searchInputEl.fire('click');
  let menu = view.inputSuggestMenu;
  assert.equal(menu.multiSelect, false);
  assert.equal(menu.menuEl.style.width, '320px');
  const tag = menu.selectableEntries.find((entry) => entry.suggestion.value === 'tag:');
  assert.equal(tag.checkbox, null);
  tag.itemEl.fire('mousedown', { preventDefault() {}, stopPropagation() {} });
  assert.equal(view.searchInputEl.value, 'tag:');
  assert.equal(view.inputSuggestMenu, null);
  view.buildGroupEditorSection(dom.element('div'));
  const input = view.groupEditorRows[0].queryInput;
  input.fire('focus');
  menu = view.inputSuggestMenu;
  assert.equal(menu.multiSelect, false);
  const index = menu.selectableEntries.findIndex((entry) => entry.suggestion.value === 'path:');
  assert(index >= 0);
  menu.activeIndex = index;
  input.fire('keydown', { key: 'Enter', preventDefault() {}, stopPropagation() {} });
  assert.equal(input.value, 'path:');
  assert.equal(view.inputSuggestMenu, null);
});

test('empty attachment inventory bulk actions preserve absent exclusions and new types start included', () => {
  const f = attachmentPopoverFixture();
  f.view.plugin.data.settings.excluded_attachment_extensions = ['png'];
  f.setInventory([]);
  f.open();
  assert.equal(
    f.view.inputSuggestMenu.selectableEntries.filter((entry) => entry.checkbox).length,
    0
  );
  f.select('none');
  f.select('all');
  assert.deepEqual(f.view.plugin.data.settings.excluded_attachment_extensions, ['png']);
  f.view.closeInputSuggestMenu();
  f.setInventory([
    ['png', 1],
    ['webp', 1],
  ]);
  f.open();
  const entries = f.view.inputSuggestMenu.selectableEntries;
  assert.equal(entries.find((entry) => entry.suggestion.value === 'png').checkbox.checked, false);
  assert.equal(entries.find((entry) => entry.suggestion.value === 'webp').checkbox.checked, true);
  f.view.closeInputSuggestMenu();
});

test('a stale edge picker cannot apply after its original layout becomes current again', async () => {
  const f = setup();
  await f.view.promptPickPaintedEdgeColor('a');
  f.setLayout('other');
  f.input.value = '#123456';
  f.input.events.input();
  assert.equal(f.input.removed, true);
  f.setLayout('main');
  f.input.events.change();
  assert.deepEqual(f.applied, []);
});
