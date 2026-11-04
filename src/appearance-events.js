const { GRAPHFRONTIER_VIEW_TYPE } = require('./constants');

const watched = new WeakSet();
const branches = new Set([
  'settings',
  'groups',
  'node_visual_settings',
  'node_label_sizes',
  'painted_edge_colors',
  'blacklist',
  'whitelist',
]);
const targets = new WeakMap();
const raw = (value) => (value && typeof value === 'object' ? targets.get(value) || value : value);
// Only JSON appearance configuration is observed, never runtime nodes or camera state.
function observeObject(value, changed, current = () => value) {
  const proxies = new WeakMap();
  const wrap = (target) => {
    target = raw(target);
    if (!target || typeof target !== 'object') return target;
    if (proxies.has(target)) return proxies.get(target);
    const proxy = new Proxy(target, {
      get(object, key, receiver) {
        return wrap(Reflect.get(object, key, receiver));
      },
      set(object, key, next) {
        const previous = raw(object[key]);
        next = raw(next);
        const result = Reflect.set(object, key, next);
        const path = result && !Object.is(previous, next) ? locate(object) : null;
        if (path) changed([...path, key], previous, next);
        return result;
      },
      deleteProperty(object, key) {
        const existed = Object.hasOwn(object, key);
        const previous = raw(object[key]);
        const result = Reflect.deleteProperty(object, key);
        const path = result && existed ? locate(object) : null;
        if (path) changed([...path, key], previous, undefined);
        return result;
      },
    });
    proxies.set(target, proxy);
    targets.set(proxy, target);
    return proxy;
  };
  // Check reachability only on a mutation, never on reads or animation frames.
  // Retained objects may move within an array; detached old references are inert.
  const locate = (target) => {
    const seen = new WeakSet();
    const visit = (value, path = []) => {
      value = raw(value);
      if (value === target) return path;
      if (!value || typeof value !== 'object' || seen.has(value)) return null;
      seen.add(value);
      for (const [key, child] of Object.entries(value)) {
        const found = visit(child, [...path, key]);
        if (found) return found;
      }
      return null;
    };
    return visit(current());
  };
  return wrap(value);
}

function observePluginData(plugin) {
  if (watched.has(plugin)) return;
  watched.add(plugin);
  const views = () =>
    plugin.isLocalGraphFrontier
      ? [plugin.getScopeView?.()]
      : plugin.app.workspace
          .getLeavesOfType(GRAPHFRONTIER_VIEW_TYPE)
          .map((leaf) => leaf.view)
          .filter((view) => view?.plugin === plugin);
  const notify = (path = [], replaced = false) => {
    plugin.appearanceVersion = (plugin.appearanceVersion || 0) + 1;
    const groups = replaced || path[0] === 'groups';
    if (groups) plugin.groupStyleVersion = (plugin.groupStyleVersion || 0) + 1;
    for (const view of views()) {
      if (!view) continue;
      view.appearanceCache = null;
      if (groups || ['blacklist', 'whitelist'].includes(path[0]))
        view.markQueryRuleVisibilityDirty();
      view.requestFrame();
    }
  };
  let data;
  const prepare = (next) => {
    next = raw(next);
    const branchProxies = new Map();
    let root;
    const branch = (key) => {
      const value = raw(next[key]);
      const previous = branchProxies.get(key);
      if (previous?.value === value) return previous.proxy;
      const proxy = observeObject(
        value,
        (path, previous, next) => {
          if (data === root) notify([key, ...path], false, previous, next);
        },
        () => raw(next[key])
      );
      branchProxies.set(key, { value, proxy });
      return proxy;
    };
    root = new Proxy(next, {
      get(object, key) {
        return branches.has(key) ? branch(key) : object[key];
      },
      set(object, key, value) {
        const previous = raw(object[key]);
        value = raw(value);
        const changed = previous !== value;
        object[key] = value;
        if (changed && branches.has(key) && data === root) notify([key], false, previous, value);
        return true;
      },
      deleteProperty(object, key) {
        const existed = Object.hasOwn(object, key);
        const previous = raw(object[key]);
        delete object[key];
        if (existed && branches.has(key) && data === root)
          notify([key], false, previous, undefined);
        return true;
      },
    });
    targets.set(root, next);
    return root;
  };
  data = prepare(plugin.data);
  Object.defineProperty(plugin, 'data', {
    configurable: true,
    enumerable: true,
    get() {
      return data;
    },
    set(next) {
      // Local facades inherit the owner before installing their own observer.
      if (this !== plugin) {
        Object.defineProperty(this, 'data', {
          value: next,
          writable: true,
          configurable: true,
          enumerable: true,
        });
      } else if (next !== data) {
        data = prepare(next);
        notify([], true);
      }
    },
  });
}

const listStores = new WeakSet();
function observeNodeLists(plugin) {
  const store = plugin.nodeListStore;
  if (!store || listStores.has(store)) return;
  listStores.add(store);
  let pending = false;
  const changed = () => {
    store.appearanceVersion = (store.appearanceVersion || 0) + 1;
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      plugin.nodeListsChanged();
    });
  };
  let source = raw(store.lists);
  let lists = observeObject(source, changed, () => source);
  Object.defineProperty(store, 'lists', {
    configurable: true,
    enumerable: true,
    get() {
      return lists;
    },
    set(next) {
      if (next === lists) return;
      source = raw(next);
      lists = observeObject(source, changed, () => source);
      changed();
    },
  });
}

module.exports = { observePluginData, observeNodeLists };
