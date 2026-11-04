const test = require('node:test');
const assert = require('node:assert/strict');
const { obsidian, loadSource, element, notices } = require('./helpers/obsidian.cjs');

// Only the existing Setting builder used by Navigation is needed here.
const settings = [];
obsidian.Setting = class {
  constructor() {
    settings.push(this);
  }
  setName(value) {
    this.name = value;
    return this;
  }
  setDesc(value) {
    this.description = value;
    return this;
  }
  addButton(build) {
    const button = {
      setButtonText(value) {
        this.text = value;
        return this;
      },
      onClick(callback) {
        this.click = callback;
        return this;
      },
    };
    build(button);
    this.button = button;
    return this;
  }
};
const { GraphFrontierMcpSettingTab } = loadSource('mcp-settings.js');
delete obsidian.Setting;
const { NOTE_NAVIGATION_EXAMPLE, getNoteTargets } = loadSource('note-navigation.js');

test('Navigation explains exact syntax and copies the displayed YAML only on click', async () => {
  const container = element();
  const copied = [];
  container.win.navigator = { clipboard: { writeText: async (text) => copied.push(text) } };
  GraphFrontierMcpSettingTab.prototype.renderNavigation(container);
  assert.deepEqual(copied, []);
  assert.equal(settings.length, 1);
  const setting = settings[0];
  assert.match(setting.description, /string or a list of strings/);
  assert.match(setting.description, /"\[Label\]\(target\)"/);
  assert.match(setting.description, /quote the whole alias/);
  assert.match(setting.description, /always appear.*submenus, even with one target/);
  assert.doesNotMatch(setting.description, /opens directly/);
  assert.equal(setting.button.text, 'Copy example');
  assert.equal(container.children[0].children[0].text, NOTE_NAVIGATION_EXAMPLE);
  await setting.button.click();
  assert.deepEqual(copied, [NOTE_NAVIGATION_EXAMPLE]);
  assert.match(NOTE_NAVIGATION_EXAMPLE, /url:\n {2}- https:/);
  assert.match(NOTE_NAVIGATION_EXAMPLE, /path:\n {2}- '\[Project\]/);
  for (const [type, pattern] of [
    ['url', /url:([\s\S]*)path:/],
    ['path', /path:([\s\S]*)/],
  ]) {
    const values = NOTE_NAVIGATION_EXAMPLE.match(pattern)[1]
      .trim()
      .split('\n')
      .map((line) => line.trim().slice(2).replace(/^'|'$/g, ''));
    assert.equal(getNoteTargets(type, values).length, 2);
  }
  container.win.navigator.clipboard.writeText = async () => {
    throw new Error('denied');
  };
  await assert.doesNotReject(setting.button.click());
  assert.equal(notices.at(-1), 'Cannot access clipboard');
});
