const { TFile, TFolder, Notice } = require('obsidian');
const { DEFAULT_DATA, GRAPHFRONTIER_VIEW_TYPE } = require('./constants');
const { NodeListStore } = require('./node-lists');
const DEFAULT_FOLDER = 'GraphFrontier backups';
const FILE_NAME = 'graphfrontier-backup.json';
const copy = (value) => JSON.parse(JSON.stringify(value));

function backupFolder(value, configDir) {
  const path = String(value || '').trim();
  if (
    !path ||
    path
      .split('/')
      .some(
        (p) =>
          !p ||
          p.startsWith('.') ||
          /[\\<>:"|?*]/.test(p) ||
          [...p].some((c) => c.charCodeAt(0) < 32) ||
          /[. ]$/.test(p)
      ) ||
    path === configDir ||
    path.startsWith(`${configDir}/`)
  )
    throw new Error('Choose a visible folder inside the vault, outside the configuration folder.');
  return path;
}

function cleanData(plugin, data) {
  const result = plugin.normalizeData(data);
  for (const key of ['settings', 'saved_layout_settings'])
    result[key] = Object.fromEntries(
      Object.entries(result[key] || {}).filter(([name]) =>
        Object.hasOwn(DEFAULT_DATA.settings, name)
      )
    );
  result.view_state = Object.fromEntries(
    Object.entries(result.view_state).filter(([name]) =>
      Object.hasOwn(DEFAULT_DATA.view_state, name)
    )
  );
  return result;
}

class BackupManager {
  constructor(plugin, preferences = {}) {
    this.plugin = plugin;
    this.vault = plugin.app.vault;
    this.preferences = {
      enabled: preferences.enabled !== false,
      folder: preferences.folder || DEFAULT_FOLDER,
      owner:
        preferences.owner || `gf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    };
    this.ready = false;
    this.blocked = false;
    this.busy = false;
    this.error = '';
    this.timer = null;
    this.lastSuccess = null;
    this.disposed = false;
  }

  get path() {
    return `${backupFolder(this.preferences.folder, this.vault.configDir)}/${FILE_NAME}`;
  }

  async read() {
    const file = this.vault.getAbstractFileByPath(this.path);
    if (!file) return null;
    if (!(file instanceof TFile)) throw new Error('Backup path is not a file.');
    const raw = await this.vault.read(file);
    const bundle = JSON.parse(raw);
    if (
      bundle.format !== 'graphfrontier-backup' ||
      bundle.version !== 1 ||
      typeof bundle.owner !== 'string' ||
      !bundle.owner ||
      !Number.isFinite(Date.parse(bundle.createdAt)) ||
      !bundle.data ||
      typeof bundle.data !== 'object' ||
      Array.isArray(bundle.data) ||
      !Array.isArray(bundle.layouts) ||
      !Array.isArray(bundle.lists)
    )
      throw new Error('Invalid GraphFrontier backup. Existing file left untouched.');
    const names = new Set();
    for (const layout of bundle.layouts) {
      if (
        !layout ||
        typeof layout.name !== 'string' ||
        layout.name !== this.plugin.normalizeLayoutFileName(layout.name) ||
        names.has(layout.name) ||
        !layout.data ||
        typeof layout.data !== 'object' ||
        Array.isArray(layout.data)
      )
        throw new Error('Invalid or duplicate layout in backup.');
      names.add(layout.name);
    }
    if (!names.has(this.plugin.normalizeLayoutFileName(bundle.data.active_layout_name)))
      throw new Error('Active layout is missing from backup.');
    const validator = new NodeListStore(
      {
        exists: async () => true,
        read: async () => JSON.stringify({ version: 1, lists: bundle.lists }),
      },
      '',
      () => {}
    );
    await validator.load();
    return { raw, bundle };
  }

  async initialize() {
    try {
      const existing = await this.read();
      this.blocked = !!existing && existing.bundle.owner !== this.preferences.owner;
      this.lastSuccess = existing?.bundle.createdAt || null;
      this.error = '';
    } catch (error) {
      this.blocked = true;
      this.error = error.message;
    }
    this.ready = true;
    if (this.blocked)
      new Notice(
        'GraphFrontier backup found. Open Backups to restore it or explicitly replace it. The copy is protected.'
      );
    else this.schedule();
  }

  schedule() {
    if (!this.ready || this.disposed || this.blocked || !this.preferences.enabled) return;
    if (this.busy) {
      this.pending = true;
      return;
    }
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.write().catch((error) => {
        this.error = error.message;
        new Notice(`GraphFrontier backup: ${error.message}`);
      });
    }, 1000);
  }

  dispose() {
    this.disposed = true;
    if (this.timer) window.clearTimeout(this.timer);
  }

  async configure({ enabled = this.preferences.enabled, folder = this.preferences.folder }) {
    if (this.busy) throw new Error('Backup operation in progress.');
    const next = backupFolder(folder, this.vault.configDir);
    const changed = next !== this.preferences.folder;
    this.preferences.enabled = enabled;
    this.preferences.folder = next;
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = null;
    if (changed) {
      this.ready = false;
      await this.initialize();
    }
    await this.plugin.persistPluginDataOnly();
    this.schedule();
  }

  async snapshot() {
    if (this.plugin.nodeListStore?.readError || this.plugin._layoutReadFailedName)
      throw new Error('Working data has a read error. Backup left untouched.');
    await this.plugin.nodeListStore?.queue;
    const revision = this.plugin._persistRevision;
    const data = cleanData(this.plugin, this.plugin.data);
    const layouts = [];
    // Do not use the tolerant layout-list helper: a listing failure must not erase a backup.
    const adapter = this.vault.adapter;
    const directory = this.plugin.getLayoutsFolderRelativePath();
    const entries = (await adapter.exists(directory))
      ? await adapter.list(directory)
      : { files: [] };
    for (const path of entries.files.filter((path) => path.endsWith('.json'))) {
      const name = path.split('/').pop();
      if (name !== this.plugin.normalizeLayoutFileName(name))
        throw new Error('Unsafe layout filename.');
      const stored = JSON.parse(await adapter.read(path));
      if (!stored || typeof stored !== 'object' || Array.isArray(stored))
        throw new Error(`Invalid layout: ${name}`);
      layouts.push({ name, data: cleanData(this.plugin, stored) });
    }
    const active = this.plugin.getActiveLayoutFileName();
    const activeLayout = layouts.find((layout) => layout.name === active);
    if (activeLayout) activeLayout.data = copy(data);
    else layouts.push({ name: active, data: copy(data) });
    if (revision !== this.plugin._persistRevision)
      throw new Error('Settings changed while preparing backup. Retry.');
    return {
      format: 'graphfrontier-backup',
      version: 1,
      owner: this.preferences.owner,
      createdAt: new Date().toISOString(),
      data,
      layouts,
      lists: copy(this.plugin.getNodeLists()),
    };
  }

  async ensureFolder() {
    const parts = this.preferences.folder.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const path = parts.slice(0, i).join('/');
      let entry = this.vault.getAbstractFileByPath(path);
      if (!entry) {
        await this.vault.createFolder(path);
        entry = this.vault.getAbstractFileByPath(path);
      }
      if (!(entry instanceof TFolder)) throw new Error(`Not a folder: ${path}`);
    }
  }

  async write({ replace = false, expectedRaw } = {}) {
    if (!this.ready || this.busy || this.disposed) throw new Error('Backups are not ready.');
    if (this.blocked && !replace)
      throw new Error('Existing backup is protected. Restore it or confirm replacement.');
    this.busy = true;
    try {
      const previous = await this.read();
      if (replace && previous?.raw !== expectedRaw)
        throw new Error('Backup changed. Review it again before replacing.');
      if (!replace && previous && previous.bundle.owner !== this.preferences.owner) {
        this.blocked = true;
        throw new Error('Existing backup belongs to a previous installation.');
      }
      const bundle = await this.snapshot();
      const text = JSON.stringify(bundle, null, 2);
      await this.ensureFolder();
      const file = this.vault.getAbstractFileByPath(this.path);
      if (file instanceof TFile) {
        await this.vault.process(file, (current) => {
          if (current !== previous?.raw) throw new Error('Backup changed during save.');
          return text;
        });
      } else if (!file) await this.vault.create(this.path, text);
      else throw new Error('Backup path is not a file.');
      const verified = await this.read();
      if (verified?.raw !== text) throw new Error('Backup verification failed.');
      this.blocked = false;
      this.error = '';
      this.lastSuccess = bundle.createdAt;
      return bundle;
    } finally {
      this.busy = false;
      if (this.pending) {
        this.pending = false;
        this.schedule();
      }
    }
  }

  async restore(expectedRaw) {
    if (!this.ready || this.busy) throw new Error('Backups are not ready.');
    this.busy = true;
    this.restoring = true;
    const p = this.plugin;
    if (p._persistTimer) {
      window.clearTimeout(p._persistTimer);
      p._persistTimer = null;
    }
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = null;
    try {
      const found = await this.read();
      if (!found || found.raw !== expectedRaw)
        throw new Error('Backup changed. Review it again before restoring.');
      const bundle = found.bundle;
      const restoration = p.nodeListStore.queue.then(() =>
        p.runLayoutFileOperation(async () => {
          const adapter = this.vault.adapter;
          const before = [];
          const oldData = p.data;
          const oldLists = p.nodeListStore.lists;
          const updates = bundle.layouts.map((layout) => [
            p.getLayoutFileRelativePath(layout.name),
            JSON.stringify(cleanData(p, layout.data)),
          ]);
          updates.push([p.nodeListStore.path, JSON.stringify({ version: 1, lists: bundle.lists })]);
          for (const [path] of updates)
            before.push([path, (await adapter.exists(path)) ? await adapter.read(path) : null]);
          await p.ensureLayoutsFolder();
          try {
            for (const [path, text] of updates) await adapter.write(path, text);
            const data = cleanData(p, bundle.data);
            await p.saveData({ ...data, backups: this.preferences });
            p.data = data;
            p.nodeListStore.lists = copy(bundle.lists);
            p.nodeListStore.readError = null;
            p._layoutReadFailedName = null;
          } catch (error) {
            for (const [path, text] of before) {
              if (text === null) {
                if (await adapter.exists(path)) await adapter.remove(path);
              } else await adapter.write(path, text);
            }
            p.data = oldData;
            p.nodeListStore.lists = oldLists;
            throw error;
          }
        })
      );
      p.nodeListStore.queue = restoration.catch(() => {});
      await restoration;
      // Keep the source copy intact; subsequent saves are allowed for this installation.
      this.preferences.owner = bundle.owner;
      this.blocked = false;
      await p.persistPluginDataOnly();
      const view = p.app.workspace
        .getLeavesOfType(GRAPHFRONTIER_VIEW_TYPE)
        .find((leaf) => !leaf.view?.subgraphScope)?.view;
      if (view) {
        if (!(await view.loadSavedLayout({ silent: true })))
          throw new Error('Data restored, but the active graph could not reload.');
      } else p.refreshAllViews({ keepCamera: true, forceSavedPositions: true });
      p.nodeListsChanged();
      this.error = '';
      return bundle;
    } catch (error) {
      this.blocked = true;
      this.error = error.message;
      throw error;
    } finally {
      this.busy = false;
      this.restoring = false;
      if (this.pending) {
        this.pending = false;
        this.schedule();
      }
    }
  }
}
module.exports = { BackupManager, backupFolder, cleanData, DEFAULT_FOLDER };
