const MAX_MEMBERS = 100000;
const membershipCache = new WeakMap();

function nodeListContains(lists, listId, nodeId) {
  let index = membershipCache.get(lists);
  if (!index) {
    index = new Map(lists.map((list) => [list.id, new Set(list.nodeIds)]));
    membershipCache.set(lists, index);
  }
  return index.get(listId)?.has(nodeId) || false;
}

function validatePaths(paths) {
  if (!Array.isArray(paths) || paths.length > MAX_MEMBERS)
    throw new Error('Provide an array of at most 100000 vault-relative paths.');
  for (const path of paths) {
    if (
      typeof path !== 'string' ||
      !path ||
      path.length > 4096 ||
      /[\\:]/.test(path) ||
      [...path].some((character) => character.charCodeAt(0) < 32) ||
      path.startsWith('/') ||
      path.split('/').some((part) => !part || part === '.' || part === '..')
    )
      throw new Error('Use vault-relative file paths, without empty segments or ..');
  }
  return [...new Set(paths)];
}

// Lists are vault-wide input data, never part of a saved graph layout.
class NodeListStore {
  constructor(adapter, path, onChange) {
    this.adapter = adapter;
    this.path = path;
    this.onChange = onChange;
    this.lists = [];
    this.queue = Promise.resolve();
    this.readError = null;
  }

  async load() {
    try {
      if (!(await this.adapter.exists(this.path))) return;
      const data = JSON.parse(await this.adapter.read(this.path));
      if (data.version !== 1 || !Array.isArray(data.lists))
        throw new Error('Invalid node lists file');
      const ids = new Set();
      this.lists = data.lists.map((list) => {
        if (
          !/^[a-zA-Z0-9_-]{1,128}$/.test(list.id) ||
          ids.has(list.id) ||
          typeof list.name !== 'string' ||
          !list.name.trim() ||
          list.name.length > 300
        )
          throw new Error('Invalid or duplicate node list');
        ids.add(list.id);
        return { id: list.id, name: list.name, nodeIds: validatePaths(list.nodeIds) };
      });
    } catch (error) {
      this.lists = [];
      this.readError = error;
      throw error;
    }
  }

  transact(change) {
    const run = async () => {
      if (this.readError)
        throw new Error('Node lists could not be read. Repair the file before editing.');
      const next = this.lists.map((list) => ({ ...list, nodeIds: [...list.nodeIds] }));
      const result = change(next);
      if (JSON.stringify(next) === JSON.stringify(this.lists)) return result;
      // Obsidian rename does not replace an existing destination.
      await this.adapter.write(this.path, JSON.stringify({ version: 1, lists: next }, null, 2));
      this.lists = next;
      this.onChange();
      return result;
    };
    const result = this.queue.then(run);
    this.queue = result.catch(() => {});
    return result;
  }

  update({ action, listId, name, nodeIds }) {
    return this.transact((lists) => {
      if (action === 'create' || action === 'rename') {
        if (typeof name !== 'string' || !name.trim() || name.length > 300)
          throw new Error('Enter a list name (up to 300 characters).');
      }
      if (action === 'create') {
        const id =
          listId || `list_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id) || lists.some((list) => list.id === id))
          throw new Error('Invalid or duplicate list ID.');
        const list = { id, name: name.trim(), nodeIds: validatePaths(nodeIds || []) };
        lists.push(list);
        return list;
      }
      const index = lists.findIndex((list) => list.id === listId);
      if (index < 0) throw new Error('Node list not found.');
      const list = lists[index];
      if (action === 'delete') {
        lists.splice(index, 1);
        return null;
      }
      if (action === 'rename') list.name = name.trim();
      else {
        const paths = validatePaths(nodeIds);
        if (action === 'add') list.nodeIds = validatePaths([...list.nodeIds, ...paths]);
        else if (action === 'remove') {
          const removed = new Set(paths);
          list.nodeIds = list.nodeIds.filter((path) => !removed.has(path));
        } else if (action === 'replace') list.nodeIds = paths;
        else throw new Error('Unknown node list action.');
      }
      return list;
    });
  }

  renamePath(oldPath, newPath) {
    return this.transact((lists) => {
      for (const list of lists)
        list.nodeIds = [
          ...new Set(
            list.nodeIds.map((path) =>
              path === oldPath
                ? newPath
                : path.startsWith(`${oldPath}/`)
                  ? newPath + path.slice(oldPath.length)
                  : path
            )
          ),
        ];
    });
  }
}

module.exports = { NodeListStore, validatePaths, nodeListContains };
