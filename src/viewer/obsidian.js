// The Obsidian API for the exported page. The page runs the plugin's own code (plugin, view,
// rendering, physics, menus), so this module provides what that code imports from 'obsidian',
// backed by the browser and the exported vault snapshot instead of the Obsidian app.
const { renderMarkdown } = require('./markdown');

// Obsidian adds these helpers to every DOM node; the plugin builds its interface with them.
function applyElementInfo(el, info) {
  if (info == null) return;
  if (typeof info === 'string') info = { cls: info };
  if (info.cls) el.className = Array.isArray(info.cls) ? info.cls.join(' ') : info.cls;
  if (info.text != null) {
    if (typeof info.text === 'string') el.textContent = info.text;
    else el.appendChild(info.text);
  }
  if (info.attr)
    for (const [name, value] of Object.entries(info.attr))
      if (value != null && value !== false) el.setAttribute(name, value === true ? '' : value);
  if (info.title != null) el.title = info.title;
  if (info.type != null) el.type = info.type;
  if (info.value != null) el.value = info.value;
  if (info.placeholder != null) el.placeholder = info.placeholder;
  if (info.href != null) el.href = info.href;
}

function installDomHelpers(win = window) {
  const NodeProto = win.Node.prototype;
  const ElementProto = win.Element.prototype;
  if (NodeProto.createEl) return;
  const define = (proto, name, value) =>
    Object.defineProperty(proto, name, { value, configurable: true, writable: true });
  define(NodeProto, 'createEl', function (tag, info, callback) {
    const doc = this.ownerDocument || this;
    const el = doc.createElement(tag);
    applyElementInfo(el, info);
    if (info && typeof info === 'object' && info.prepend) this.insertBefore(el, this.firstChild);
    else this.appendChild(el);
    callback?.(el);
    return el;
  });
  define(NodeProto, 'createDiv', function (info, callback) {
    return this.createEl('div', info, callback);
  });
  define(NodeProto, 'createSpan', function (info, callback) {
    return this.createEl('span', info, callback);
  });
  define(NodeProto, 'empty', function () {
    while (this.firstChild) this.removeChild(this.firstChild);
  });
  define(NodeProto, 'setText', function (text) {
    this.textContent = text == null ? '' : String(text);
  });
  define(NodeProto, 'getText', function () {
    return this.textContent || '';
  });
  Object.defineProperty(NodeProto, 'doc', {
    configurable: true,
    get() {
      return this.ownerDocument || this;
    },
  });
  Object.defineProperty(NodeProto, 'win', {
    configurable: true,
    get() {
      return (this.ownerDocument || this).defaultView || win;
    },
  });
  const classes = (list) =>
    list.flat().flatMap((entry) =>
      String(entry || '')
        .split(/\s+/)
        .filter(Boolean)
    );
  define(ElementProto, 'addClass', function (...names) {
    this.classList.add(...classes(names));
  });
  define(ElementProto, 'addClasses', function (names) {
    this.classList.add(...classes(names));
  });
  define(ElementProto, 'removeClass', function (...names) {
    this.classList.remove(...classes(names));
  });
  define(ElementProto, 'toggleClass', function (names, value) {
    for (const name of classes([names])) this.classList.toggle(name, value);
  });
  define(ElementProto, 'hasClass', function (name) {
    return this.classList.contains(name);
  });
  define(ElementProto, 'setAttr', function (name, value) {
    if (value == null || value === false) this.removeAttribute(name);
    else this.setAttribute(name, value === true ? '' : String(value));
  });
  define(ElementProto, 'setAttrs', function (attrs) {
    for (const [name, value] of Object.entries(attrs || {})) this.setAttr(name, value);
  });
  define(ElementProto, 'find', function (selector) {
    return this.querySelector(selector);
  });
  define(ElementProto, 'findAll', function (selector) {
    return Array.from(this.querySelectorAll(selector));
  });
  define(ElementProto, 'show', function () {
    this.style.display = '';
  });
  define(ElementProto, 'hide', function () {
    this.style.display = 'none';
  });
  define(ElementProto, 'isShown', function () {
    return this.style.display !== 'none' && this.isConnected;
  });
  for (const proto of [win.Document.prototype, win.DocumentFragment.prototype])
    for (const name of ['createEl', 'createDiv', 'createSpan'])
      if (!proto[name]) define(proto, name, NodeProto[name]);
  win.createDiv = (info, callback) =>
    win.document.createDocumentFragment().createDiv(info, callback);
  win.createEl = (tag, info, callback) =>
    win.document.createDocumentFragment().createEl(tag, info, callback);
}

