'use strict';

const fs = require('node:fs');
const path = require('node:path');

const VIRTUAL_PLUGIN_PREFIX = '.obsidian/plugins/graphfrontier';
const ALLOWED_PLUGIN_FILES = new Set(['node-lists.json', 'node-lists.json.tmp']);
const ALLOWED_PLUGIN_DIRS = new Set(['layouts', 'layouts/backups']);

function normalizeVirtualPath(vpath) {
  const raw = String(vpath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/+/g, '/');
  if (!raw || raw.includes('\0') || raw.split('/').includes('..')) {
    throw new Error(`Invalid virtual path: ${vpath}`);
  }
  return raw;
}

function isPluginDataPath(vpath) {
  if (!vpath.startsWith(`${VIRTUAL_PLUGIN_PREFIX}/`)) return false;
  const rel = vpath.slice(VIRTUAL_PLUGIN_PREFIX.length + 1);
  if (ALLOWED_PLUGIN_FILES.has(rel)) return true;
  if (/^layouts\/(?:backups\/)?[^/]+\.json(?:\.tmp)?$/u.test(rel)) return true;
  return false;
}

function isPluginDirPath(vpath) {
  if (vpath === VIRTUAL_PLUGIN_PREFIX) return true;
  if (!vpath.startsWith(`${VIRTUAL_PLUGIN_PREFIX}/`)) return false;
  const rel = vpath.slice(VIRTUAL_PLUGIN_PREFIX.length + 1);
  return ALLOWED_PLUGIN_DIRS.has(rel);
}

function atomicWriteFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

class StateStore {
  constructor({
    vaultDir,
    readOnly = false,
    stateDir = null,
    useObsidianConfig = false,
    isolated = false,
  }) {
    this.vaultDir = path.resolve(vaultDir);
    this.readOnly = !!readOnly;
    this.useObsidianConfig = !!useObsidianConfig;
    this.isolated = !!isolated;
    this.obsidianPluginDir = path.join(this.vaultDir, '.obsidian', 'plugins', 'graphfrontier');
    this.dotGraphFrontierDir = path.join(this.vaultDir, '.graphfrontier');
    if (this.useObsidianConfig) {
      this.activeDir = this.obsidianPluginDir;
    } else if (stateDir) {
      this.activeDir = path.resolve(stateDir);
    } else {
      this.activeDir = this.dotGraphFrontierDir;
    }

    this.pluginData = null;
    this.manifest = {
      id: 'graphfrontier',
      name: 'GraphFrontier',
      version: '0.9.7',
      minAppVersion: '1.12.7',
      description: 'Standalone GraphFrontier runtime',
    };
    this.pluginFiles = new Map();
    this.pluginDirs = new Set([
      '.obsidian',
      '.obsidian/plugins',
      VIRTUAL_PLUGIN_PREFIX,
      `${VIRTUAL_PLUGIN_PREFIX}/layouts`,
    ]);
    this.diskWrites = 0;
    this.seedDir = null;

    this.loadInitialState();
  }

  loadInitialState() {
    const candidates = this.useObsidianConfig
      ? [this.obsidianPluginDir]
      : this.isolated
        ? [this.activeDir]
        : [this.activeDir, this.dotGraphFrontierDir, this.obsidianPluginDir];

    const seen = new Set();
    const existingDirs = [];
    for (const dir of candidates) {
      if (!dir) continue;
      const resolved = path.resolve(dir);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      if (fs.existsSync(resolved)) existingDirs.push(resolved);
    }

    this.seedDir =
      existingDirs.find(
        (dir) =>
          fs.existsSync(path.join(dir, 'data.json')) || fs.existsSync(path.join(dir, 'layouts'))
      ) || null;

    if (
      (!this.isolated || this.useObsidianConfig) &&
      fs.existsSync(path.join(this.obsidianPluginDir, 'manifest.json'))
    ) {
      const m = readJsonIfExists(path.join(this.obsidianPluginDir, 'manifest.json'));
      if (m && typeof m === 'object') this.manifest = { ...this.manifest, ...m };
    }
    if (!existingDirs.length) return;

    for (const dir of existingDirs) {
      const data = readJsonIfExists(path.join(dir, 'data.json'));
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        this.pluginData = data;
        break;
      }
    }

