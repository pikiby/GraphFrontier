const { GRAPHFRONTIER_VIEW_TYPE } = require('./constants');
const { GraphFrontierActions } = require('./api-actions');
const { GraphApiError, fail } = require('./api-errors');

const MAX_PAGE = 500;
const MAX_SCAN = 10000;

function pageArgs(args) {
  const offset = args.offset ?? 0;
  const limit = args.limit ?? 100;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_PAGE
  ) {
    fail('INVALID_ARGUMENT', `Use an offset >= 0 and a limit from 1 to ${MAX_PAGE}.`);
  }
  return { offset, limit };
}

class GraphFrontierApi extends GraphFrontierActions {
  constructor(plugin) {
    super();
    this.plugin = plugin;
    this.ids = new WeakMap();
    this.nextId = 0;
    this.epoch = 0;
    this.data = null;
    this.closed = false;
    this.operation = Promise.resolve();
    this.pendingOperations = 0;
    this.instance = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  close() {
    this.closed = true;
  }

  async runTool(method, args, readOnly, signal) {
    const run = async () => {
      if (this.closed) fail('API_CLOSED', 'GraphFrontier is unloaded.');
      if (signal?.aborted) fail('REQUEST_CANCELLED', 'Request cancelled before execution.');
      if (!readOnly) this.mutationSignal = signal;
      try {
        return await this[method](args);
      } finally {
        if (!readOnly) this.mutationSignal = null;
      }
    };
    if (readOnly) return run();
    if (this.pendingOperations >= 16) fail('BUSY', 'Too many pending graph operations.');
    this.pendingOperations++;
    const pending = this.operation.then(run);
    this.operation = pending
      .catch(() => {})
      .finally(() => {
        this.pendingOperations--;
      });
    return pending;
  }

  views() {
    if (this.closed) fail('API_CLOSED', 'GraphFrontier is unloaded.');
    return this.plugin.app.workspace
      .getLeavesOfType(GRAPHFRONTIER_VIEW_TYPE)
      .map((leaf) => leaf.view)
      .filter((view) => view?.isOpen);
  }

  id(view) {
    if (!this.ids.has(view)) this.ids.set(view, `${this.instance}-${++this.nextId}`);
    return this.ids.get(view);
  }

  token(view) {
    if (this.data !== this.plugin.data) {
      this.data = this.plugin.data;
      this.epoch += 1;
    }
    return `${this.id(view)}:${this.epoch}:${view.visibilityGraphVersion}`;
  }

  resolve(args, requireToken = false) {
    if (requireToken) this.assertMutationActive();
    if (!args || typeof args.viewId !== 'string') fail('INVALID_ARGUMENT', 'viewId is required.');
    const view = this.views().find((item) => this.id(item) === args.viewId);
    if (!view) fail('VIEW_NOT_FOUND', 'Open the requested GraphFrontier view first.');
    if (requireToken && typeof args.contextToken !== 'string') {
      fail('INVALID_ARGUMENT', 'Use contextToken from get_state or list_views.');
    }
    if (args.contextToken !== undefined && args.contextToken !== this.token(view)) {
      fail('STATE_CHANGED', 'The graph or layout changed. Read its state again.');
    }
    return view;
  }

  state(view) {
    return {
      viewId: this.id(view),
      contextToken: this.token(view),
      layout: this.plugin.getActiveLayoutFileName(),
      nodeCount: view.nodes.length,
      edgeCount: view.edges.length,
      selectionCount: view.selectedNodeIds.size,
      camera: { x: view.camera.x, y: view.camera.y, zoom: view.camera.zoom },
    };
  }

  listViews() {
    return {
      apiVersion: 1,
      pluginVersion: this.plugin.manifest.version,
      vault: this.plugin.app.vault.getName?.() || '',
      views: this.views().map((view) => this.state(view)),
    };
  }

  getState(args) {
    return this.state(this.resolve(args));
  }

  getSelection(args) {
    const view = this.resolve(args);
    const { offset, limit } = pageArgs(args);
    const nodeIds = [];
    let index = 0;
    for (const id of view.selectedNodeIds) {
      if (index++ < offset) continue;
      if (nodeIds.length === limit) break;
      nodeIds.push(id);
    }
    return {
      ...this.state(view),
      nodeIds,
      nextOffset:
        offset + nodeIds.length < view.selectedNodeIds.size ? offset + nodeIds.length : null,
      searchSelectedNodeId: view.searchSelectedNodeId || null,
      focusNodeId: view.focusNodeId || null,
    };
  }

  getGraph(args) {
    const view = this.resolve(args);
    const { offset, limit } = pageArgs(args);
    const kind = args.kind ?? 'nodes';
    if (
      !['nodes', 'edges'].includes(kind) ||
      (args.visibleOnly !== undefined && typeof args.visibleOnly !== 'boolean')
    ) {
      fail('INVALID_ARGUMENT', 'Use kind nodes/edges and a boolean visibleOnly.');
    }
    const visible = view.getFilterVisibleNodeIds();
    const isVisible = (id) => visible === null || visible.has(id);
    const items = view[kind];
    const result = [];
    let index = offset;
    const end = Math.min(items.length, offset + MAX_SCAN);
    // Page by source offset, bounding both returned data and work on filtered graphs.
    while (index < end && result.length < limit) {
      const item = items[index++];
      const shown =
        kind === 'nodes' ? isVisible(item.id) : isVisible(item.source) && isVisible(item.target);
      if (args.visibleOnly !== false && !shown) continue;
      if (kind === 'edges')
        result.push({ source: item.source, target: item.target, visible: shown });
      else
        result.push({
          id: item.id,
          label: item.label || item.id,
          type: item.meta?.darkEnergy ? 'gravity' : item.meta?.isAttachment ? 'attachment' : 'note',
          x: item.x,
          y: item.y,
          visible: shown,
          pinned: !!(this.plugin.getPin(item.id) || this.plugin.getOrbitPin(item.id)),
        });
    }
    return {
      ...this.state(view),
      kind,
      items: result,
      nextOffset: index < items.length ? index : null,
    };
  }

  chosenNodes(args, allowEmpty) {
    const view = this.resolve(args, true);
    if (
      !Array.isArray(args.nodeIds) ||
      args.nodeIds.length > MAX_PAGE ||
      (!allowEmpty && args.nodeIds.length === 0) ||
      args.nodeIds.some((id) => typeof id !== 'string' || !id || id.length > 4096)
    ) {
      fail('INVALID_ARGUMENT', `nodeIds must contain ${allowEmpty ? 0 : 1}-${MAX_PAGE} node IDs.`);
    }
    const visible = view.getFilterVisibleNodeIds();
    const nodes = [...new Set(args.nodeIds)].map((id) => {
      const node = view.nodeById.get(id);
      if (!node) fail('NODE_NOT_FOUND', `Unknown node: ${id}`);
      if (visible !== null && !visible.has(id)) fail('NODE_NOT_VISIBLE', `Filtered node: ${id}`);
      return node;
    });
    return { view, nodes };
  }

  selectNodes(args) {
    const { view, nodes } = this.chosenNodes(args, true);
    view.setNodeSelection(nodes.map((node) => node.id));
    return this.getSelection({ viewId: this.id(view) });
  }

  frameNodes(args) {
    const { view, nodes } = this.chosenNodes(args, false);
    view.fitCameraToNodes(nodes);
    view.render();
    return this.state(view);
  }
}

module.exports = { GraphFrontierApi, GraphApiError, MAX_PAGE };
