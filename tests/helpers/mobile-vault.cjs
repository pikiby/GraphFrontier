const assert = require('node:assert/strict');
const { obsidian } = require('./obsidian.cjs');

function mobileVault(t) {
  const previous = obsidian.Platform.isMobile;
  obsidian.Platform.isMobile = true;
  t.after(() => {
    obsidian.Platform.isMobile = previous;
  });
  const entries = new Map();
  const contents = new Map();
  const calls = [];
  const folder = (path) => {
    const entry = Object.assign(new obsidian.TFolder(), { path });
    entries.set(path, entry);
    return entry;
  };
  const file = (path, text = '') => {
    const entry = Object.assign(new obsidian.TFile(), { path, extension: path.split('.').pop() });
    entries.set(path, entry);
    contents.set(path, text);
    return entry;
  };
  const vault = {
    getAbstractFileByPath: (path) => entries.get(path) || null,
    async createFolder(path) {
      assert.ok(!entries.has(path));
      calls.push(['mkdir', path]);
      return folder(path);
    },
    async create(path, text) {
      assert.ok(!entries.has(path));
      calls.push(['create', path]);
      return file(path, text);
    },
    async modify(entry, text) {
      assert.ok(entry instanceof obsidian.TFile);
      calls.push(['modify', entry.path]);
      contents.set(entry.path, text);
    },
    async cachedRead(entry) {
      return contents.get(entry.path);
    },
  };
  return { vault, entries, contents, calls, folder, file };
}

module.exports = { mobileVault };
