'use strict';

const nodeCrypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { indexVault } = require('../../standalone/src/indexer.cjs');
const { StateStore } = require('../../standalone/src/state-store.cjs');
const icons = require('../../standalone/src/icons.json');
const { GraphFrontierMcpServer, GraphApiError } = require('./mcp-runtime.cjs');

const SECRET_RE = /^[a-f0-9]{64}$/;
const RPC_TIMEOUT_MS = 55000;
const PANEL_READY_TIMEOUT_MS = 10000;

function defaultVsCodeMcpPort(key) {
  const text = String(key || 'graphfrontier-vscode');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return 47125 + ((hash >>> 0) % 10000);
}

function validateVaultRelPath(workspaceDir, workspaceRealDir, rawPath) {
  const normalized = String(rawPath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/+/g, '/');
  if (!normalized || normalized.includes('\0')) return null;
  const parts = normalized.split('/');
  if (
    parts.some((p) => !p || p === '.' || p === '..' || p.startsWith('.') || p === 'node_modules')
  ) {
    return null;
  }
  const resolved = path.resolve(workspaceDir, normalized);
  if (!resolved.startsWith(workspaceDir + path.sep)) return null;
  try {
    const real = fs.realpathSync(resolved);
    if (!real.startsWith(workspaceRealDir + path.sep)) return null;
    return { normalized, abs: resolved, real };
  } catch {
    return null;
  }
}

function validateNewExportRelPath(workspaceDir, rawPath) {
  const normalized = String(rawPath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/+/g, '/');
  if (!normalized || normalized.includes('\0')) return null;
  const parts = normalized.split('/');
  if (
    parts.some((p) => !p || p === '.' || p === '..' || p.startsWith('.') || p === 'node_modules')
  ) {
    return null;
  }
  if (!/\.html?$/iu.test(normalized)) return null;
  const resolved = path.resolve(workspaceDir, normalized);
  if (!resolved.startsWith(workspaceDir + path.sep)) return null;
  return { normalized, abs: resolved };
}

class WorkspaceGraphController {
  constructor(options = {}) {
    this.workspaceDir = path.resolve(options.workspaceDir);
    if (!fs.existsSync(this.workspaceDir) || !fs.statSync(this.workspaceDir).isDirectory()) {
      throw new Error(`Workspace directory does not exist: ${this.workspaceDir}`);
    }
    this.workspaceRealDir = fs.realpathSync(this.workspaceDir);

    this.storageMode = options.storageMode || 'vscode';
    this.preferObsidianTheme = !!options.preferObsidianTheme;
    this.mcpEnabledPref = options.mcpEnabled !== false;
    this.preferredMcpPort =
      options.mcpPort !== undefined && options.mcpPort !== null
        ? Number(options.mcpPort)
        : defaultVsCodeMcpPort(this.workspaceDir);
    this.version = options.version || '0.9.7';
    this.host = options.host || {};

    let stateDir = null;
    let isolated = false;
    let useObsidianConfig = false;
    let readOnly = false;
    if (this.storageMode === 'vscode') {
      stateDir = options.stateDir || path.join(this.workspaceDir, '.vscode', 'graphfrontier');
      isolated = true;
    } else if (this.storageMode === 'workspace') {
      stateDir = options.stateDir || path.join(this.workspaceDir, '.vscode', 'graphfrontier');
      isolated = true;
    } else if (this.storageMode === 'obsidian') {
      useObsidianConfig = true;
    } else if (this.storageMode === 'readOnly') {
      stateDir = options.stateDir || null;
      isolated = !!options.isolated;
      readOnly = true;
    } else {
      stateDir = options.stateDir || null;
      isolated = !!options.isolated;
    }

    this.stateStore = new StateStore({
      vaultDir: this.workspaceDir,
      readOnly,
      stateDir,
      useObsidianConfig,
      isolated,
    });

    this.currentIndex = indexVault(this.workspaceDir);
    this.activeEditorPath = '';
    this.panels = new Map();
    this.viewIdToPanel = new Map();
    this.pendingRpcCalls = new Map();
    this.callSeq = 0;

    this.mcpServer = null;
    this.mcpEnabled = false;
    this.mcpPort = 0;
    this.mcpSecret = '';
    this.mcpUrl = '';
    this.mcpError = '';
    this.mcpQueue = Promise.resolve();
    this.hasLiveGlobalState = false;
    this.disposed = false;
  }