class Events {
  constructor() {
    this._events = new Map();
  }
  on(name, callback, context) {
    const ref = { e: this, name, fn: callback, ctx: context };
    if (!this._events.has(name)) this._events.set(name, []);
    this._events.get(name).push(ref);
    return ref;
  }
  off(name, callback) {
    const list = this._events.get(name) || [];
    this._events.set(
      name,
      list.filter((ref) => ref.fn !== callback)
    );
  }
  offref(ref) {
    const list = this._events.get(ref?.name) || [];
    this._events.set(
      ref?.name,
      list.filter((entry) => entry !== ref)
    );
  }
  trigger(name, ...args) {
    for (const ref of [...(this._events.get(name) || [])]) ref.fn.apply(ref.ctx, args);
  }
  tryTrigger(ref, args) {
    ref.fn.apply(ref.ctx, args);
  }
}

class Component {
  constructor() {
    this._cleanups = [];
    this._children = [];
    this._loaded = false;
  }
  load() {
    this._loaded = true;
    this.onload?.();
  }
  unload() {
    for (const child of this._children) child.unload();
    for (const cleanup of this._cleanups.splice(0)) cleanup();
    this._loaded = false;
    this.onunload?.();
  }
  onload() {}
  onunload() {}
  addChild(child) {
    this._children.push(child);
    child.load();
    return child;
  }
  removeChild(child) {
    this._children = this._children.filter((entry) => entry !== child);
    child.unload();
    return child;
  }
  register(callback) {
    this._cleanups.push(callback);
  }
  registerEvent(ref) {
    this.register(() => ref?.e?.offref(ref));
  }
  registerDomEvent(el, type, callback, options) {
    el.addEventListener(type, callback, options);
    this.register(() => el.removeEventListener(type, callback, options));
  }
  registerInterval(id) {
    this.register(() => window.clearInterval(id));
    return id;
  }
}

class TAbstractFile {}
class TFile extends TAbstractFile {}
class TFolder extends TAbstractFile {}

class Plugin extends Component {
  constructor(app, manifest) {
    super();
    this.app = app;
    this.manifest = manifest;
  }
  async loadData() {
    return this.app.pluginData;
  }
  async saveData(data) {
    this.app.pluginData = JSON.parse(JSON.stringify(data));
  }
  addCommand(command) {
    return command;
  }
  addRibbonIcon() {
    return document.createElement('div');
  }
  addStatusBarItem() {
    return document.createElement('div');
  }
  addSettingTab() {}
  registerView(type, factory) {
    this.app.viewFactories.set(type, factory);
  }
  registerObsidianProtocolHandler() {}
  registerExtensions() {}
  registerHoverLinkSource() {}
}

class View extends Component {
  constructor(leaf) {
    super();
    this.leaf = leaf;
    this.app = leaf.app;
    this.containerEl = document.createElement('div');
    this.containerEl.className = 'workspace-leaf-content';
    this.containerEl.createDiv({ cls: 'view-header' });
    this.contentEl = this.containerEl.createDiv({ cls: 'view-content' });
    this.scope = null;
  }
  getDisplayText() {
    return '';
  }
  getIcon() {
    return '';
  }
}

class ItemView extends View {
  addAction() {
    return document.createElement('div');
  }
}

class Scope {
  constructor(parent) {
    this.parent = parent;
    this.keys = [];
  }
  register(modifiers, key, callback) {
    const handler = { modifiers, key, callback };
    this.keys.push(handler);
    return handler;
  }
  unregister(handler) {
    this.keys = this.keys.filter((entry) => entry !== handler);
  }
}