    for (const fileName of ['node-lists.json']) {
      for (const dir of existingDirs) {
        const abs = path.join(dir, fileName);
        if (!fs.existsSync(abs)) continue;
        try {
          this.pluginFiles.set(
            `${VIRTUAL_PLUGIN_PREFIX}/${fileName}`,
            fs.readFileSync(abs, 'utf8')
          );
          break;
        } catch {
          // Ignore unreadable optional file.
        }
      }
    }

    const loadLayoutsDir = (relDir) => {
      for (const dir of existingDirs) {
        const absDir = path.join(dir, relDir);
        if (!fs.existsSync(absDir)) continue;
        let entries;
        try {
          entries = fs.readdirSync(absDir, { withFileTypes: true });
        } catch {
          continue;
        }
        this.pluginDirs.add(`${VIRTUAL_PLUGIN_PREFIX}/${relDir}`);
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
          const vpath = `${VIRTUAL_PLUGIN_PREFIX}/${relDir}/${entry.name}`;
          if (this.pluginFiles.has(vpath)) continue;
          try {
            const text = fs.readFileSync(path.join(absDir, entry.name), 'utf8');
            this.pluginFiles.set(vpath, text);
          } catch {
            // Ignore unreadable layout file.
          }
        }
      }
    };
    loadLayoutsDir('layouts');
    loadLayoutsDir('layouts/backups');
  }

  getPluginFilesObject() {
    return Object.fromEntries(this.pluginFiles.entries());
  }

  getPluginData() {
    return this.pluginData ? JSON.parse(JSON.stringify(this.pluginData)) : null;
  }

  savePluginData(data) {
    this.pluginData = JSON.parse(JSON.stringify(data));
    if (this.readOnly) return { persisted: false, readOnly: true };
    const dest = path.join(this.activeDir, 'data.json');
    atomicWriteFile(dest, JSON.stringify(this.pluginData, null, 2) + '\n');
    this.diskWrites++;
    return { persisted: true };
  }

  resolveDiskPath(vpath) {
    if (!isPluginDataPath(vpath) && !isPluginDirPath(vpath)) {
      throw new Error(`Disallowed plugin adapter path: ${vpath}`);
    }
    const rel =
      vpath === VIRTUAL_PLUGIN_PREFIX ? '' : vpath.slice(VIRTUAL_PLUGIN_PREFIX.length + 1);
    const dest = path.resolve(this.activeDir, rel);
    const activeResolved = path.resolve(this.activeDir);
    if (dest !== activeResolved && !dest.startsWith(activeResolved + path.sep)) {
      throw new Error('Path escapes state directory');
    }
    return dest;
  }

  adapterWrite(rawPath, content) {
    const vpath = normalizeVirtualPath(rawPath);
    if (!isPluginDataPath(vpath)) throw new Error(`Disallowed write path: ${vpath}`);
    const text = String(content ?? '');
    this.pluginFiles.set(vpath, text);
    const dir = path.posix.dirname(vpath);
    if (dir && dir !== '.') this.pluginDirs.add(dir);
    if (this.readOnly) return { persisted: false, readOnly: true };
    const dest = this.resolveDiskPath(vpath);
    atomicWriteFile(dest, text);
    this.diskWrites++;
    return { persisted: true };
  }

  adapterRemove(rawPath) {
    const vpath = normalizeVirtualPath(rawPath);
    if (!isPluginDataPath(vpath)) throw new Error(`Disallowed remove path: ${vpath}`);
    this.pluginFiles.delete(vpath);
    if (this.readOnly) return { persisted: false, readOnly: true };
    const dest = this.resolveDiskPath(vpath);
    if (fs.existsSync(dest)) {
      fs.unlinkSync(dest);
      this.diskWrites++;
    }
    return { persisted: true };
  }

  adapterRename(rawFrom, rawTo) {
    const from = normalizeVirtualPath(rawFrom);
    const to = normalizeVirtualPath(rawTo);
    if (!isPluginDataPath(from) || !isPluginDataPath(to)) {
      throw new Error(`Disallowed rename path: ${from} -> ${to}`);
    }
    if (this.pluginFiles.has(from)) {
      this.pluginFiles.set(to, this.pluginFiles.get(from));
      this.pluginFiles.delete(from);
    }
    if (this.readOnly) return { persisted: false, readOnly: true };
    const srcDisk = this.resolveDiskPath(from);
    const dstDisk = this.resolveDiskPath(to);
    if (fs.existsSync(srcDisk)) {
      fs.mkdirSync(path.dirname(dstDisk), { recursive: true });
      fs.renameSync(srcDisk, dstDisk);
      this.diskWrites++;
    }
    return { persisted: true };
  }

  adapterMkdir(rawPath) {
    const vpath = normalizeVirtualPath(rawPath);
    if (!isPluginDirPath(vpath)) throw new Error(`Disallowed mkdir path: ${vpath}`);
    this.pluginDirs.add(vpath);
    if (this.readOnly) return { persisted: false, readOnly: true };
    const dest = this.resolveDiskPath(vpath);
    fs.mkdirSync(dest, { recursive: true });
    this.diskWrites++;
    return { persisted: true };
  }

  readMcpState() {
    if (this.readOnly) return null;
    const mcpPath = path.join(
      this.activeDir,
      this.useObsidianConfig ? 'mcp.json' : 'mcp-standalone.json'
    );
    return readJsonIfExists(mcpPath);
  }

  writeMcpState(state) {
    if (this.readOnly) return;
    const mcpPath = path.join(
      this.activeDir,
      this.useObsidianConfig ? 'mcp.json' : 'mcp-standalone.json'
    );
    atomicWriteFile(mcpPath, JSON.stringify(state) + '\n');
    this.diskWrites++;
  }

  readLocalViewState() {
    return readJsonIfExists(path.join(this.activeDir, 'local-view.json'));
  }

  writeLocalViewState(state) {
    if (this.readOnly) return { persisted: false, readOnly: true };
    if (!state || typeof state !== 'object') return { persisted: false };
    atomicWriteFile(
      path.join(this.activeDir, 'local-view.json'),
      JSON.stringify(state, null, 2) + '\n'
    );
    this.diskWrites++;
    return { persisted: true };
  }

  importFromObsidian() {
    if (this.readOnly) {
      throw new Error('Cannot import while storageMode is readOnly.');
    }
    const srcDir = this.obsidianPluginDir;
    const hasSrc =
      fs.existsSync(srcDir) &&
      (fs.existsSync(path.join(srcDir, 'data.json')) ||
        fs.existsSync(path.join(srcDir, 'layouts')));
    if (!hasSrc) {
      return { imported: false, reason: 'missing' };
    }

    if (path.resolve(this.activeDir) !== path.resolve(srcDir)) {
      const copyFileIfExists = (relFile) => {
        const srcPath = path.join(srcDir, relFile);
        if (!fs.existsSync(srcPath)) return;
        const text = fs.readFileSync(srcPath, 'utf8');
        atomicWriteFile(path.join(this.activeDir, relFile), text);
        this.diskWrites++;
      };

      const copyJsonDir = (relDir) => {
        const absSrcDir = path.join(srcDir, relDir);
        if (!fs.existsSync(absSrcDir)) return;
        let entries;
        try {
          entries = fs.readdirSync(absSrcDir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
          copyFileIfExists(path.join(relDir, entry.name));
        }
      };

      copyFileIfExists('data.json');
      copyFileIfExists('node-lists.json');
      copyJsonDir('layouts');
      copyJsonDir(path.join('layouts', 'backups'));
    }

    this.pluginData = null;
    this.pluginFiles.clear();
    this.loadInitialState();

    const layoutsCount = [...this.pluginFiles.keys()].filter(
      (k) => k.startsWith(`${VIRTUAL_PLUGIN_PREFIX}/layouts/`) && !k.includes('/layouts/backups/')
    ).length;

    return {
      imported: true,
      activeLayout: this.pluginData?.active_layout_name || 'data.json',
      layoutsCount,
    };
  }
}

module.exports = {
  VIRTUAL_PLUGIN_PREFIX,
  StateStore,
};
