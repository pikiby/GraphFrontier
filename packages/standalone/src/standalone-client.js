import * as obsidian from 'obsidian';

obsidian.installDomHelpers(window);

import { renderMarkdown } from '@gf/viewer/markdown.js';
import GraphFrontierPlugin from '@gf/main.js';
import { GRAPHFRONTIER_VIEW_TYPE } from '@gf/constants.js';

const { Events, Modal, TFile, TFolder, Notice, parseLinktext } = obsidian;

function basenameOf(filePath) {
  const name = filePath.slice(filePath.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function buildVaultTree(snapshotFiles) {
  const byPath = new Map();
  const root = Object.assign(new TFolder(), { path: '/', name: '', children: [], parent: null });
  const ensureFolder = (folderPath) => {
    if (!folderPath) return root;
    if (byPath.has(folderPath)) {
      const existing = byPath.get(folderPath);
      return existing instanceof TFolder ? existing : root;
    }
    const slash = folderPath.lastIndexOf('/');
    const parent = ensureFolder(slash > 0 ? folderPath.slice(0, slash) : '');
    const entry = Object.assign(new TFolder(), {
      path: folderPath,
      name: slash >= 0 ? folderPath.slice(slash + 1) : folderPath,
      children: [],
      parent,
    });
    parent.children.push(entry);
    byPath.set(folderPath, entry);
    return entry;
  };

  for (const entry of snapshotFiles || []) {
    const slash = entry.path.lastIndexOf('/');
    const name = slash >= 0 ? entry.path.slice(slash + 1) : entry.path;
    const dot = name.lastIndexOf('.');
    const parent = ensureFolder(slash > 0 ? entry.path.slice(0, slash) : '');
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
  return { byPath, root, ensureFolder };
}

function pickBestCandidate(candidates, exactTarget = '') {
  if (candidates.length === 1) return candidates[0];
  const exactSuffixMd = exactTarget ? `/${exactTarget}.md` : '';
  const exactSuffixRaw = exactTarget ? `/${exactTarget}` : '';
  const exactScore = (fileObj) => {
    const p = fileObj.path;
    if (!exactTarget) return 0;
    if (p === `${exactTarget}.md` || p === exactTarget) return 2;
    if (p.endsWith(exactSuffixMd) || p.endsWith(exactSuffixRaw)) return 1;
    return 0;
  };
  return [...candidates].sort((a, b) => {
    const ea = exactScore(a);
    const eb = exactScore(b);
    if (ea !== eb) return eb - ea;
    const ad = a.path.split('/').length;
    const bd = b.path.split('/').length;
    if (ad !== bd) return ad - bd;
    if (a.path.length !== b.path.length) return a.path.length - b.path.length;
    return a.path.localeCompare(b.path);
  })[0];
}

function resolveFileLink(vault, rawLinkpath, sourcePath = '') {
  const parsed = parseLinktext(String(rawLinkpath || '').trim()).path;
  let target = String(parsed || '')
    .trim()
    .replace(/\\/g, '/');
  if (!target) {
    return sourcePath ? vault.getAbstractFileByPath(sourcePath) : null;
  }
  const files = vault.getFiles();
  const byLowerPath = new Map();
  const byLowerNoExt = new Map();
  const byLowerBase = new Map();
  const byLowerBaseNoExt = new Map();
  const push = (map, key, val) => {
    let arr = map.get(key);
    if (!arr) {
      arr = [];
      map.set(key, arr);
    }
    arr.push(val);
  };
  for (const f of files) {
    const lp = f.path.toLowerCase();
    byLowerPath.set(lp, f);
    push(byLowerBase, f.name.toLowerCase(), f);
    if (f.extension.toLowerCase() === 'md') {
      byLowerNoExt.set(lp.slice(0, -3), f);
      push(byLowerBaseNoExt, f.basename.toLowerCase(), f);
    }
  }

  const srcDir =
    sourcePath && sourcePath.includes('/') ? sourcePath.slice(0, sourcePath.lastIndexOf('/')) : '';
  const normJoin = (base, rel) => {
    const parts = (base ? `${base}/${rel}` : rel).split('/');
    const stack = [];
    for (const part of parts) {
      if (!part || part === '.') continue;
      if (part === '..') {
        if (!stack.length) return null;
        stack.pop();
      } else {
        stack.push(part);
      }
    }
    return stack.join('/');
  };

  if (target.startsWith('./') || target.startsWith('../')) {
    const joined = normJoin(srcDir, target);
    if (!joined) return null;
    const lj = joined.toLowerCase();
    return byLowerPath.get(lj) || byLowerNoExt.get(lj) || null;
  }

  const lt = target.toLowerCase().replace(/^\/+/, '');
  if (byLowerPath.has(lt)) return byLowerPath.get(lt);
  if (byLowerNoExt.has(lt)) return byLowerNoExt.get(lt);

  if (srcDir) {
    const rel = normJoin(srcDir, target)?.toLowerCase();
    if (rel) {
      if (byLowerPath.has(rel)) return byLowerPath.get(rel);
      if (byLowerNoExt.has(rel)) return byLowerNoExt.get(rel);
    }
  }

  if (!target.includes('/')) {
    if (byLowerBaseNoExt.has(lt))
      return pickBestCandidate(byLowerBaseNoExt.get(lt), target.replace(/\.md$/i, ''));
    if (byLowerBase.has(lt)) return pickBestCandidate(byLowerBase.get(lt), target);
  } else {
    const matches = [];
    for (const [noExt, f] of byLowerNoExt.entries()) if (noExt.endsWith(`/${lt}`)) matches.push(f);
    for (const [lp, f] of byLowerPath.entries()) if (lp.endsWith(`/${lt}`)) matches.push(f);
    if (matches.length) return pickBestCandidate(matches, target);
  }
  return null;
}

function createPersistentAdapter(initialFiles, vaultPath) {
  const files = new Map(Object.entries(initialFiles || {}));
  const folders = new Set(['.obsidian', '.obsidian/plugins', '.obsidian/plugins/graphfrontier']);
  const addFolders = (p) => {
    let idx = p.lastIndexOf('/');
    while (idx > 0) {
      folders.add(p.slice(0, idx));
      idx = p.lastIndexOf('/', idx - 1);
    }
  };
  for (const p of files.keys()) addFolders(p);

  let serverQueue = Promise.resolve();
  const sendOp = (payload) => {
    const job = serverQueue
      .catch(() => {})
      .then(async () => {
        const res = await fetch('/api/adapter', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `Adapter sync failed (${res.status})`);
        }
      });
    serverQueue = job.catch(() => {});
    return job;
  };

  return {
    async exists(p) {
      return files.has(p) || folders.has(p);
    },
    async read(p) {
      if (!files.has(p)) throw new Error(`File not found: ${p}`);
      return files.get(p);
    },
    async write(p, text) {
      const content = String(text ?? '');
      files.set(p, content);
      addFolders(p);
      await sendOp({ op: 'write', path: p, content });
    },
    async remove(p) {
      files.delete(p);
      await sendOp({ op: 'remove', path: p });
    },
    async rename(from, to) {
      if (files.has(from)) {
        files.set(to, files.get(from));
        files.delete(from);
        addFolders(to);
      }
      await sendOp({ op: 'rename', from, to });
    },
    async mkdir(p) {
      folders.add(p);
      addFolders(p);
      await sendOp({ op: 'mkdir', path: p });
    },
    async list(p) {
      const prefix = `${p}/`;
      const direct = (entry) =>
        entry.startsWith(prefix) && !entry.slice(prefix.length).includes('/');
      return {
        files: [...files.keys()].filter(direct),
        folders: [...folders].filter(direct),
      };
    },
    files: () => Object.fromEntries(files),
    getFullPath(p) {
      return vaultPath ? `${vaultPath}/${p}` : p;
    },
    getBasePath() {
      return vaultPath || '';
    },
  };
}

function triggerHtmlDownload(filename, html) {
  try {
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename.split('/').pop() || 'graphfrontier-static.html';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch {
    // Headless or restricted environments ignore download gestures cleanly.
  }
}

function createStandaloneApp(snapshot, { onOpenNote, onOpenView, onCloseView, onSetTab }) {
  let tree = buildVaultTree(snapshot.files || []);
  let caches = snapshot.caches || {};
  const noteCache = new Map();
  const inFlightNotes = new Map();
  const virtualVaultTexts = new Map();
  let allNotesLoaded = false;
  let activeFile = null;
  let settingTab = null;
  let settingModal = null;

  const adapter = createPersistentAdapter(snapshot.pluginFiles || {}, snapshot.vaultPath || '');

  const addVirtualFile = (filePath, text) => {
    const norm = String(filePath || '')
      .replace(/\\/g, '/')
      .replace(/^\/+|\/+$/g, '');
    virtualVaultTexts.set(norm, String(text ?? ''));
    const existing = tree.byPath.get(norm);
    const now = Date.now();
    if (existing instanceof TFile) {
      existing.stat = { ...existing.stat, mtime: now, size: virtualVaultTexts.get(norm).length };
      return existing;
    }
    const slash = norm.lastIndexOf('/');
    const name = slash >= 0 ? norm.slice(slash + 1) : norm;
    const dot = name.lastIndexOf('.');
    const parent = tree.ensureFolder(slash > 0 ? norm.slice(0, slash) : '');
    const file = Object.assign(new TFile(), {
      path: norm,
      name,
      basename: basenameOf(norm),
      extension: dot > 0 ? name.slice(dot + 1) : '',
      stat: { ctime: now, mtime: now, size: virtualVaultTexts.get(norm).length },
      parent,
    });
    parent.children.push(file);
    tree.byPath.set(norm, file);
    return file;
  };

  const fetchNoteText = async (file) => {
    const filePath = file?.path;
    if (!filePath) return '';
    if (virtualVaultTexts.has(filePath)) return virtualVaultTexts.get(filePath);
    const mtime = file?.stat?.mtime || 0;
    const cached = noteCache.get(filePath);
    if (cached && cached.mtime === mtime) return cached.text;
    if (inFlightNotes.has(filePath)) return inFlightNotes.get(filePath);
    const promise = (async () => {
      try {
        const res = await fetch(`/api/note?path=${encodeURIComponent(filePath)}`);
        if (!res.ok) return '';
        const text = await res.text();
        noteCache.set(filePath, { mtime, text });
        return text;
      } catch {
        return '';
      } finally {
        inFlightNotes.delete(filePath);
      }
    })();
    inFlightNotes.set(filePath, promise);
    return promise;
  };

  const vault = Object.assign(new Events(), {
    configDir: snapshot.configDir || '.obsidian',
    adapter,
    getName: () => snapshot.vaultName || 'Vault',
    getRoot: () => tree.root,
    getFiles: () => [...tree.byPath.values()].filter((entry) => entry instanceof TFile),
    getMarkdownFiles: () =>
      [...tree.byPath.values()].filter(
        (entry) => entry instanceof TFile && entry.extension === 'md'
      ),
    getAllLoadedFiles: () => [tree.root, ...tree.byPath.values()],
    getAbstractFileByPath: (p) => (p === '/' ? tree.root : tree.byPath.get(p) || null),
    cachedRead: fetchNoteText,
    read: fetchNoteText,
    async prefetchAllNotes() {
      if (allNotesLoaded) return;
      try {
        const res = await fetch('/api/notes-all');
        if (!res.ok) return;
        const map = await res.json();
        for (const [p, text] of Object.entries(map || {})) {
          const f = tree.byPath.get(p);
          noteCache.set(p, { mtime: f?.stat?.mtime || 0, text });
        }
        allNotesLoaded = true;
      } catch {
        // Fallback to individual reads if batch fails.
      }
    },
    async createFolder(folderPath) {
      tree.ensureFolder(String(folderPath || '').replace(/^\/+|\/+$/g, ''));
    },
    async create(filePath, data) {
      const f = addVirtualFile(filePath, data);
      if (/\.html?$/iu.test(f.path)) {
        triggerHtmlDownload(f.path, String(data ?? ''));
        new Notice(`Exported ${f.path}`);
      }
      return f;
    },
    async modify(file, data) {
      const p = typeof file === 'string' ? file : file?.path;
      const f = addVirtualFile(p, data);
      if (/\.html?$/iu.test(f.path)) {
        triggerHtmlDownload(f.path, String(data ?? ''));
        new Notice(`Exported ${f.path}`);
      }
      return f;
    },
    async process(file, fn) {
      const current = await fetchNoteText(file);
      const next = fn(current);
      if (typeof next === 'string') await this.modify(file, next);
      return next;
    },
    async delete(file) {
      const p = typeof file === 'string' ? file : file?.path;
      if (!p) return;
      virtualVaultTexts.delete(p);
      noteCache.delete(p);
      const entry = tree.byPath.get(p);
      if (entry && entry.parent && Array.isArray(entry.parent.children)) {
        entry.parent.children = entry.parent.children.filter((c) => c !== entry);
      }
      tree.byPath.delete(p);
    },
    async trash(file) {
      await this.delete(file);
    },
    async rename(file, newPath) {
      const oldPath = typeof file === 'string' ? file : file?.path;
      if (!oldPath || !newPath) return;
      const text = await fetchNoteText({ path: oldPath, stat: file?.stat });
      await this.delete(oldPath);
      addVirtualFile(newPath, text);
    },
  });

  const metadataCache = Object.assign(new Events(), {
    resolvedLinks: snapshot.resolvedLinks || {},
    unresolvedLinks: snapshot.unresolvedLinks || {},
    getFileCache: (file) => (file?.path ? caches[file.path] || null : null),
    getCache: (p) => caches[p] || null,
    getFirstLinkpathDest: (linkpath, sourcePath) => resolveFileLink(vault, linkpath, sourcePath),
  });

  const leaves = [];

  function makeLeaf() {
    const leaf = {
      app: null,
      view: null,
      viewState: {},
      async openFile(file) {
        if (!file) return;
        activeFile = file;
        await onOpenNote?.(file);
        workspace.trigger('file-open', file);
      },
      async setViewState(state) {
        const type = state?.type;
        leaf.viewState = state || {};
        if (!type) return;
        const factory = app.viewFactories.get(type);
        if (!factory) return;
        if (!leaf.view || leaf.view.getViewType?.() !== type) {
          leaf.view = factory(leaf);
          await onOpenView?.(leaf, type, state);
        }
        if (state?.active !== false) workspace.activeLeaf = leaf;
      },
      getViewState: () => ({ ...leaf.viewState }),
      detach() {
        onCloseView?.(leaf);
      },
    };
    leaf.app = app;
    return leaf;
  }

  const workspace = Object.assign(new Events(), {
    layoutReady: true,
    activeLeaf: null,
    onLayoutReady: (cb) => setTimeout(cb, 0),
    getLeavesOfType: (type) => leaves.filter((leaf) => leaf.view?.getViewType?.() === type),
    getLeaf(arg) {
      if (arg === 'split' || arg === 'tab' || arg === true) return makeLeaf();
      return {
        openFile: async (file) => {
          if (!file) return;
          activeFile = file;
          await onOpenNote?.(file);
          workspace.trigger('file-open', file);
        },
        setViewState: async (state) => makeLeaf().setViewState(state),
        getViewState: () => ({}),
        detach: () => {},
      };
    },
    getRightLeaf: () => null,
    getMostRecentLeaf: () => workspace.activeLeaf || leaves[0] || null,
    async revealLeaf(leaf) {
      if (leaf && leaves.includes(leaf)) {
        workspace.activeLeaf = leaf;
        onOpenView?.(leaf, leaf.view?.getViewType?.(), { revealOnly: true });
      }
    },
    setActiveLeaf(leaf) {
      if (leaf) workspace.activeLeaf = leaf;
    },
    getActiveFile: () => activeFile,
    requestSaveLayout: () => {},
    iterateAllLeaves: (cb) => leaves.forEach(cb),
  });

  const app = {
    vault,
    metadataCache,
    workspace,
    pluginData: snapshot.pluginData ?? null,
    viewFactories: new Map(),
    leaves,
    scope: null,
    fileManager: {
      processFrontMatter: async () => {
        new Notice('Editing note frontmatter is disabled in standalone viewer');
      },
      promptForDeletion: async () => {},
    },
    viewRegistry: { getTypeByExtension: (ext) => (ext === 'md' ? 'markdown' : null) },
    async openWithDefaultApp(targetPath) {
      if (virtualVaultTexts.has(targetPath) && /\.html?$/iu.test(targetPath)) {
        const blob = new Blob([virtualVaultTexts.get(targetPath)], {
          type: 'text/html;charset=utf-8',
        });
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank', 'noopener');
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        return;
      }
      new Notice(`Standalone: open locally -> ${targetPath}`);
    },
    commands: { executeCommandById: () => false },
    setting: {
      open() {
        if (!settingTab) return;
        if (settingModal) {
          settingModal.close();
          settingModal = null;
        }
        const modal = new Modal(app);
        modal.setTitle('GraphFrontier Settings');
        modal.contentEl.appendChild(settingTab.containerEl);
        modal.onClose = () => {
          settingTab?.hide?.();
          if (settingModal === modal) settingModal = null;
        };
        settingTab.display();
        modal.open();
        settingModal = modal;
      },
      openTabById() {
        onSetTab?.(settingTab);
        this.open();
      },
    },
    setSettingTab(tab) {
      settingTab = tab;
    },
    applyVaultUpdate(msg) {
      if (Array.isArray(msg.changed)) {
        for (const p of msg.changed) {
          noteCache.delete(p);
          inFlightNotes.delete(p);
        }
      }
      if (Array.isArray(msg.removed)) {
        for (const p of msg.removed) {
          noteCache.delete(p);
          inFlightNotes.delete(p);
        }
      }
      allNotesLoaded = false;
      tree = buildVaultTree(msg.files || []);
      caches = msg.caches || {};
      metadataCache.resolvedLinks = msg.resolvedLinks || {};
      metadataCache.unresolvedLinks = msg.unresolvedLinks || {};
      metadataCache.trigger('changed');
      metadataCache.trigger('resolved');
    },
  };

  return app;
}

function createNoteReader(app) {
  const panel = document.body.createDiv({ cls: 'graphfrontier-reader' });
  const header = panel.createDiv({ cls: 'graphfrontier-reader-header' });
  const title = header.createDiv({ cls: 'graphfrontier-reader-title' });
  const close = header.createEl('button', {
    cls: 'graphfrontier-reader-close',
    attr: { 'aria-label': 'Close' },
  });
  obsidian.setIcon(close, 'x');
  if (!close.firstChild) close.setText('×');
  const body = panel.createDiv({ cls: 'graphfrontier-reader-body markdown-rendered' });
  close.addEventListener('click', () => panel.removeClass('is-open'));
  return {
    async open(file) {
      title.setText(file.basename || file.path);
      title.setAttr('title', file.path);
      const content = await app.vault.cachedRead(file);
      renderMarkdown(content, body);
      if (!body.firstChild) body.createEl('p', { text: '(empty)' });
      body.scrollTop = 0;
      panel.addClass('is-open');
    },
    close() {
      panel.removeClass('is-open');
    },
  };
}

function installKeyScopeDispatcher(app) {
  window.addEventListener('keydown', (event) => {
    if (document.querySelector('.modal-container')) return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)
    ) {
      return;
    }
    const view = app.workspace.activeLeaf?.view;
    const keys = view?.scope?.keys;
    if (!Array.isArray(keys) || !keys.length) return;
    const modPressed = event.ctrlKey || event.metaKey;
    for (const entry of keys) {
      const mods = entry.modifiers || [];
      const wantsCtrlOrMeta =
        mods.includes('Ctrl') || mods.includes('Meta') || mods.includes('Mod');
      const wantsShift = mods.includes('Shift');
      const wantsAlt = mods.includes('Alt');
      if (wantsCtrlOrMeta !== modPressed) continue;
      if (wantsShift !== event.shiftKey) continue;
      if (wantsAlt !== event.altKey) continue;
      if (entry.key !== null && entry.key.toLowerCase() !== event.key.toLowerCase()) continue;
      if (entry.callback?.(event) === false) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }
  });
}

async function boot() {
  const res = await fetch('/api/snapshot');
  if (!res.ok) throw new Error(`Snapshot fetch failed (${res.status})`);
  const snapshot = await res.json();

  if (snapshot.vaultThemeCss) {
    const styleEl = document.getElementById('gf-vault-theme');
    if (styleEl) {
      styleEl.textContent = snapshot.vaultThemeCss;
    } else if (typeof CSSStyleSheet !== 'undefined' && Array.isArray(document.adoptedStyleSheets)) {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(snapshot.vaultThemeCss);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    }
  }

  obsidian.setIconSet(snapshot.icons || {});
  document.body.addClass(...(snapshot.bodyClasses || ['theme-dark']));
  if (snapshot.vaultName) {
    document.title = `GraphFrontier — ${snapshot.vaultName}`;
  }

  const rootEl = document.getElementById('graphfrontier-root');
  let reader = null;
  let app = null;

  const secondaryBackBar = document.body.createDiv({
    cls: 'gf-standalone-subview-bar graphfrontier-viewer-hidden',
  });
  const backBtn = secondaryBackBar.createEl('button', {
    cls: 'mod-cta',
    text: '← Back to global graph',
  });

  const showLeaf = (targetLeaf) => {
    for (const l of app.leaves) {
      if (l.view?.containerEl) {
        l.view.containerEl.toggleClass('graphfrontier-viewer-hidden', l !== targetLeaf);
      }
    }
    app.workspace.activeLeaf = targetLeaf;
    const isPrimary = targetLeaf === app.leaves[0];
    secondaryBackBar.toggleClass('graphfrontier-viewer-hidden', isPrimary);
    targetLeaf.view?.resizeCanvas?.();
    targetLeaf.view?.requestFrame?.();
  };

  backBtn.addEventListener('click', () => {
    const active = app.workspace.activeLeaf;
    if (active && active !== app.leaves[0]) active.detach();
  });

  app = createStandaloneApp(snapshot, {
    onOpenNote: (file) => reader?.open(file),
    onOpenView: async (leaf, _type, opts) => {
      if (opts?.revealOnly) {
        showLeaf(leaf);
        return;
      }
      if (!app.leaves.includes(leaf)) app.leaves.push(leaf);
      rootEl.appendChild(leaf.view.containerEl);
      leaf.view.load();
      await leaf.view.onOpen();
      showLeaf(leaf);
    },
    onCloseView: (leaf) => {
      const idx = app.leaves.indexOf(leaf);
      if (idx > 0) {
        app.leaves.splice(idx, 1);
        leaf.view?.unload?.();
        leaf.view?.containerEl?.remove();
        showLeaf(app.leaves[0]);
      }
    },
  });

  reader = createNoteReader(app);
  installKeyScopeDispatcher(app);

  const plugin = new GraphFrontierPlugin(app, snapshot.manifest);
  // Keep plugin.exportPage and plugin.exportLayoutGraphs strictly undefined for full native mode.
  plugin.addSettingTab = (tab) => app.setSettingTab(tab);

  let saveQueue = Promise.resolve();
  plugin.saveData = async (data) => {
    app.pluginData = JSON.parse(JSON.stringify(data));
    const job = saveQueue
      .catch(() => {})
      .then(async () => {
        const r = await fetch('/api/plugin-data', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(app.pluginData),
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          throw new Error(err.error || `saveData failed (${r.status})`);
        }
      });
    saveQueue = job.catch(() => {});
    return job;
  };

  // Prefetch notes smoothly if user invokes `line:` query filter.
  const origRequestNoteLines = plugin.requestNoteLines.bind(plugin);
  plugin.requestNoteLines = () => {
    void app.vault.prefetchAllNotes().finally(() => {
      origRequestNoteLines();
    });
  };

  await plugin.onload();
  app.metadataCache.trigger('resolved');
  // Cancel the pre-view 300ms refresh scheduled before any view existed; view.onOpen() builds once.
  if (plugin._refreshTimer) {
    window.clearTimeout(plugin._refreshTimer);
    plugin._refreshTimer = null;
    plugin._pendingRefreshOptions = {};
  }

  const leaf = {
    app,
    view: null,
    viewState: { type: GRAPHFRONTIER_VIEW_TYPE },
    getViewState: () => ({ type: GRAPHFRONTIER_VIEW_TYPE }),
    setViewState: async (state) => {
      if (state) leaf.viewState = state;
    },
    openFile: (file) => app.workspace.getLeaf().openFile(file),
    detach: () => {},
  };
  const view = app.viewFactories.get(GRAPHFRONTIER_VIEW_TYPE)(leaf);
  leaf.view = view;
  app.leaves.push(leaf);
  app.workspace.activeLeaf = leaf;
  rootEl.appendChild(view.containerEl);
  view.load();
  await view.onOpen();

  // Connect live SSE channel for vault file changes and Node MCP -> browser RPC calls.
  const clientId =
    (typeof crypto?.randomUUID === 'function' && crypto.randomUUID()) ||
    `gf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const activeRpcAborters = new Map();

  const es = new EventSource(`/api/events?clientId=${encodeURIComponent(clientId)}`);
  es.addEventListener('vault-update', (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      app.applyVaultUpdate(msg);
      if (msg.mcpState && plugin.mcp?.applyState) {
        plugin.mcp.applyState(msg.mcpState);
      }
    } catch (error) {
      console.error('Vault SSE update failed:', error);
    }
  });
  es.addEventListener('mcp-abort', (ev) => {
    try {
      const { callId } = JSON.parse(ev.data);
      activeRpcAborters.get(callId)?.abort();
    } catch {
      // Ignore malformed abort packet.
    }
  });
  es.addEventListener('mcp-rpc', async (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    const { callId, method, args, readOnly } = msg;
    const ac = new AbortController();
    activeRpcAborters.set(callId, ac);
    let payload;
    try {
      const result = await plugin.api.runTool(method, args, readOnly, ac.signal);
      payload = { callId, ok: true, result };
    } catch (error) {
      payload = {
        callId,
        ok: false,
        error: {
          code: typeof error?.code === 'string' ? error.code : 'INTERNAL_ERROR',
          message: error?.message || 'Graph operation failed.',
          isGraphApiError: error?.name === 'GraphApiError' || typeof error?.code === 'string',
        },
      };
    } finally {
      activeRpcAborters.delete(callId);
    }
    try {
      await fetch('/api/mcp-rpc-result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      console.error('Failed to return MCP RPC result:', error);
    }
  });

  window.__graphFrontierStandalone = {
    app,
    plugin,
    view,
    snapshotMeta: {
      vaultName: snapshot.vaultName,
      fileCount: snapshot.files?.length || 0,
      mdCount: Object.keys(snapshot.caches || {}).length,
      readOnly: !!snapshot.readOnly,
      themeName: snapshot.themeName || '',
    },
  };
}

boot().catch((error) => {
  document.body.createDiv({
    cls: 'graphfrontier-boot-error',
    text: `Cannot start GraphFrontier Standalone: ${error?.message || error}`,
  });
  console.error(error);
});
