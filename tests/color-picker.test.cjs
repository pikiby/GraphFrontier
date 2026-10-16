const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function setup() {
  let modal;
  const notices = [];
  function element(tag = '', options = {}) {
    return {
      tag,
      ...options,
      children: [],
      events: {},
      style: {},
      addClass() {},
      setText(text) {
        this.text = text;
      },
      createDiv(options) {
        return this.createEl('div', options);
      },
      createSpan(options) {
        return this.createEl('span', options);
      },
      createEl(tag, options) {
        const child = element(tag, options);
        this.children.push(child);
        return child;
      },
      addEventListener(name, callback) {
        this.events[name] = callback;
      },
    };
  }
  class Modal {
    constructor() {
      modal = this;
      this.modalEl = element();
      this.titleEl = element();
      this.contentEl = element();
    }
    open() {
      this.opened = true;
    }
    close() {
      this.closed = true;
    }
  }
  const sandbox = {
    module: { exports: {} },
    require: () => ({
      Modal,
      Notice: class {
        constructor(text) {
          notices.push(text);
        }
      },
    }),
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../src/color-picker.js'), 'utf8'),
    sandbox
  );
  function controls() {
    const children = modal.contentEl.children;
    return {
      modal,
      hex: children.find((e) => e.type === 'text'),
      sliders: children.filter((e) => e.tag === 'label').map((e) => e.children[1]),
      cancel: children.at(-1).children[0],
      apply: children.at(-1).children[1],
    };
  }
  return { ...sandbox.module.exports, controls, element, notices };
}

test('invalid HEX cannot apply; RGB edit restores Apply with a valid color', () => {
  const h = setup(),
    applied = [];
  h.openColorPicker({}, '#446688', (value) => applied.push(value));
  const { hex, sliders, apply, modal } = h.controls();
  assert.equal(modal.titleEl.text, 'Choose color');
  hex.value = 'invalid';
  hex.events.input();
  assert.equal(apply.disabled, true);
  apply.events.click();
  assert.deepEqual(applied, []);
  sliders[0].value = '100';
  sliders[0].events.input();
  assert.equal(hex.value, '#646688');
  assert.equal(apply.disabled, false);
  apply.events.click();
  assert.deepEqual(applied, ['#646688']);
  assert.equal(modal.closed, true);
});

test('Cancel leaves color unchanged and valid HEX synchronizes RGB controls', () => {
  const h = setup();
  let applied = false;
  h.openColorPicker({}, '#446688', () => {
    applied = true;
  });
  const { hex, sliders, cancel, modal } = h.controls();
  hex.value = '#AABBCC';
  hex.events.input();
  assert.deepEqual(
    sliders.map((s) => s.value),
    ['170', '187', '204']
  );
  cancel.events.click();
  assert.equal(applied, false);
  assert.equal(modal.closed, true);
});

test('color opened in another layout does not dispatch input/change', () => {
  const h = setup(),
    input = h.element('input');
  input.value = '#446688';
  input.dispatchEvent = () => {
    throw Error('stale input');
  };
  let layout = {};
  h.bindColorPicker({}, input, () => layout);
  input.events.click({ preventDefault() {}, stopPropagation() {} });
  layout = {};
  h.controls().apply.events.click();
  assert.equal(h.notices.length, 1);
  assert.equal(h.controls().modal.closed, true);
});

test('current layout receives input and change only on Apply', () => {
  const h = setup(),
    input = h.element('input'),
    events = [];
  input.value = '#446688';
  input.ownerDocument = { defaultView: { Event } };
  input.dispatchEvent = (e) => events.push(e.type);
  h.bindColorPicker({}, input);
  input.events.click({ preventDefault() {}, stopPropagation() {} });
  const { hex, apply } = h.controls();
  hex.value = '#123456';
  hex.events.input();
  assert.equal(input.value, '#446688');
  apply.events.click();
  assert.equal(input.value, '#123456');
  assert.deepEqual(events, ['input', 'change']);
});
