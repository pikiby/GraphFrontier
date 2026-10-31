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
          /^(con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i.test(
            p
          ) ||
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
    let primaryError;
    try {
      const primary = await this.readFile(this.path);
      if (primary) return primary;
    } catch (error) {
      primaryError = error;
    }
    const recovery = await this.readFile(this.recoveryPath);
    if (recovery) return { ...recovery, recovered: true };
    if (primaryError) throw primaryError;
    return null;
  }

  get recoveryPath() {
    return `${this.path}.recovery`;
  }

  async readFile(path) {
    const file = this.vault.getAbstractFileByPath(path);
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
      this.blocked =
        !!existing && (existing.recovered || existing.bundle.owner !== this.preferences.owner);
      this.lastSuccess = existing?.bundle.createdAt || null;
      this.error = existing?.recovered
        ? 'The last backup write was interrupted. A verified recovery copy is available. Restore it before resuming backups.'
        : '';
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
    if (this.restoring) return;
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
    let data = cleanData(this.plugin, this.plugin.data);
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
    // Unsaved canvas edits must not replace the last saved layout in the backup.
    if (activeLayout) {
      data = copy(activeLayout.data);
      data.active_layout_name = active;
    } else layouts.push({ name: active, data: copy(data) });
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
      if (previous?.recovered && !replace) {
        this.blocked = true;
        throw new Error('Interrupted backup is protected. Restore the recovery copy first.');
      }
      if (replace && previous?.raw !== expectedRaw)
        throw new Error('Backup changed. Review it again before replacing.');
      if (!replace && previous && previous.bundle.owner !== this.preferences.owner) {
        this.blocked = true;
        throw new Error('Existing backup belongs to a previous installation.');
      }
      const bundle = await this.snapshot();
      if (
        !replace &&
        previous &&
        JSON.stringify([bundle.data, bundle.layouts, bundle.lists]) ===
          JSON.stringify([previous.bundle.data, previous.bundle.layouts, previous.bundle.lists])
      ) {
        this.error = '';
        return previous.bundle;
      }
      const text = JSON.stringify(bundle, null, 2);
      await this.ensureFolder();
      const file = this.vault.getAbstractFileByPath(this.path);
      const original = file instanceof TFile ? await this.vault.read(file) : null;
      if (!previous?.recovered && original !== (previous?.raw ?? null))
        throw new Error('Backup changed during save.');
      if (previous) {
        // Never touch the current file until a full recovery copy has been verified.
        const recovery = this.vault.getAbstractFileByPath(this.recoveryPath);
        if (recovery) {
          if (!(recovery instanceof TFile)) throw new Error('Recovery path is not a file.');
          if (previous.recovered) {
            if ((await this.vault.read(recovery)) !== previous.raw)
              throw new Error('Recovery copy changed during save.');
          } else {
            if ((await this.vault.read(file)) !== previous.raw)
              throw new Error('Backup changed during save.');
            await this.vault.delete(recovery);
          }
        }
        if (!this.vault.getAbstractFileByPath(this.recoveryPath))
          await this.vault.create(this.recoveryPath, previous.raw);
        if ((await this.readFile(this.recoveryPath))?.raw !== previous.raw)
          throw new Error('Recovery verification failed. Current backup left untouched.');
      }
      if (file instanceof TFile) {
        await this.vault.process(file, (current) => {
          if (current !== original) throw new Error('Backup changed during save.');
          return text;
        });
      } else if (!file) {
        // A failed first write must not leave a truncated file at the final path.
        const pendingPath = `${this.path}.${Date.now()}-${Math.random().toString(36).slice(2)}.pending`;
        try {
          const pending = await this.vault.create(pendingPath, text);
          if ((await this.readFile(pendingPath))?.raw !== text)
            throw new Error('Backup verification failed.');
          await this.vault.rename(pending, this.path);
        } finally {
          const pending = this.vault.getAbstractFileByPath(pendingPath);
          if (pending instanceof TFile) await this.vault.delete(pending);
        }
      } else throw new Error('Backup path is not a file.');
      const verified = await this.readFile(this.path);
      if (verified?.raw !== text) throw new Error('Backup verification failed.');
      const recovery = this.vault.getAbstractFileByPath(this.recoveryPath);
      if (recovery instanceof TFile) await this.vault.delete(recovery);
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
    this.pending = false;
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
      const damaged = found.recovered ? this.vault.getAbstractFileByPath(this.path) : null;
      const damagedRaw = damaged instanceof TFile ? await this.vault.read(damaged) : null;
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
      if (found.recovered) {
        // Repair only after an explicit restore; retain recovery on any storage failure.
        if (damaged instanceof TFile) {
          await this.vault.process(damaged, (current) => {
            if (current !== damagedRaw) throw new Error('Backup changed during restore.');
            return found.raw;
          });
        } else if (!damaged) await this.vault.create(this.path, found.raw);
        else throw new Error('Backup path is not a file.');
        if ((await this.readFile(this.path))?.raw !== found.raw)
          throw new Error('Restored backup verification failed. Recovery copy kept.');
        const recovery = this.vault.getAbstractFileByPath(this.recoveryPath);
        if (recovery instanceof TFile) await this.vault.delete(recovery);
      }
      // Keep the source copy intact; subsequent saves are allowed for this installation.
      this.preferences.owner = bundle.owner;
      this.blocked = false;
      await p.persistPluginDataOnly();
      // Invalidate list filters before reloading, so their physics kick cannot
      // move the freshly restored layout. Subgraph-only workspaces reload too.
      p.nodeListsChanged();
      const leaves = p.app.workspace.getLeavesOfType(GRAPHFRONTIER_VIEW_TYPE);
      const view = (leaves.find((leaf) => !leaf.view?.subgraphScope) || leaves[0])?.view;
      if (view) {
        if (!(await view.loadSavedLayout({ silent: true, resetRuntime: true })))
          throw new Error('Data restored, but the active graph could not reload.');
      } else p.refreshAllViews({ keepCamera: true, forceSavedPositions: true });
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