// A menu laid out like Obsidian's: items with an icon and a title, separators and submenus.
// It closes on Escape, on a press outside it, or when an item is chosen.
let openMenu = null;
class MenuItem {
  constructor(menu) {
    this.menu = menu;
    this.dom = document.createElement('div');
    this.dom.className = 'menu-item';
    this.iconEl = this.dom.createDiv({ cls: 'menu-item-icon' });
    this.titleEl = this.dom.createDiv({ cls: 'menu-item-title' });
    this.callback = null;
    this.disabled = false;
    this.submenu = null;
    this.dom.addEventListener('click', (event) => {
      if (this.disabled || this.submenu) return;
      if (
        event.target !== this.dom &&
        !this.titleEl.contains(event.target) &&
        !this.iconEl.contains(event.target)
      )
        return;
      this.callback?.(event);
      this.menu.hide();
    });
    this.dom.addEventListener('mouseenter', () => {
      this.menu.closeSubmenu(this);
      if (!this.submenu || this.disabled) return;
      const rect = this.dom.getBoundingClientRect();
      this.submenu.parentMenu = this.menu;
      this.submenu.showAtPosition({ x: rect.right - 2, y: rect.top - 4 }, true);
      this.menu.activeSubmenu = this.submenu;
    });
  }
  setTitle(title) {
    this.title = typeof title === 'string' ? title : String(title?.textContent ?? title ?? '');
    this.titleEl.empty();
    if (typeof title === 'string') this.titleEl.setText(title);
    else if (title) this.titleEl.appendChild(title);
    return this;
  }
  setIcon(icon) {
    setIcon(this.iconEl, icon);
    return this;
  }
  setChecked(checked) {
    this.dom.toggleClass('mod-checked', !!checked);
    return this;
  }
  setDisabled(disabled) {
    this.disabled = !!disabled;
    this.dom.toggleClass('is-disabled', this.disabled);
    return this;
  }
  setIsLabel(isLabel) {
    this.dom.toggleClass('is-label', !!isLabel);
    return this;
  }
  setWarning(warning) {
    this.dom.toggleClass('is-warning', !!warning);
    return this;
  }
  setSection(section) {
    this.section = section;
    return this;
  }
  onClick(callback) {
    this.callback = callback;
    return this;
  }
  setSubmenu() {
    this.submenu = new Menu();
    this.dom.addClass('has-submenu');
    return this.submenu;
  }
}

class Menu extends Component {
  constructor() {
    super();
    this.items = [];
    this.dom = document.createElement('div');
    this.dom.className = 'menu';
    this.hideCallbacks = [];
    this.activeSubmenu = null;
  }
  addItem(callback) {
    const item = new MenuItem(this);
    this.items.push(item);
    this.dom.appendChild(item.dom);
    callback(item);
    return this;
  }
  addSeparator() {
    this.dom.createDiv({ cls: 'menu-separator' });
    return this;
  }
  setNoIcon() {
    return this;
  }
  setUseNativeMenu() {
    return this;
  }
  onHide(callback) {
    this.hideCallbacks.push(callback);
  }
  closeSubmenu(except) {
    if (this.activeSubmenu && except?.submenu !== this.activeSubmenu) {
      this.activeSubmenu.hide(true);
      this.activeSubmenu = null;
    }
  }
  showAtMouseEvent(event) {
    return this.showAtPosition({ x: event.clientX, y: event.clientY });
  }
  showAtPosition(position, nested = false) {
    if (!nested) {
      if (openMenu && openMenu !== this) openMenu.hide();
      openMenu = this;
    }
    document.body.appendChild(this.dom);
    const { innerWidth, innerHeight } = window;
    const rect = this.dom.getBoundingClientRect();
    this.dom.style.left = `${Math.max(4, Math.min(position.x, innerWidth - rect.width - 4))}px`;
    this.dom.style.top = `${Math.max(4, Math.min(position.y, innerHeight - rect.height - 4))}px`;
    if (!nested) {
      this.outside = (event) => {
        if (!this.contains(event.target)) this.hide();
      };
      this.escape = (event) => {
        if (event.key === 'Escape') this.hide();
      };
      setTimeout(() => {
        document.addEventListener('pointerdown', this.outside, true);
        document.addEventListener('keydown', this.escape, true);
      });
    }
    return this;
  }
  contains(target) {
    return this.dom.contains(target) || !!this.activeSubmenu?.contains(target);
  }
  hide(nested = false) {
    if (!this.dom.isConnected) return this;
    this.closeSubmenu();
    this.dom.remove();
    if (this.outside) document.removeEventListener('pointerdown', this.outside, true);
    if (this.escape) document.removeEventListener('keydown', this.escape, true);
    if (!nested && openMenu === this) openMenu = null;
    if (!nested && this.parentMenu) this.parentMenu.hide();
    for (const callback of this.hideCallbacks) callback();
    return this;
  }
  close() {
    return this.hide();
  }
}

class Modal extends Component {
  constructor(app) {
    super();
    this.app = app;
    this.hasInitialInputFocus = true;
    this.containerEl = document.createElement('div');
    this.containerEl.className = 'modal-container mod-dim';
    this.bgEl = this.containerEl.createDiv({ cls: 'modal-bg' });
    this.modalEl = this.containerEl.createDiv({ cls: 'modal' });
    const close = this.modalEl.createDiv({ cls: 'modal-close-button' });
    setIcon(close, 'x');
    close.addEventListener('click', () => this.close());
    this.titleEl = this.modalEl.createDiv({ cls: 'modal-title' });
    this.contentEl = this.modalEl.createDiv({ cls: 'modal-content' });
    this.bgEl.addEventListener('click', () => this.close());
    this.scope = new Scope();
  }
  setTitle(title) {
    this.titleEl.setText(title);
    return this;
  }
  setContent(content) {
    this.contentEl.empty();
    if (typeof content === 'string') this.contentEl.setText(content);
    else this.contentEl.appendChild(content);
    return this;
  }
  open() {
    document.body.appendChild(this.containerEl);
    this.escape = (event) => {
      if (event.key === 'Escape') this.close();
    };
    document.addEventListener('keydown', this.escape);
    this.onOpen();
    if (this.hasInitialInputFocus) this.contentEl.querySelector('input, textarea, select')?.focus();
  }
  close() {
    if (!this.containerEl.isConnected) return;
    document.removeEventListener('keydown', this.escape);
    this.containerEl.remove();
    this.onClose();
  }
  onOpen() {}
  onClose() {}
}

