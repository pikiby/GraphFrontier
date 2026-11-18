// The Obsidian app for the exported page, built from the vault snapshot taken at export: files,
// their metadata (tags, properties, headings), resolved and unresolved links, note texts and the
// plugin's files (layouts, lists). Writes stay in this page's memory.
import { Events, TFile, TFolder, Notice } from './obsidian.js';

function basenameOf(path) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function createVaultFiles(snapshotFiles) {
  const byPath = new Map();
  const root = Object.assign(new TFolder(), { path: '/', name: '', children: [], parent: null });
  const folder = (path) => {
    if (!path) return root;
    if (byPath.has(path)) return byPath.get(path);
    const parent = folder(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
    const entry = Object.assign(new TFolder(), {
      path,
      name: path.slice(path.lastIndexOf('/') + 1),
      children: [],
      parent,
    });
    parent.children.push(entry);
    byPath.set(path, entry);
    return entry;
  };
  for (const entry of snapshotFiles) {
    const name = entry.path.slice(entry.path.lastIndexOf('/') + 1);
    const dot = name.lastIndexOf('.');
    const parent = folder(
      entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : ''
    );
    const file = Object.assign(new TFile(), {
      path: entry.path,
      name,
      basename: basenameOf(entry.path),
      extension: dot > 0 ? name.slice(dot + 1) : '',
      stat: { ctime: entry.ctime || 0, mtime: entry.mtime || 0, size: entry.size || 0 },
      parent,
    });
    parent.children.push(file);
    byPath.set(entry.path, file);
  }
  return { byPath, root };
}

// Plugin files (layouts, node lists) as an in-memory folder tree; onChange hears every write.
function createAdapter(initialFiles, onChange = () => {}) {
  const files = new Map(Object.entries(initialFiles || {}));
  const folders = new Set();
  const addFolders = (path) => {
    let index = path.lastIndexOf('/');
    while (index > 0) {
      folders.add(path.slice(0, index));
      index = path.lastIndexOf('/', index - 1);
    }
  };
  for (const path of files.keys()) addFolders(path);
  return {
    async exists(path) {
      return files.has(path) || folders.has(path);
    },
    async read(path) {
      if (!files.has(path)) throw new Error(`File not found: ${path}`);
      return files.get(path);
    },
    async write(path, text) {
      files.set(path, String(text));
      addFolders(path);
      onChange(path);
    },
    async remove(path) {
      files.delete(path);
      onChange(path);
    },
    async rename(from, to) {
      files.set(to, files.get(from));
      files.delete(from);
      addFolders(to);
      onChange(to);
    },
    files: () => Object.fromEntries(files),
    async mkdir(path) {
      folders.add(path);
      addFolders(path);
    },
    async list(path) {
      const prefix = `${path}/`;
      const direct = (entry) =>
        entry.startsWith(prefix) && !entry.slice(prefix.length).includes('/');
      return { files: [...files.keys()].filter(direct), folders: [...folders].filter(direct) };
    },
    getFullPath(path) {
      return path;
    },
    getBasePath() {
      return '';
    },
  };
}

function createApp(snapshot, { openNote, onPluginFileChange } = {}) {
  const { byPath, root } = createVaultFiles(snapshot.files || []);
  const caches = snapshot.caches || {};
  const texts = snapshot.texts || {};
  const vault = Object.assign(new Events(), {
    configDir: snapshot.configDir || '.obsidian',
    adapter: createAdapter(snapshot.pluginFiles, onPluginFileChange),
    getName: () => snapshot.vaultName || 'Vault',
    getRoot: () => root,
    getFiles: () => [...byPath.values()].filter((entry) => entry instanceof TFile),
    getMarkdownFiles: () =>
      [...byPath.values()].filter((entry) => entry instanceof TFile && entry.extension === 'md'),
    getAllLoadedFiles: () => [root, ...byPath.values()],
    getAbstractFileByPath: (path) => (path === '/' ? root : byPath.get(path) || null),
    cachedRead: async (file) => texts[file?.path] ?? '',
    read: async (file) => texts[file?.path] ?? '',
    process: async () => {
      throw new Error('Notes cannot be changed in an exported graph');
    },
    create: async () => {
      throw new Error('Notes cannot be created in an exported graph');
    },
    createFolder: async () => {},
    modify: async () => {},
    delete: async () => {},
    trash: async () => {},
    rename: async () => {},
  });
  const metadataCache = Object.assign(new Events(), {
    resolvedLinks: snapshot.resolvedLinks || {},
    unresolvedLinks: snapshot.unresolvedLinks || {},
    getFileCache: (file) => caches[file?.path] || null,
    getCache: (path) => caches[path] || null,
    getFirstLinkpathDest: (linkpath) => {
      const target = String(linkpath || '').toLowerCase();
      return (
        vault
          .getFiles()
          .find(
            (file) =>
              file.path.toLowerCase() === target ||
              file.basename.toLowerCase() === target ||
              file.path.toLowerCase() === `${target}.md`
          ) || null
      );
    },
  });
  // Opening a note shows it on the page; there is no other app to open it in.
  const noteLeaf = {
    openFile: async (file) => openNote?.(file),
    setViewState: async () => {},
    getViewState: () => ({}),
    detach: () => {},
  };
  const leaves = [];
  const workspace = Object.assign(new Events(), {
    layoutReady: true,
    activeLeaf: null,
    onLayoutReady: (callback) => setTimeout(callback),
    getLeavesOfType: (type) => leaves.filter((leaf) => leaf.view?.getViewType?.() === type),
    getLeaf: () => noteLeaf,
    getRightLeaf: () => null,
    getMostRecentLeaf: () => leaves[0] || null,
    revealLeaf: async () => {},
    setActiveLeaf: () => {},
    getActiveFile: () => null,
    requestSaveLayout: () => {},
    iterateAllLeaves: (callback) => leaves.forEach(callback),
  });
  const app = {
    vault,
    metadataCache,
    workspace,
    pluginData: snapshot.pluginData,
    viewFactories: new Map(),
    leaves,
    fileManager: {
      processFrontMatter: async () => {
        throw new Error('Notes cannot be changed in an exported graph');
      },
      promptForDeletion: async () => {},
    },
    viewRegistry: { getTypeByExtension: (extension) => (extension === 'md' ? 'markdown' : null) },
    // Attachments have no text to show, and a page cannot open files in other apps.
    openWithDefaultApp: async () => {
      new Notice('Attachments cannot be opened in the browser');
    },
    commands: { executeCommandById: () => false },
    setting: { open() {}, openTabById() {} },
  };
  return app;
}

export { createApp };
