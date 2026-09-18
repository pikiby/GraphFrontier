const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const notices = [];

class Notice {
  constructor(message) {
    notices.push(message);
  }
}

function element() {
  return {
    children: [],
    events: {},
    win: { cancelAnimationFrame() {} },
    empty() {},
    addClass() {},
    removeClass() {},
    setAttr() {},
    setAttribute() {},
    addEventListener(name, callback) {
      this.events[name] = callback;
    },
    setText() {},
    toggleClass() {},
    createDiv(options) {
      return this.createEl('div', options);
    },
    createSpan(options) {
      return this.createEl('span', options);
    },
    createEl(tag, options = {}) {
      const child = Object.assign(element(), { tag, ...options });
      this.children.push(child);
      return child;
    },
    getContext() {
      return {};
    },
  };
}

class Plugin {
  constructor(app, manifest = { id: 'graphfrontier' }) {
    this.app = app;
    this.manifest = manifest;
  }
  registerEvent() {}
  addRibbonIcon() {}
  addCommand() {}
  registerView() {}
}

class ItemView {
  constructor(leaf) {
    this.app = leaf.app;
    this.contentEl = element();
  }
  registerDomEvent(el, name, callback) {
    el.events[name] = callback;
  }
}

class Menu {
  constructor() {
    this.items = [];
  }
  addItem(build) {
    const item = {
      dom: element(),
      setTitle(value) {
        this.title = value;
        return this;
      },
      setIcon(value) {
        this.icon = value;
        return this;
      },
      setDisabled(value) {
        this.disabled = value;
        return this;
      },
      setWarning(value) {
        this.warning = value;
        return this;
      },
      onClick(callback) {
        this.callback = callback;
        return this;
      },
      setSubmenu() {
        this.submenu = new Menu();
        return this.submenu;
      },
    };
    build(item);
    this.items.push(item);
    return this;
  }
  addSeparator() {
    this.items.push({ separator: true });
    return this;
  }
}

const obsidian = {
  Notice,
  Plugin,
  ItemView,
  Modal: class {},
  Menu,
  MarkdownRenderer: {},
};
const sourceCache = new Map();

// Load real CommonJS source with a local Obsidian stub, without patching Node's
// global module loader or ever connecting to an Obsidian vault.
function loadSource(name) {
  const filename = path.resolve(__dirname, '../../src', name);
  if (sourceCache.has(filename)) return sourceCache.get(filename).exports;
  const source = new Module(filename, module);
  source.filename = filename;
  source.paths = Module._nodeModulePaths(path.dirname(filename));
  sourceCache.set(filename, source);
  source.require = (request) => {
    if (request === 'obsidian') return obsidian;
    if (request.startsWith('.')) {
      const resolved = require.resolve(path.resolve(path.dirname(filename), request));
      return loadSource(resolved);
    }
    return require(request);
  };
  source._compile(fs.readFileSync(filename, 'utf8'), filename);
  return source.exports;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fixture(t, data = {}) {
  notices.length = 0;
  const files = new Map();
  const writes = [];
  const reads = [];
  const preferences = [];
  const timers = new Map();
  let timerId = 0;
  const oldWindow = globalThis.window;
  globalThis.window = {
    setTimeout(callback) {
      timers.set(++timerId, callback);
      return timerId;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  t.after(() => {
    if (oldWindow === undefined) delete globalThis.window;
    else globalThis.window = oldWindow;
  });
  const events = {};
  const on = (name, callback) => {
    events[name] = callback;
    return callback;
  };
  const adapter = {
    async exists(name) {
      return files.has(name);
    },
    async read(name) {
      reads.push(name);
      if (!files.has(name)) throw new Error('File does not exist');
      return files.get(name);
    },
    async mkdir() {},
    async write(name, contents) {
      writes.push({ name, contents });
      files.set(name, contents);
    },
  };
  const leaves = [];
  const app = {
    vault: { adapter, configDir: '.test-config', on },
    metadataCache: { resolvedLinks: {}, on },
    workspace: {
      getLeavesOfType: () => leaves,
      getActiveFile: () => null,
    },
  };
  const GraphFrontierPlugin = loadSource('main.js');
  const { GraphFrontierView } = loadSource('view.js');
  const plugin = new GraphFrontierPlugin(app);
  plugin.data = plugin.normalizeData(data);
  plugin.loadData = async () => structuredClone(data);
  plugin.saveData = async (next) => preferences.push(structuredClone(next));
  const graph = { nodes: [{ id: 'alpha.md', label: 'alpha' }], edges: [] };
  plugin.collectGraphData = () => graph;
  const view = new GraphFrontierView({ app }, plugin);
  view.render = () => {};
  view.buildSidePanel = () => {};
  for (const method of [
    'buildQuickPreviewPanel',
    'updateCanvasBackgroundColor',
    'bindEvents',
    'installResizeObserver',
    'resizeCanvas',
    'runFrame',
  ]) {
    view[method] = () => {};
  }
  view.nodes = [{ id: 'alpha.md', x: 25, y: 40, vx: 1, vy: 2, degree: 0 }];
  view.nodeById = new Map(view.nodes.map((node) => [node.id, node]));
  view.isOpen = true;
  leaves.push({ view });
  const layoutPath = (name = 'data.json') => plugin.getLayoutFileRelativePath(name);
  const putLayout = (next, name = 'data.json') => files.set(layoutPath(name), JSON.stringify(next));
  const flushTimers = () => {
    const pending = [...timers.values()];
    timers.clear();
    for (const callback of pending) callback();
  };
  return {
    plugin,
    view,
    graph,
    app,
    adapter,
    files,
    writes,
    reads,
    preferences,
    events,
    layoutPath,
    putLayout,
    flushTimers,
  };
}

module.exports = { loadSource, notices, element, deferred, fixture };
