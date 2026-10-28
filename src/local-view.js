const { Notice } = require('obsidian');
const { GraphFrontierView } = require('./view');
const { LOCAL_GRAPHFRONTIER_VIEW_TYPE } = require('./constants');

const clone = (value) => JSON.parse(JSON.stringify(value));

// The view uses the ordinary plugin methods, but all mutable state and side effects
// belong to this leaf, not to the installed plugin or its named layouts.
function createLocalFacade(owner, leaf, initial) {
  const facade = Object.create(owner);
  facade.isLocalGraphFrontier = true;
  facade.data = owner.normalizeData(clone(initial || owner.data));
  facade.data.subgraphs = [];
  if (!initial) {
    facade.data.blacklist = [];
    facade.data.whitelist = [];
    facade.data.view_state.search_query = '';
    facade.data.view_state.node_filter = null;
    facade.data.view_state.camera_saved = false;
    facade.data.view_state.pan_x = 0;
    facade.data.view_state.pan_y = 0;
    facade.data.view_state.zoom = 1;
  }
  facade._persistRevision = 0;
  facade._persistTimer = null;
  facade._refreshTimer = null;
  facade._pendingRefreshOptions = {};
  facade._layoutFileOperation = null;
  facade.groupSuggestionIndex = null;
  facade.pendingSubgraphScopes = new WeakMap();
  facade._localDisposed = false;
  facade.schedulePersist = () => {
    facade._persistRevision += 1;
    owner.app.workspace.requestSaveLayout?.();
  };
  facade.persistPluginDataOnly = async () => facade.schedulePersist();
  facade.saveData = async () => facade.schedulePersist();
  facade.persistActiveLayoutFile = async () => false;
  facade.writeLayoutFileData = async () => false;
  facade.deleteLayoutFile = async () => ({ ok: false, reason: 'local-view' });
  facade.setActiveLayoutFile = async () => true;
  facade.getScopeView = () => (leaf.view?.plugin === facade ? leaf.view : null);
  facade.refreshAllViews = (options = {}) => facade.getScopeView()?.refreshFromVault(options);
  facade.scheduleRefreshAllViews = (options = {}) => {
    if (facade._localDisposed) return;
    facade._pendingRefreshOptions = { ...facade._pendingRefreshOptions, ...options };
    if (facade._refreshTimer) window.clearTimeout(facade._refreshTimer);
    facade._refreshTimer = window.setTimeout(() => {
      facade._refreshTimer = null;
      const next = facade._pendingRefreshOptions;
      facade._pendingRefreshOptions = {};
      if (!facade._localDisposed) facade.refreshAllViews({ keepCamera: true, ...next });
    }, 300);
  };
  facade.disposeLocalRefresh = () => {
    facade._localDisposed = true;
    if (facade._refreshTimer) window.clearTimeout(facade._refreshTimer);
    facade._refreshTimer = null;
    facade._pendingRefreshOptions = {};
  };
  facade.renderAllViews = () => facade.getScopeView()?.render();
  facade.recomputeOrbitRadiiAllViews = () => facade.getScopeView()?.recomputeOrbitRadii();
  facade.persistNodeVisualSettings = () => {
    const view = facade.getScopeView();
    if (view) {
      view.layoutEditVersion += 1;
      view.layoutAutosaveDirty = true;
      view.layoutStillFrames = 0;
    }
    facade.schedulePersist();
    facade.renderAllViews();
  };
  // A current note must remain present even if the global graph hides orphans.
  facade.collectGraphData = function () {
    const hideOrphans = this.data.settings.hide_orphans;
    this.data.settings.hide_orphans = false;
    try {
      return owner.collectGraphData.call(this);
    } finally {
      this.data.settings.hide_orphans = hideOrphans;
    }
  };
  return facade;
}

class LocalGraphFrontierView extends GraphFrontierView {
  constructor(leaf, owner) {
    const state = leaf.getViewState?.()?.state?.local || {};
    const facade = createLocalFacade(owner, leaf, state.data);
    super(leaf, facade);
    this.owner = owner;
    this.localLeaf = leaf;
    this.localPath = owner.pendingLocalFiles?.get(leaf) || state.path || '';
    this.localSaved = state.saved ? facade.normalizeData(clone(state.saved)) : null;
    this.subgraphScope = null;
    this.sidePanelOpen = false;
  }

  getViewType() {
    return LOCAL_GRAPHFRONTIER_VIEW_TYPE;
  }
  getDisplayText() {
    return 'Local GraphFrontier';
  }