class Notice {
  constructor(message, timeout = 5000) {
    let container = document.querySelector('.notice-container');
    if (!container) container = document.body.createDiv({ cls: 'notice-container' });
    this.noticeEl = container.createDiv({ cls: 'notice' });
    this.setMessage(message);
    this.noticeEl.addEventListener('click', () => this.hide());
    if (timeout) setTimeout(() => this.hide(), timeout);
  }
  setMessage(message) {
    this.noticeEl.empty();
    if (typeof message === 'string') this.noticeEl.setText(message);
    else if (message) this.noticeEl.appendChild(message);
    return this;
  }
  hide() {
    this.noticeEl.remove();
  }
}

// Icons are the Obsidian icons the plugin uses, captured as SVG when the page was exported.
let iconSvgs = {};
function setIconSet(icons) {
  iconSvgs = icons || {};
}
function setIcon(el, name) {
  el.empty();
  const svg = iconSvgs[name];
  if (svg) el.insertAdjacentHTML('beforeend', svg);
}
function getIcon(name) {
  const holder = document.createElement('div');
  setIcon(holder, name);
  return holder.firstElementChild;
}

const coarse = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
const Platform = {
  isDesktop: !coarse,
  isMobile: !!coarse,
  isDesktopApp: false,
  isMobileApp: false,
  isPhone: !!coarse,
  isTablet: false,
  isMacOS: typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || ''),
  isWin: typeof navigator !== 'undefined' && /Win/i.test(navigator.platform || ''),
  isLinux: typeof navigator !== 'undefined' && /Linux/i.test(navigator.platform || ''),
  isIosApp: false,
  isAndroidApp: false,
  isSafari: false,
};

const MarkdownRenderer = {
  async render(app, markdown, el) {
    el.innerHTML = renderMarkdown(markdown);
  },
  async renderMarkdown(markdown, el) {
    el.innerHTML = renderMarkdown(markdown);
  },
};

function normalizePath(path) {
  return String(path || '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/|\/$/g, '');
}

function parseLinktext(linktext) {
  const index = String(linktext).indexOf('#');
  return index < 0
    ? { path: linktext, subpath: '' }
    : { path: linktext.slice(0, index), subpath: linktext.slice(index) };
}

class Setting {
  constructor(containerEl) {
    this.settingEl = containerEl.createDiv({ cls: 'setting-item' });
    this.infoEl = this.settingEl.createDiv({ cls: 'setting-item-info' });
    this.nameEl = this.infoEl.createDiv({ cls: 'setting-item-name' });
    this.descEl = this.infoEl.createDiv({ cls: 'setting-item-description' });
    this.controlEl = this.settingEl.createDiv({ cls: 'setting-item-control' });
  }
  setName(name) {
    this.nameEl.setText(name);
    return this;
  }
  setDesc(desc) {
    this.descEl.setText(desc);
    return this;
  }
  setHeading() {
    return this;
  }
  setClass(cls) {
    this.settingEl.addClass(cls);
    return this;
  }
  addButton() {
    return this;
  }
  addToggle() {
    return this;
  }
  addText() {
    return this;
  }
}

class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = document.createElement('div');
  }
}

class AbstractInputSuggest {
  constructor(app, inputEl) {
    this.app = app;
    this.inputEl = inputEl;
  }
  setValue(value) {
    this.inputEl.value = value;
  }
  close() {}
}

module.exports = {
  installDomHelpers,
  setIconSet,
  Events,
  Component,
  Plugin,
  View,
  ItemView,
  Modal,
  Menu,
  MenuItem,
  Notice,
  Scope,
  Setting,
  PluginSettingTab,
  AbstractInputSuggest,
  TAbstractFile,
  TFile,
  TFolder,
  Platform,
  MarkdownRenderer,
  setIcon,
  getIcon,
  normalizePath,
  parseLinktext,
};