  toWorkspaceRelPath(absOrRel) {
    if (!absOrRel) return '';
    const abs = path.isAbsolute(absOrRel) ? absOrRel : path.resolve(this.workspaceDir, absOrRel);
    const rel = path.relative(this.workspaceDir, abs).split(path.sep).join('/');
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return '';
    if (rel.split('/').some((part) => part.startsWith('.') || part === 'node_modules')) return '';
    return rel;
  }

  getSnapshotForPanel(panel) {
    const existingData = this.stateStore.getPluginData();
    const markdownCount = this.currentIndex.files.filter((f) =>
      f.path.toLowerCase().endsWith('.md')
    ).length;
    return {
      panelId: panel.panelId,
      bootMode: {
        kind: panel.kind,
        subgraphId: panel.subgraphId || null,
        layout: panel.layout || null,
        initialFile: panel.initialFile || this.activeEditorPath || '',
      },
      manifest: {
        ...this.stateStore.manifest,
        version: this.version,
      },
      vaultName: this.currentIndex.vaultName,
      vaultPath: this.workspaceDir,
      configDir: '.obsidian',
      readOnly: this.stateStore.readOnly,
      preferObsidianTheme: this.preferObsidianTheme,
      hasLiveGlobalState: this.hasLiveGlobalState,
      markdownCount,
      ...(existingData ? {} : { defaultHideOrphans: false }),
      localViewState: panel.kind === 'local' ? this.stateStore.readLocalViewState() : null,
      pluginData: existingData,
      pluginFiles: this.stateStore.getPluginFilesObject(),
      files: this.currentIndex.files,
      caches: this.currentIndex.caches,
      resolvedLinks: this.currentIndex.resolvedLinks,
      unresolvedLinks: this.currentIndex.unresolvedLinks,
      icons,
      bodyClasses: this.preferObsidianTheme ? this.currentIndex.bodyClasses : [],
      themeName: this.preferObsidianTheme ? this.currentIndex.themeName : 'vscode',
      vaultThemeCss: this.preferObsidianTheme ? this.currentIndex.vaultThemeCss : '',
      activeEditorPath: this.activeEditorPath,
    };
  }

  broadcast(message, exceptPanelId = null) {
    for (const panel of this.panels.values()) {
      if (exceptPanelId && panel.panelId === exceptPanelId) continue;
      try {
        panel.postMessage(message);
      } catch {
        // Disposing panel may fail postMessage silently.
      }
    }
  }

  attachPanel({
    panelId,
    kind = 'global',
    subgraphId = null,
    layout = null,
    initialFile = '',
    postMessage,
  }) {
    let readyResolve;
    let readyReject;
    const readyPromise = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const timer = setTimeout(() => {
      readyReject(new Error(`Timed out waiting for webview panel "${panelId}" to boot.`));
    }, PANEL_READY_TIMEOUT_MS);
    readyPromise.catch(() => {});

    const panel = {
      panelId,
      kind,
      subgraphId,
      layout,
      initialFile,
      postMessage,
      ready: false,
      lastViewState: null,
      readyPromise,
      readyResolve: (state) => {
        clearTimeout(timer);
        readyResolve(state);
      },
      readyReject: (err) => {
        clearTimeout(timer);
        readyReject(err);
      },
    };
    this.panels.set(panelId, panel);

    const onMessage = async (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'rpc-req') {
        const { reqId, action, payload } = msg;
        try {
          const result = await this.handlePanelRpc(panel, action, payload || {});
          panel.postMessage({ type: 'rpc-res', reqId, ok: true, result });
        } catch (error) {
          panel.postMessage({
            type: 'rpc-res',
            reqId,
            ok: false,
            error: error?.message || String(error),
          });
        }
        return;
      }
      if (msg.type === 'mcp-rpc-result') {
        this.handleMcpRpcResult(msg);
      }
    };

    const onDispose = () => {
      clearTimeout(timer);
      if (!panel.ready) {
        readyReject(new Error(`Webview panel "${panelId}" closed before ready.`));
      }
      this.panels.delete(panelId);
      for (const [viewId, pid] of this.viewIdToPanel.entries()) {
        if (pid === panelId) this.viewIdToPanel.delete(viewId);
      }
      for (const [callId, pending] of this.pendingRpcCalls.entries()) {
        if (pending.panelId === panelId) {
          pending.reject(new GraphApiError('VIEW_NOT_FOUND', 'Graph panel was closed.'));
          this.pendingRpcCalls.delete(callId);
        }
      }
    };