  getState() {
    if (this.graphDataRef) {
      this.persistCameraState();
      this.captureGraphPositions(this.plugin.data);
      this.plugin.data.view_state.camera_saved = true;
      this.plugin.data.view_state.search_query = this.searchInputEl?.value || this.searchInputValue;
      this.plugin.data.view_state.node_filter =
        this.apiVisibleNodeIds instanceof Set ? [...this.apiVisibleNodeIds] : null;
    }
    return {
      local: { path: this.localPath, data: clone(this.plugin.data), saved: clone(this.localSaved) },
    };
  }

  async setState(state) {
    const local = state?.local;
    if (!local) return;
    if (local.data) {
      this.plugin.data = this.plugin.normalizeData(clone(local.data));
      this.plugin.data.subgraphs = [];
    }
    this.localSaved = local.saved ? this.plugin.normalizeData(clone(local.saved)) : null;
    const active = this.app.workspace.getActiveFile?.();
    this.localPath =
      active && String(active.extension || '').toLowerCase() === 'md'
        ? active.path
        : local.path || this.localPath;
    this.searchMode = this.plugin.data.settings.search_mode === 'filter' ? 'filter' : 'find';
    this.restoreLayoutViewState();
    if (this.isOpen) {
      this.refreshFromVault({ keepCamera: true, forceSavedPositions: true, skipLayoutKick: true });
      this.buildSidePanel();
    }
  }

  async onOpen() {
    this.plugin._localDisposed = false;
    const active = this.app.workspace.getActiveFile?.();
    if (active && String(active.extension || '').toLowerCase() === 'md')
      this.localPath = active.path;
    await super.onOpen();
  }

  async onClose() {
    this.plugin.disposeLocalRefresh();
    await super.onClose();
  }

  followFile(file) {
    if (
      !file ||
      String(file.extension || '').toLowerCase() !== 'md' ||
      file.path === this.localPath
    )
      return;
    if (this.isOpen) this.captureGraphPositions(this.plugin.data);
    this.localPath = file.path;
    this.searchSelectedNodeId = null;
    if (this.isOpen) this.refreshFromVault({ keepCamera: false });
    this.plugin.schedulePersist();
  }

  localGraphData(graph) {
    const center = this.localPath;
    if (!center || !graph.nodes.some((node) => node.id === center)) return { nodes: [], edges: [] };
    const ids = new Set([center]);
    for (const edge of graph.edges) {
      if (edge.source === center) ids.add(edge.target);
      if (edge.target === center) ids.add(edge.source);
    }
    return {
      nodes: graph.nodes.filter((node) => ids.has(node.id) && !node.meta?.subgraph),
      edges: graph.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)),
    };
  }

  async saveCurrentLayout(options = {}) {
    if (!options.allowSearch && this.isSearchFilled()) {
      if (!options.silent) new Notice('Clear search field to save');
      return false;
    }
    this.captureGraphPositions(this.plugin.data);
    this.persistCameraState();
    this.plugin.data.view_state.camera_saved = true;
    this.plugin.data.view_state.search_query = this.searchInputEl?.value || this.searchInputValue;
    this.plugin.data.view_state.node_filter =
      this.apiVisibleNodeIds instanceof Set ? [...this.apiVisibleNodeIds] : null;
    this.localSaved = clone(this.plugin.data);
    this.layoutAutosaveDirty = false;
    this.plugin.schedulePersist();
    if (!options.silent) new Notice('Local layout saved in workspace');
    return true;
  }

  async loadSavedLayout(options = {}) {
    if (!this.localSaved) {
      if (!options.silent) new Notice('No saved local layout');
      return false;
    }
    this.plugin.data = this.plugin.normalizeData(clone(this.localSaved));
    this.searchMode = this.plugin.data.settings.search_mode === 'filter' ? 'filter' : 'find';
    this.restoreLayoutViewState();
    if (this.isOpen) {
      this.refreshFromVault({ keepCamera: true, forceSavedPositions: true, skipLayoutKick: true });
      this.buildSidePanel();
    }
    this.layoutAutosaveDirty = false;
    this.plugin.schedulePersist();
    if (!options.silent) new Notice('Local layout loaded');
    return true;
  }

  // Named subgraph panes are global layout spaces and cannot share this facade.
  setSubgraph() {
    new Notice('Subgraphs are unavailable in local GraphFrontier');
  }
  async openSubgraphSeparately() {
    new Notice('Subgraphs are unavailable in local GraphFrontier');
  }
}

module.exports = { LocalGraphFrontierView, createLocalFacade };
