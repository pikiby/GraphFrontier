import * as obsidian from 'obsidian';

obsidian.installDomHelpers(window);

import GraphFrontierPlugin from '@gf/main.js';
import { GRAPHFRONTIER_VIEW_TYPE, LOCAL_GRAPHFRONTIER_VIEW_TYPE } from '@gf/constants.js';

const { Events, Modal, TFile, TFolder, Notice, parseLinktext } = obsidian;

function acquireBridge() {
  if (typeof window.acquireVsCodeApi !== 'function') {
    throw new Error('VS Code Webview API is unavailable.');
  }
  const vscodeApi = window.acquireVsCodeApi();
  const pending = new Map();
  const listeners = new Set();
  let reqSeq = 0;

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'rpc-res') {
      const entry = pending.get(msg.reqId);
      if (!entry) return;
      pending.delete(msg.reqId);
      if (msg.ok) entry.resolve(msg.result);
      else entry.reject(new Error(msg.error || 'VS Code RPC failed'));
      return;
    }
    for (const fn of listeners) fn(msg);
  });

  const rpc = (action, payload = {}) =>
    new Promise((resolve, reject) => {
      const reqId = `req-${++reqSeq}-${Date.now().toString(36)}`;
      pending.set(reqId, { resolve, reject });
      vscodeApi.postMessage({ type: 'rpc-req', reqId, action, payload });
    });

  return {
    rpc,
    postMessage: (msg) => vscodeApi.postMessage(msg),
    onMessage: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

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
  const target = String(parsed || '')
    .trim()
    .replace(/\\/g, '/');
  if (!target) return sourcePath ? vault.getAbstractFileByPath(sourcePath) : null;

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

function createRpcAdapter(initialFiles, vaultPath, rpc) {
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
    const job = serverQueue.catch(() => {}).then(() => rpc('adapter-op', payload));
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
    applyRemoteSync(msg) {
      if (msg.op === 'write') {
        files.set(msg.path, String(msg.content ?? ''));
        addFolders(msg.path);
      } else if (msg.op === 'remove') {
        files.delete(msg.path);
      } else if (msg.op === 'rename') {
        if (files.has(msg.from)) {
          files.set(msg.to, files.get(msg.from));
          files.delete(msg.from);
          addFolders(msg.to);
        }
      } else if (msg.op === 'mkdir') {
        folders.add(msg.path);
        addFolders(msg.path);
      }
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

function createVsCodeApp(snapshot, rpc, { onGetPlugin, onRequestSaveLayout } = {}) {
  let tree = buildVaultTree(snapshot.files || []);
  let caches = snapshot.caches || {};
  const noteCache = new Map();
  const inFlightNotes = new Map();
  const virtualVaultTexts = new Map();
  let allNotesLoaded = false;
  let activeFile = snapshot.activeEditorPath
    ? tree.byPath.get(snapshot.activeEditorPath) || null
    : null;
  let settingTab = null;
  let settingModal = null;

  const adapter = createRpcAdapter(snapshot.pluginFiles || {}, snapshot.vaultPath || '', rpc);

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
        const res = await rpc('read-note', { path: filePath });
        const text = String(res?.text ?? '');
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
        const res = await rpc('read-notes-all');
        for (const [p, text] of Object.entries(res?.files || {})) {
          const f = tree.byPath.get(p);
          noteCache.set(p, { mtime: f?.stat?.mtime || 0, text });
        }
        allNotesLoaded = true;
      } catch {
        // Fallback to single reads.
      }
    },
    async createFolder(folderPath) {
      tree.ensureFolder(String(folderPath || '').replace(/^\/+|\/+$/g, ''));
    },
    async create(filePath, data) {
      const f = addVirtualFile(filePath, data);
      if (/\.html?$/iu.test(f.path)) {
        const res = await rpc('save-exported-html', { path: f.path, html: String(data ?? '') });
        if (res?.saved) new Notice(`Exported ${f.path}`);
        else new Notice(`Export skipped (read-only): ${f.path}`);
      }
      return f;
    },
    async modify(file, data) {
      const p = typeof file === 'string' ? file : file?.path;
      const f = addVirtualFile(p, data);
      if (/\.html?$/iu.test(f.path)) {
        const res = await rpc('save-exported-html', { path: f.path, html: String(data ?? '') });
        if (res?.saved) new Notice(`Exported ${f.path}`);
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
      if (entry?.parent && Array.isArray(entry.parent.children)) {
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

  function makeRemoteSplitLeaf() {
    const splitLeaf = {
      app,
      view: null,
      viewState: {},
      async openFile(file) {
        if (!file?.path) return;
        await rpc('open-vault-file', { path: file.path });
        activeFile = file;
        workspace.trigger('file-open', file);
      },
      async setViewState(state) {
        splitLeaf.viewState = state || {};
        const plugin = onGetPlugin?.();
        const type = state?.type;
        if (type === LOCAL_GRAPHFRONTIER_VIEW_TYPE || type === 'localgraph') {
          const targetPath =
            plugin?.pendingLocalFiles?.get(splitLeaf) ||
            state?.state?.local?.path ||
            activeFile?.path ||
            '';
          await rpc('open-local-graph-panel', { path: targetPath });
          splitLeaf.view = { isOpen: false };
          return;
        }
        if (type === GRAPHFRONTIER_VIEW_TYPE) {
          const sub = plugin?.pendingSubgraphScopes?.get(splitLeaf) || state?.state?.subgraph;
          if (sub) {
            // Flush any debounced plugin.data edits (e.g. brand-new subgraph or drag) before opening split panel.
            await plugin?.persistPluginDataOnly?.();
            const res = await rpc('open-subgraph-panel', {
              subgraphId: sub.id,
              layout: sub.layout,
            });
            splitLeaf.view = {
              isOpen: false,
              subgraphScope: sub,
              remoteViewState: res?.viewState || null,
            };
          }
        }
      },
      getViewState: () => ({ ...splitLeaf.viewState }),
      detach: () => {},
    };
    return splitLeaf;
  }

  const workspace = Object.assign(new Events(), {
    layoutReady: true,
    activeLeaf: null,
    onLayoutReady: (cb) => setTimeout(cb, 0),
    getLeavesOfType: (type) => leaves.filter((leaf) => leaf.view?.getViewType?.() === type),
    getLeaf(arg) {
      if (arg === 'split' || arg === 'tab' || arg === true) return makeRemoteSplitLeaf();
      return {
        async openFile(file) {
          if (!file?.path) return;
          await rpc('open-vault-file', { path: file.path });
          activeFile = file;
          workspace.trigger('file-open', file);
        },
        setViewState: async (state) => makeRemoteSplitLeaf().setViewState(state),
        getViewState: () => ({}),
        detach: () => {},
      };
    },
    getRightLeaf: () => null,
    getMostRecentLeaf: () => workspace.activeLeaf || leaves[0] || null,
    async revealLeaf() {},
    setActiveLeaf(leaf) {
      if (leaf) workspace.activeLeaf = leaf;
    },
    getActiveFile: () => activeFile,
    requestSaveLayout: () => onRequestSaveLayout?.(),
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
        new Notice('Edit YAML frontmatter directly in the VS Code editor.');
      },
      promptForDeletion: async () => {},
    },
    viewRegistry: { getTypeByExtension: (ext) => (ext === 'md' ? 'markdown' : null) },
    async openWithDefaultApp(targetPath) {
      await rpc('open-vault-file', { path: targetPath });
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
        this.open();
      },
    },
    setSettingTab(tab) {
      settingTab = tab;
    },
    setActiveFileFromHost(relPath) {
      const f = relPath ? tree.byPath.get(relPath) || null : null;
      if (!f) return;
      activeFile = f;
      workspace.trigger('file-open', f);
    },
    applyVaultUpdate(msg) {
      for (const p of msg.changed || []) {
        noteCache.delete(p);
        inFlightNotes.delete(p);
      }
      for (const p of msg.removed || []) {
        noteCache.delete(p);
        inFlightNotes.delete(p);
      }
      allNotesLoaded = false;
      tree = buildVaultTree(msg.files || []);
      caches = msg.caches || {};
      metadataCache.resolvedLinks = msg.resolvedLinks || {};
      metadataCache.unresolvedLinks = msg.unresolvedLinks || {};
      if (activeFile?.path) activeFile = tree.byPath.get(activeFile.path) || null;
      metadataCache.trigger('changed');
      metadataCache.trigger('resolved');
    },
  };

  return app;
}

function installThemeObserver(snapshot, app) {
  if (snapshot.preferObsidianTheme) {
    if (snapshot.vaultThemeCss) {
      const styleEl = document.getElementById('gf-vault-theme');
      if (styleEl) {
        styleEl.textContent = snapshot.vaultThemeCss;
      } else if (
        typeof CSSStyleSheet !== 'undefined' &&
        Array.isArray(document.adoptedStyleSheets)
      ) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(snapshot.vaultThemeCss);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      }
    }
    document.body.addClass(...(snapshot.bodyClasses || ['theme-dark']));
    return;
  }

  const syncBodyTheme = () => {
    const isLight =
      document.body.classList.contains('vscode-light') ||
      document.body.classList.contains('vscode-high-contrast-light');
    const prevLight = document.body.classList.contains('theme-light');
    const prevDark = document.body.classList.contains('theme-dark');
    document.body.classList.toggle('theme-light', isLight);
    document.body.classList.toggle('theme-dark', !isLight);
    if (prevLight !== isLight || prevDark === isLight) {
      app.workspace.trigger('css-change');
    }
  };
  syncBodyTheme();

  if (typeof MutationObserver === 'function') {
    const mo = new MutationObserver(() => syncBodyTheme());
    mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }
}

async function boot() {
  const bridge = acquireBridge();
  window.__gfVscodeRpc = bridge.rpc;

  const snapshot = await bridge.rpc('get-snapshot');
  obsidian.setIconSet(snapshot.icons || {});

  let plugin = null;
  let applyingRemoteSync = false;
  let scheduleLocalViewSave = null;
  let flushLocalViewSave = null;

  const app = createVsCodeApp(snapshot, bridge.rpc, {
    onGetPlugin: () => plugin,
    onRequestSaveLayout: () => scheduleLocalViewSave?.(),
  });
  installThemeObserver(snapshot, app);
  installKeyScopeDispatcher(app);

  plugin = new GraphFrontierPlugin(app, snapshot.manifest);
  plugin.addSettingTab = (tab) => app.setSettingTab(tab);

  const mode = snapshot.bootMode || { kind: 'global' };

  let saveQueue = Promise.resolve();
  plugin.saveData =
    mode.kind === 'local'
      ? async () => {}
      : async (data) => {
          app.pluginData = JSON.parse(JSON.stringify(data));
          if (applyingRemoteSync) return;
          const job = saveQueue
            .catch(() => {})
            .then(() => bridge.rpc('save-plugin-data', { data: app.pluginData }));
          saveQueue = job.catch(() => {});
          return job;
        };

  // Secondary tabs (subgraph/local) must inherit live controller pluginData rather than overwriting
  // unsaved changes (like newly created subgraphs) with an older layouts/*.json file on disk.
  if (mode.kind !== 'global' && snapshot.hasLiveGlobalState && snapshot.pluginData) {
    plugin.bootstrapActiveLayoutData = async () => true;
  }

  const origRequestNoteLines = plugin.requestNoteLines.bind(plugin);
  plugin.requestNoteLines = () => {
    void app.vault.prefetchAllNotes().finally(() => {
      origRequestNoteLines();
    });
  };

  if (!snapshot.pluginData && snapshot.defaultHideOrphans === false) {
    const origLoadData = plugin.loadData.bind(plugin);
    plugin.loadData = async () => {
      const d = await origLoadData();
      if (d) return d;
      const seeded = plugin.normalizeData(null);
      seeded.settings.hide_orphans = false;
      return seeded;
    };
  }

  await plugin.onload();
  if (!snapshot.pluginData && snapshot.defaultHideOrphans === false && plugin.data?.settings) {
    plugin.data.settings.hide_orphans = false;
  }
  app.metadataCache.trigger('resolved');
  if (plugin._refreshTimer) {
    window.clearTimeout(plugin._refreshTimer);
    plugin._refreshTimer = null;
    plugin._pendingRefreshOptions = {};
  }

  const viewType = mode.kind === 'local' ? LOCAL_GRAPHFRONTIER_VIEW_TYPE : GRAPHFRONTIER_VIEW_TYPE;
  const savedLocal = mode.kind === 'local' ? snapshot.localViewState?.local || null : null;
  const initialLocalState = savedLocal
    ? {
        ...savedLocal,
        path: mode.initialFile || savedLocal.path || '',
      }
    : { path: mode.initialFile || '' };
  const leafState =
    mode.kind === 'subgraph'
      ? {
          type: GRAPHFRONTIER_VIEW_TYPE,
          state: { subgraph: { id: mode.subgraphId, layout: mode.layout } },
        }
      : mode.kind === 'local'
        ? { type: LOCAL_GRAPHFRONTIER_VIEW_TYPE, state: { local: initialLocalState } }
        : { type: GRAPHFRONTIER_VIEW_TYPE };

  const leaf = {
    app,
    view: null,
    getViewState: () => leafState,
    setViewState: async () => {},
    openFile: (file) => app.workspace.getLeaf(true).openFile(file),
    detach: () => {},
  };

  const factory = app.viewFactories.get(viewType);
  if (!factory) throw new Error(`View factory missing for ${viewType}`);
  const view = factory(leaf);
  if (mode.kind === 'local' && view.plugin?.data?.settings) {
    view.plugin.data.settings.show_only_groups = false;
  }
  view.openLocalGraphForNode = async (nodeId) => {
    const abstractFile = app.vault.getAbstractFileByPath(nodeId);
    if (!abstractFile || String(abstractFile.extension || '').toLowerCase() !== 'md') return;
    await bridge.rpc('open-local-graph-panel', { path: abstractFile.path });
  };
  leaf.view = view;
  app.leaves.push(leaf);
  app.workspace.activeLeaf = leaf;
  document.getElementById('graphfrontier-root').appendChild(view.containerEl);
  view.load();
  await view.onOpen();

  if (mode.kind === 'local') {
    let localSaveTimer = null;
    flushLocalViewSave = async () => {
      if (localSaveTimer) {
        window.clearTimeout(localSaveTimer);
        localSaveTimer = null;
      }
      try {
        await bridge.rpc('save-local-view-state', { state: view.getState() });
      } catch {
        // Ignore save errors if panel is disposing.
      }
    };
    scheduleLocalViewSave = () => {
      if (localSaveTimer) window.clearTimeout(localSaveTimer);
      localSaveTimer = window.setTimeout(() => {
        localSaveTimer = null;
        void flushLocalViewSave();
      }, 250);
    };
    const origSaveCurrentLayout = view.saveCurrentLayout.bind(view);
    view.saveCurrentLayout = async (options) => {
      const res = await origSaveCurrentLayout(options);
      if (res) await flushLocalViewSave();
      return res;
    };
  }

  let markdownCount =
    typeof snapshot.markdownCount === 'number'
      ? snapshot.markdownCount
      : (snapshot.files || []).filter((f) =>
          String(f.path || '')
            .toLowerCase()
            .endsWith('.md')
        ).length;

  if (mode.kind === 'local') {
    const emptyLocalEl = document.body.createDiv({ cls: 'gf-vsc-empty-local' });
    const card = emptyLocalEl.createDiv({ cls: 'gf-vsc-empty-card' });
    card.createDiv({ cls: 'gf-vsc-empty-title', text: 'Local GraphFrontier' });
    card.createDiv({
      cls: 'gf-vsc-empty-desc',
      text: 'Open any Markdown (.md) file in the editor to see its local connections, or open the full workspace graph.',
    });
    const openGlobalBtn = card.createEl('button', {
      cls: 'mod-cta gf-vsc-open-global-btn',
      text: 'Open Workspace Graph',
      attr: { type: 'button' },
    });
    openGlobalBtn.addEventListener('click', () => {
      void bridge.rpc('open-global-graph-panel');
    });

    const updateLocalBanner = () => {
      const hasLocal = !!view.localPath;
      emptyLocalEl.classList.toggle('graphfrontier-viewer-hidden', hasLocal);
    };
    updateLocalBanner();
    app.workspace.on('file-open', updateLocalBanner);
  }

  let updateGlobalHint = null;
  if (mode.kind === 'global') {
    const filterHintEl = document.body.createDiv({
      cls: 'gf-vsc-filter-hint graphfrontier-viewer-hidden',
    });
    const filterHintTextEl = filterHintEl.createSpan({ cls: 'gf-vsc-filter-hint-text' });
    const showAllBtn = filterHintEl.createEl('button', {
      cls: 'mod-cta gf-vsc-filter-hint-btn',
      text: 'Show All Markdown Files',
      attr: { type: 'button' },
    });
    showAllBtn.addEventListener('click', () => {
      plugin.data.settings.hide_orphans = false;
      plugin.data.settings.show_only_groups = false;
      view.refreshFromVault({ keepCamera: false });
      view.buildSidePanel?.();
      void plugin.persistPluginDataOnly();
      updateGlobalHint?.();
    });

    updateGlobalHint = () => {
      const visibleIds = view.getFilterVisibleNodeIds?.();
      const visibleCount =
        visibleIds instanceof Set
          ? view.nodes.filter((n) => visibleIds.has(n.id)).length
          : view.nodes.length;
      if (markdownCount === 0 && view.nodes.length === 0) {
        filterHintTextEl.textContent = 'No Markdown (.md) files found in this workspace.';
        showAllBtn.classList.add('graphfrontier-viewer-hidden');
        filterHintEl.classList.remove('graphfrontier-viewer-hidden');
        return;
      }
      if (
        markdownCount > 0 &&
        visibleCount === 0 &&
        (plugin.data.settings?.hide_orphans || plugin.data.settings?.show_only_groups)
      ) {
        filterHintTextEl.textContent = '0 visible nodes (filtered by current graph settings)';
        showAllBtn.classList.remove('graphfrontier-viewer-hidden');
        filterHintEl.classList.remove('graphfrontier-viewer-hidden');
        return;
      }
      filterHintEl.classList.add('graphfrontier-viewer-hidden');
    };

    const origRefresh = view.refreshFromVault.bind(view);
    view.refreshFromVault = function (opts) {
      const res = origRefresh(opts);
      updateGlobalHint();
      return res;
    };
    const origRender = view.render.bind(view);
    view.render = function () {
      const res = origRender();
      updateGlobalHint();
      return res;
    };
    updateGlobalHint();
  }

  const activeRpcAborters = new Map();

  bridge.onMessage(async (msg) => {
    if (msg.type === 'state-sync') {
      if (msg.sourcePanelId === snapshot.panelId || !msg.pluginData) return;
      applyingRemoteSync = true;
      try {
        app.pluginData = JSON.parse(JSON.stringify(msg.pluginData));
        plugin.data = plugin.normalizeData(app.pluginData);
        if (plugin._refreshTimer) {
          window.clearTimeout(plugin._refreshTimer);
          plugin._refreshTimer = null;
        }
        plugin.refreshAllViews({ keepCamera: true, passive: true });
      } finally {
        applyingRemoteSync = false;
      }
      return;
    }

    if (msg.type === 'adapter-sync') {
      if (msg.sourcePanelId === snapshot.panelId) return;
      app.vault.adapter.applyRemoteSync(msg);
      if (String(msg.path || '').endsWith('node-lists.json')) {
        await plugin.nodeListStore?.load();
        plugin.nodeListsChanged();
      }
      return;
    }

    if (msg.type === 'vault-update') {
      markdownCount = (msg.files || []).filter((f) =>
        String(f.path || '')
          .toLowerCase()
          .endsWith('.md')
      ).length;
      app.applyVaultUpdate(msg);
      return;
    }

    if (msg.type === 'active-file-changed') {
      app.setActiveFileFromHost(msg.path);
      return;
    }

    if (msg.type === 'mcp-state') {
      plugin.mcp?.applyState?.(msg);
      return;
    }

    if (msg.type === 'mcp-abort') {
      activeRpcAborters.get(msg.callId)?.abort();
      return;
    }

    if (msg.type === 'mcp-rpc') {
      const { callId, method, args, readOnly } = msg;
      const ac = new AbortController();
      activeRpcAborters.set(callId, ac);
      let payload;
      try {
        const result = await plugin.api.runTool(method, args, readOnly, ac.signal);
        if (!readOnly) await plugin.persistPluginDataOnly();
        payload = { type: 'mcp-rpc-result', callId, ok: true, result };
      } catch (error) {
        payload = {
          type: 'mcp-rpc-result',
          callId,
          ok: false,
          error: {
            code: typeof error?.code === 'string' ? error.code : 'INTERNAL_ERROR',
            message: error?.message || 'Graph operation failed.',
          },
        };
      } finally {
        activeRpcAborters.delete(callId);
      }
      bridge.postMessage(payload);
    }
  });

  const viewState =
    viewType === GRAPHFRONTIER_VIEW_TYPE
      ? plugin.api.state(view)
      : { kind: 'local', path: view.localPath || '' };
  await bridge.rpc('panel-ready', { viewState });

  window.__graphFrontierVscode = {
    app,
    plugin,
    view,
    rpc: bridge.rpc,
    snapshotMeta: {
      panelId: snapshot.panelId,
      bootMode: mode,
      vaultName: snapshot.vaultName,
    },
  };
}

boot().catch((error) => {
  document.body.createDiv({
    cls: 'graphfrontier-boot-error',
    text: `Cannot start GraphFrontier: ${error?.message || error}`,
  });
  console.error(error);
});