    return { panel, onMessage, onDispose, readyPromise };
  }

  async handlePanelRpc(panel, action, payload) {
    switch (action) {
      case 'get-snapshot':
        return this.getSnapshotForPanel(panel);

      case 'read-note': {
        const valid = validateVaultRelPath(this.workspaceDir, this.workspaceRealDir, payload.path);
        if (!valid) throw new Error('Invalid or forbidden workspace file path.');
        return { text: fs.readFileSync(valid.real, 'utf8') };
      }

      case 'read-notes-all': {
        const files = {};
        for (const f of this.currentIndex.files) {
          if (!f.path.toLowerCase().endsWith('.md')) continue;
          const valid = validateVaultRelPath(this.workspaceDir, this.workspaceRealDir, f.path);
          if (!valid) continue;
          try {
            files[f.path] = fs.readFileSync(valid.real, 'utf8');
          } catch {
            // Skip unreadable note.
          }
        }
        return { files };
      }

      case 'save-plugin-data': {
        if (panel.kind === 'local') {
          return { persisted: false, ignoredLocal: true };
        }
        this.hasLiveGlobalState = true;
        const res = this.stateStore.savePluginData(payload.data);
        this.broadcast(
          {
            type: 'state-sync',
            sourcePanelId: panel.panelId,
            pluginData: this.stateStore.getPluginData(),
          },
          panel.panelId
        );
        return res;
      }

      case 'adapter-op': {
        if (panel.kind === 'local') {
          return { persisted: false, ignoredLocal: true };
        }
        let res;
        if (payload.op === 'write')
          res = this.stateStore.adapterWrite(payload.path, payload.content);
        else if (payload.op === 'remove') res = this.stateStore.adapterRemove(payload.path);
        else if (payload.op === 'rename')
          res = this.stateStore.adapterRename(payload.from, payload.to);
        else if (payload.op === 'mkdir') res = this.stateStore.adapterMkdir(payload.path);
        else throw new Error(`Unsupported adapter op: ${payload.op}`);
        this.broadcast(
          {
            type: 'adapter-sync',
            sourcePanelId: panel.panelId,
            op: payload.op,
            path: payload.path,
            content: payload.content,
            from: payload.from,
            to: payload.to,
          },
          panel.panelId
        );
        return res;
      }

      case 'mcp-get':
        return this.getMcpStatus();

      case 'mcp-set':
        return this.setMcpEnabled(!!payload.enabled);

      case 'open-vault-file': {
        const valid = validateVaultRelPath(this.workspaceDir, this.workspaceRealDir, payload.path);
        if (!valid) throw new Error('Invalid workspace file path.');
        if (this.host.openFileInEditor) {
          await this.host.openFileInEditor(valid.abs, panel.panelId, valid.normalized);
        }
        return { opened: true, path: valid.normalized };
      }

      case 'open-external-url': {
        const url = String(payload.url || '').trim();
        if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) URLs are supported.');
        if (this.host.openExternalUrl) await this.host.openExternalUrl(url);
        return { opened: true };
      }

      case 'open-subgraph-panel': {
        if (!this.host.openSubgraphPanel) {
          throw new Error('Subgraph split panels are unavailable.');
        }
        const subgraphs = this.stateStore.getPluginData()?.subgraphs || [];
        const match = subgraphs.find((item) => item.id === payload.subgraphId);
        const child = await this.host.openSubgraphPanel({
          subgraphId: payload.subgraphId,
          layout:
            payload.layout || this.stateStore.getPluginData()?.active_layout_name || 'data.json',
          name: match?.name || 'Subgraph',
        });
        const viewState = await child.readyPromise;
        if (viewState?.viewId) {
          this.viewIdToPanel.set(viewState.viewId, child.panel.panelId);
        }
        return { opened: true, viewState };
      }

      case 'open-local-graph-panel': {
        if (!this.host.openLocalPanel) {
          throw new Error('Local graph panel is unavailable.');
        }
        await this.host.openLocalPanel({ path: String(payload.path || '') });
        return { opened: true };
      }

      case 'open-global-graph-panel': {
        if (!this.host.openGlobalPanel) {
          throw new Error('Global graph panel is unavailable.');
        }
        await this.host.openGlobalPanel();
        return { opened: true };
      }

      case 'save-local-view-state': {
        if (panel.kind !== 'local') return { persisted: false };
        return this.stateStore.writeLocalViewState(payload.state);
      }

      case 'save-exported-html': {
        const valid = validateNewExportRelPath(this.workspaceDir, payload.path);
        if (!valid) throw new Error('Use a non-hidden workspace-relative .html path.');
        if (this.stateStore.readOnly) {
          return { saved: false, readOnly: true, path: valid.normalized };
        }
        if (this.host.saveExportedHtml) {
          await this.host.saveExportedHtml({
            relPath: valid.normalized,
            absPath: valid.abs,
            html: String(payload.html || ''),
          });
        } else {
          fs.mkdirSync(path.dirname(valid.abs), { recursive: true });
          fs.writeFileSync(valid.abs, String(payload.html || ''), 'utf8');
        }
        return { saved: true, path: valid.normalized };
      }

      case 'panel-ready': {
        panel.ready = true;
        panel.lastViewState = payload.viewState || null;
        if (panel.kind === 'global') {
          this.hasLiveGlobalState = true;
        }
        if (panel.lastViewState?.viewId) {
          this.viewIdToPanel.set(panel.lastViewState.viewId, panel.panelId);
        }
        panel.readyResolve(panel.lastViewState);
        return { ok: true };
      }

      default:
        throw new Error(`Unknown RPC action: ${action}`);
    }
  }

  notifyActiveFileChanged(absOrRelPath, { force = false } = {}) {
    const rel = this.toWorkspaceRelPath(absOrRelPath);
    if (!rel || !rel.toLowerCase().endsWith('.md')) return false;
    if (!force && this.activeEditorPath === rel) return false;
    this.activeEditorPath = rel;
    this.broadcast({ type: 'active-file-changed', path: rel });
    return true;
  }

  triggerReindex() {
    const prevMtimes = new Map(this.currentIndex.files.map((f) => [f.path, f.mtime]));
    const nextIndex = indexVault(this.workspaceDir);
    const nextMtimes = new Map(nextIndex.files.map((f) => [f.path, f.mtime]));
    const changed = [];
    const removed = [];
    for (const [p, mtime] of nextMtimes.entries()) {
      if (prevMtimes.get(p) !== mtime) changed.push(p);
    }
    for (const p of prevMtimes.keys()) {
      if (!nextMtimes.has(p)) removed.push(p);
    }
    this.currentIndex = nextIndex;
    if (changed.length || removed.length) {
      this.broadcast({
        type: 'vault-update',
        files: nextIndex.files,
        caches: nextIndex.caches,
        resolvedLinks: nextIndex.resolvedLinks,
        unresolvedLinks: nextIndex.unresolvedLinks,
        changed,
        removed,
      });
    }
    return { changed, removed };
  }

  getGraphPanels() {
    return [...this.panels.values()].filter(
      (p) => p.ready && (p.kind === 'global' || p.kind === 'subgraph')
    );
  }

  getPrimaryGlobalPanel() {
    const ready = this.getGraphPanels();
    return ready.find((p) => p.kind === 'global') || ready[0] || null;
  }

  sendMcpRpcToPanel(panel, method, args, readOnly, signal) {
    if (this.disposed)
      return Promise.reject(new GraphApiError('API_CLOSED', 'Extension disposed.'));
    if (signal?.aborted)
      return Promise.reject(new GraphApiError('REQUEST_CANCELLED', 'Request cancelled.'));

    const callId = `mcp-${++this.callSeq}-${Date.now().toString(36)}`;
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        this.pendingRpcCalls.delete(callId);
      };
      const doneResolve = (val) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(val);
      };
      const doneReject = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      const onAbort = () => {
        try {
          panel.postMessage({ type: 'mcp-abort', callId });
        } catch {
          // Ignore closed webview.
        }
        doneReject(new GraphApiError('REQUEST_CANCELLED', 'Request cancelled.'));
      };
      const timer = setTimeout(() => {
        doneReject(new GraphApiError('TIMEOUT', 'Graph panel did not reply in time.'));
      }, RPC_TIMEOUT_MS);

      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      this.pendingRpcCalls.set(callId, {
        panelId: panel.panelId,
        resolve: doneResolve,
        reject: doneReject,
      });

      try {
        panel.postMessage({ type: 'mcp-rpc', callId, method, args, readOnly: !!readOnly });
      } catch {
        doneReject(new GraphApiError('VIEW_NOT_FOUND', 'Graph panel unavailable.'));
      }
    });
  }

  handleMcpRpcResult(msg) {
    const entry = this.pendingRpcCalls.get(msg?.callId);
    if (!entry) return false;
    if (msg.ok) entry.resolve(msg.result);
    else {
      const code = typeof msg.error?.code === 'string' ? msg.error.code : 'INTERNAL_ERROR';
      entry.reject(new GraphApiError(code, msg.error?.message || 'Graph operation failed.'));
    }
    return true;
  }

  async dispatchMcpTool(method, args = {}, readOnly = false, signal) {
    if (this.disposed) throw new GraphApiError('API_CLOSED', 'GraphFrontier is unloaded.');

    if (method === 'listViews') {
      const panels = this.getGraphPanels();
      const views = [];
      let sampleMeta = null;
      for (const panel of panels) {
        try {
          const res = await this.sendMcpRpcToPanel(panel, 'listViews', {}, true, signal);
          if (!sampleMeta && res) sampleMeta = res;
          for (const v of res?.views || []) {
            this.viewIdToPanel.set(v.viewId, panel.panelId);
            views.push(v);
          }
        } catch {
          // Skip transient closing panel.
        }
      }
      return {
        apiVersion: sampleMeta?.apiVersion || 1,
        pluginVersion: sampleMeta?.pluginVersion || this.version,
        vault: this.currentIndex.vaultName,
        views,
      };
    }

    if (method === 'subgraphNodes' && args?.action === 'open' && args?.viewId) {
      let parentPanel = this.panels.get(this.viewIdToPanel.get(args.viewId));
      if (!parentPanel) {
        await this.dispatchMcpTool('listViews', {}, true, signal);
        parentPanel = this.panels.get(this.viewIdToPanel.get(args.viewId));
      }
      if (!parentPanel)
        throw new GraphApiError('VIEW_NOT_FOUND', 'Open GraphFrontier in VS Code first.');
      // Validate token and membership on the parent panel via a dry check before opening split tab.
      const cfg = await this.sendMcpRpcToPanel(
        parentPanel,
        'getConfiguration',
        { viewId: args.viewId },
        true,
        signal
      );
      if (args.contextToken && cfg.contextToken !== args.contextToken) {
        throw new GraphApiError(
          'STATE_CHANGED',
          'The graph or layout changed. Read its state again.'
        );
      }
      const sub = (cfg.subgraphs || []).find((s) => s.id === args.id);
      if (!sub) throw new GraphApiError('NODE_NOT_FOUND', 'Subgraph not found');
      if (!this.host.openSubgraphPanel)
        throw new GraphApiError('UNAVAILABLE', 'Subgraph split tabs unavailable.');
      const child = await this.host.openSubgraphPanel({
        subgraphId: sub.id,
        layout: cfg.layout,
        name: sub.name,
      });
      const childViewState = await child.readyPromise;
      if (childViewState?.viewId) {
        this.viewIdToPanel.set(childViewState.viewId, child.panel.panelId);
      }
      const freshChildList = await this.sendMcpRpcToPanel(
        child.panel,
        'listViews',
        {},
        true,
        signal
      );
      const openedView = freshChildList?.views?.[0] || childViewState;
      if (openedView?.viewId) this.viewIdToPanel.set(openedView.viewId, child.panel.panelId);
      const parentState = await this.sendMcpRpcToPanel(
        parentPanel,
        'getState',
        { viewId: args.viewId },
        true,
        signal
      );
      return { ...parentState, openedView };
    }

    let targetPanel;
    if (args && typeof args.viewId === 'string') {
      targetPanel = this.panels.get(this.viewIdToPanel.get(args.viewId)) || null;
      if (!targetPanel) {
        await this.dispatchMcpTool('listViews', {}, true, signal);
        targetPanel = this.panels.get(this.viewIdToPanel.get(args.viewId)) || null;
      }
      if (!targetPanel) {
        throw new GraphApiError('VIEW_NOT_FOUND', 'Open the requested GraphFrontier view first.');
      }
    } else {
      targetPanel = this.getPrimaryGlobalPanel();
      if (!targetPanel) {
        throw new GraphApiError('VIEW_NOT_FOUND', 'Open GraphFrontier tab in VS Code first.');
      }
    }

    return this.sendMcpRpcToPanel(targetPanel, method, args, readOnly, signal);
  }

  persistMcpState(enabled) {
    const out = enabled
      ? { enabled: true, port: this.mcpPort, secret: this.mcpSecret, url: this.mcpUrl }
      : {
          enabled: false,
          ...(this.mcpPort ? { port: this.mcpPort } : {}),
          ...(this.mcpSecret ? { secret: this.mcpSecret } : {}),
        };
    this.stateStore.writeMcpState(out);
  }

  async startMcpServer() {
    await this.stopMcpServer();
    if (this.disposed) return;
    if (!SECRET_RE.test(this.mcpSecret)) {
      this.mcpSecret = nodeCrypto.randomBytes(32).toString('hex');
    }
    const api = {
      runTool: (method, args, readOnly, signal) =>
        this.dispatchMcpTool(method, args, readOnly, signal),
    };
    const srv = new GraphFrontierMcpServer(
      api,
      { port: this.mcpPort || this.preferredMcpPort, secret: this.mcpSecret },
      this.version
    );
    await srv.start();
    this.mcpServer = srv;
    this.mcpPort = srv.port;
    this.mcpUrl = srv.url;
    this.mcpEnabled = true;
    this.mcpError = '';
  }

  async stopMcpServer() {
    const srv = this.mcpServer;
    this.mcpServer = null;
    if (srv) await srv.stop().catch(() => {});
    for (const [callId, pending] of this.pendingRpcCalls.entries()) {
      pending.reject(new GraphApiError('API_CLOSED', 'MCP server stopped.'));
      this.pendingRpcCalls.delete(callId);
    }
  }

  async initMcp() {
    const stored = this.stateStore.readMcpState();
    const shouldStart = stored ? !!stored.enabled : this.mcpEnabledPref;
    if (stored) {
      if (SECRET_RE.test(stored.secret || '')) this.mcpSecret = stored.secret;
      if (this.preferredMcpPort !== 0 && Number.isInteger(stored.port) && stored.port > 0) {
        this.mcpPort = stored.port;
      } else {
        this.mcpPort = this.preferredMcpPort;
      }
    } else {
      this.mcpPort = this.preferredMcpPort;
    }
    if (!shouldStart) {
      this.mcpEnabled = false;
      this.mcpUrl = '';
      return this.getMcpStatus();
    }
    try {
      await this.startMcpServer();
      this.persistMcpState(true);
    } catch (error) {
      this.mcpEnabled = false;
      this.mcpUrl = '';
      this.mcpError = error?.message || 'Failed to start MCP server.';
    }
    return this.getMcpStatus();
  }

  setMcpEnabled(enabled) {
    const job = this.mcpQueue
      .catch(() => {})
      .then(async () => {
        if (this.disposed) throw new Error('Extension disposed.');
        if (!enabled) {
          this.mcpEnabled = false;
          this.mcpUrl = '';
          this.mcpError = '';
          await this.stopMcpServer();
          this.persistMcpState(false);
        } else {
          try {
            await this.startMcpServer();
            this.persistMcpState(true);
          } catch (error) {
            this.mcpEnabled = false;
            this.mcpUrl = '';
            this.mcpError = error?.message || 'Failed to start MCP server.';
          }
        }
        const status = this.getMcpStatus();
        this.broadcast({ type: 'mcp-state', ...status });
        return status;
      });
    this.mcpQueue = job.catch(() => {});
    return job;
  }

  getMcpStatus() {
    return {
      enabled: this.mcpEnabled,
      port: this.mcpPort,
      url: this.mcpUrl,
      error: this.mcpError,
    };
  }

  importObsidianSaves() {
    const res = this.stateStore.importFromObsidian();
    if (res.imported) {
      for (const [vpath, content] of Object.entries(this.stateStore.getPluginFilesObject())) {
        this.broadcast({
          type: 'adapter-sync',
          sourcePanelId: null,
          op: 'write',
          path: vpath,
          content,
        });
      }
      this.hasLiveGlobalState = false;
      this.broadcast({
        type: 'state-sync',
        sourcePanelId: null,
        pluginData: this.stateStore.getPluginData(),
      });
    }
    return res;
  }

  async dispose() {
    this.disposed = true;
    await this.stopMcpServer();
    this.panels.clear();
    this.viewIdToPanel.clear();
  }
}

module.exports = {
  WorkspaceGraphController,
  defaultVsCodeMcpPort,
  validateVaultRelPath,
};
