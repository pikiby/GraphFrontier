const { BackupManager } = require('./backups');
const { observeNodeLists } = require('./appearance-events');
const { normalizeLayoutSleep } = require('./physics');
const {
  RENDER_MODEL,
  prepareRenderModel,
  normalizeLegacyRenderSettings,
  applyEdgeDprMigration,
} = require('./render-migration');
const { Plugin, Notice, parseLinktext } = require('obsidian');
const { normalizeDarkEnergy, darkEnergyNodes } = require('./dark-energy');
const { normalizeSubgraphs, subgraphNodes, normalizeSubgraphSpaces } = require('./subgraphs');
const {
  NODE_VISUAL_SETTINGS,
  getNodeGroupVisuals,
  normalizeNodeVisuals,
  normalizeGroupVisuals,
} = require('./node-visuals');
const { NodeListStore } = require('./node-lists');
const { getGroupStyleMap } = require('./render');
const EMPTY_NODE_LISTS = [];
const { GraphFrontierApi } = require('./api');
const { McpController, GraphFrontierMcpSettingTab } = require('./mcp-settings');

const {
  GRAPHFRONTIER_VIEW_TYPE,
  LOCAL_GRAPHFRONTIER_VIEW_TYPE,
  NODE_MULTIPLIER_MIN,
  NODE_MULTIPLIER_MAX,
  ZOOM_STEP_FACTOR,
  DEFAULT_DATA,
  SETTINGS_TABS,
  LEGACY_SETTINGS_TABS,
  normalizeAttachmentExtensions,
  MIN_ZOOM,
  MAX_ZOOM,
  HOTKEY_COMMANDS,
  HOTKEY_COMMAND_IDS,
  HOTKEY_MODIFIER_KEYS,
  HOTKEY_KEY_ALIASES,
} = require('./constants');

const { GraphFrontierView } = require('./view');
const { LocalGraphFrontierView } = require('./local-view');

// Register all Command Palette / hotkey actions in one place to keep plugin boot logic compact.
function registerGraphFrontierCommands(plugin) {
  plugin.addCommand({
    id: 'graphfrontier-open-view',
    name: 'Open GraphFrontier',
    callback: () => plugin.openOrRevealGraphFrontierView(),
  });

  plugin.addCommand({
    id: 'graphfrontier-open-local-view',
    name: 'Open local GraphFrontier',
    callback: () => plugin.openLocalGraphFrontierView(),
  });

  // Cursor-targeted actions: resolve active GraphFrontier view first, then run the matching handler.
  const viewActions = [
    {
      id: 'graphfrontier-toggle-pin-under-cursor',
      name: 'Toggle pin under cursor',
      method: 'togglePinUnderCursor',
    },
    {
      id: 'graphfrontier-set-force-multiplier-under-cursor',
      name: 'Set force multiplier under cursor',
      method: 'promptSetMultiplierUnderCursor',
    },
    {
      id: 'graphfrontier-clear-force-multiplier-under-cursor',
      name: 'Clear force multiplier under cursor',
      method: 'clearMultiplierUnderCursor',
    },
    {
      id: 'graphfrontier-align-pins-to-grid',
      name: 'Align pins to grid',
      method: 'alignPinsToGrid',
    },
    {
      id: 'graphfrontier-pin-node-under-cursor',
      name: 'Pin node under cursor',
      method: 'commandPinNode',
    },
    {
      id: 'graphfrontier-pin-to-grid-under-cursor',
      name: 'Pin node to grid under cursor',
      method: 'commandPinToGrid',
    },
    {
      id: 'graphfrontier-unpin-node-under-cursor',
      name: 'Unpin node under cursor',
      method: 'commandUnpinNode',
    },
    {
      id: 'graphfrontier-pin-linked-to-orbit-under-cursor',
      name: 'Pin linked to orbit under cursor',
      method: 'commandPinLinkedToOrbit',
    },
    {
      id: 'graphfrontier-toggle-selection-under-cursor',
      name: 'Toggle selection under cursor',
      method: 'commandToggleSelectionUnderCursor',
    },
    {
      id: 'graphfrontier-arm-box-selection',
      name: 'Arm box selection',
      method: 'commandArmBoxSelection',
    },
    {
      id: 'graphfrontier-clear-selection',
      name: 'Clear selection',
      method: 'commandClearSelection',
    },
    {
      id: 'graphfrontier-export-static-html',
      name: 'Export static graph to HTML',
      method: 'commandExportStaticHtml',
    },
    {
      id: 'graphfrontier-unpin-linked-nodes-under-cursor',
      name: 'Unpin linked nodes under cursor',
      method: 'commandUnpinLinkedNodes',
    },
    {
      id: 'graphfrontier-add-to-search-under-cursor',
      name: 'Add to search under cursor',
      method: 'commandAddToSearch',
    },
    {
      id: 'graphfrontier-show-local-graph-under-cursor',
      name: 'Show local graph under cursor',
      method: 'commandShowLocalGraph',
    },
    {
      id: 'graphfrontier-pin-linked-nodes-under-cursor',
      name: 'Pin linked nodes under cursor',
      method: 'commandPinLinkedNodes',
    },
    {
      id: 'graphfrontier-pin-linked-nodes-to-grid-under-cursor',
      name: 'Pin linked nodes to grid under cursor',
      method: 'commandPinLinkedNodesToGrid',
    },
    {
      id: 'graphfrontier-paint-edges-under-cursor',
      name: 'Paint links under cursor',
      method: 'commandPaintEdges',
    },
    {
      id: 'graphfrontier-clear-painted-edges-under-cursor',
      name: 'Clear painted links under cursor',
      method: 'commandClearPaintedEdges',
    },
    {
      id: 'graphfrontier-strong-pull-under-cursor',
      name: 'Strong pull under cursor',
      method: 'commandStrongPull',
    },
    {
      id: 'graphfrontier-clear-strong-pull-under-cursor',
      name: 'Clear strong pull under cursor',
      method: 'commandClearStrongPull',
    },
    { id: 'graphfrontier-save-layout', name: 'Save layout', method: 'saveCurrentLayout' },
    { id: 'graphfrontier-load-layout', name: 'Load layout', method: 'loadSavedLayout' },
    { id: 'graphfrontier-pin-all', name: 'Pin all nodes', method: 'commandPinAllNodes' },
    { id: 'graphfrontier-unpin-all', name: 'Unpin all nodes', method: 'commandUnpinAllNodes' },
  ];

  for (const action of viewActions) {
    plugin.addCommand({
      id: action.id,
      name: action.name,
      callback: async () => {
        const view = plugin.getActiveGraphFrontierView();
        if (!view) {
          new Notice('Open GraphFrontier view');
          return;
        }
        const handler = view[action.method];
        if (typeof handler !== 'function') return;
        if (
          /^command(?:Pin|Unpin)/.test(action.method) ||
          ['togglePinUnderCursor', 'alignPinsToGrid'].includes(action.method)
        )
          await view.runPositionAction(
            view.nodes.map((node) => node.id),
            () => handler.call(view)
          );
        else await handler.call(view);
      },
    });
  }
}

// Register all data/layout change listeners that trigger a graph refresh.
function registerGraphFrontierRefreshEvents(plugin) {
  const shouldIgnoreVaultEvent = (file) => {
    const filePath = String(file?.path || '');
    if (!filePath) return false;
    const configDir = String(plugin.app?.vault?.configDir || '.obsidian').replace(/\/+$/u, '');
    const pluginId = String(plugin.manifest?.id || 'graphfrontier').trim() || 'graphfrontier';
    return (
      filePath === `${configDir}/plugins/${pluginId}` ||
      filePath.startsWith(`${configDir}/plugins/${pluginId}/`)
    );
  };
  const scheduleRefreshForVaultEvent = (file) => {
    if (shouldIgnoreVaultEvent(file)) return;
    plugin.scheduleRefreshAllViews({ passive: true });
  };

  plugin.registerEvent(plugin.app.vault.on('create', scheduleRefreshForVaultEvent));
  plugin.registerEvent(plugin.app.vault.on('modify', scheduleRefreshForVaultEvent));
  plugin.registerEvent(plugin.app.vault.on('delete', scheduleRefreshForVaultEvent));
  plugin.registerEvent(
    plugin.app.vault.on('rename', (file, oldPath) => {
      plugin.nodeListStore
        ?.renamePath(oldPath, file.path)
        .catch((error) => new Notice(error.message));
      for (const leaf of plugin.app.workspace.getLeavesOfType(LOCAL_GRAPHFRONTIER_VIEW_TYPE)) {
        if (leaf.view?.localPath === oldPath) leaf.view.followFile(file);
      }
      scheduleRefreshForVaultEvent(file);
    })
  );
}

// Convert any keyboard key string into one canonical non-modifier token.
function normalizeHotkeyKeyUtil(rawKey) {
  const rawText = String(rawKey || '').trim();
  if (!rawText) return '';
  const loweredKey = rawText.toLowerCase();
  if (HOTKEY_MODIFIER_KEYS.has(loweredKey)) return '';
  if (HOTKEY_KEY_ALIASES[loweredKey]) return HOTKEY_KEY_ALIASES[loweredKey];
  if (/^f([1-9]|1[0-2])$/i.test(rawText)) return rawText.toUpperCase();
  if (rawText.length === 1) return rawText.toUpperCase();
  return `${rawText.charAt(0).toUpperCase()}${rawText.slice(1).toLowerCase()}`;
}

// Normalize a full hotkey expression like "Ctrl+Alt+K" into stable order and naming.
function normalizeHotkeyTextUtil(rawHotkey) {
  const hotkeyText = String(rawHotkey || '').trim();
  if (!hotkeyText) return '';
  const parts = hotkeyText
    .split('+')
    .map((part) => String(part || '').trim())
    .filter(Boolean);
  if (parts.length === 0) return '';

  let hasMod = false;
  let hasAlt = false;
  let hasShift = false;
  let hotkeyKey = '';

  for (const rawPart of parts) {
    const part = rawPart.toLowerCase();
    if (
      part === 'mod' ||
      part === 'cmd' ||
      part === 'command' ||
      part === 'ctrl' ||
      part === 'control' ||
      part === 'meta'
    ) {
      hasMod = true;
      continue;
    }
    if (part === 'alt' || part === 'option') {
      hasAlt = true;
      continue;
    }
    if (part === 'shift') {
      hasShift = true;
      continue;
    }
    if (hotkeyKey) return '';
    hotkeyKey = normalizeHotkeyKeyUtil(rawPart);
  }

  if (!hotkeyKey) return '';
  const normalizedParts = [];
  if (hasMod) normalizedParts.push('Mod');
  if (hasAlt) normalizedParts.push('Alt');
  if (hasShift) normalizedParts.push('Shift');
  normalizedParts.push(hotkeyKey);
  return normalizedParts.join('+');
}

// Build a normalized hotkey text directly from a KeyboardEvent.
function getHotkeyFromKeyboardEventUtil(keyboardEvent) {
  if (!keyboardEvent || keyboardEvent.repeat) return '';
  const hotkeyKey = normalizeHotkeyKeyUtil(keyboardEvent.key);
  if (!hotkeyKey) return '';
  const hotkeyParts = [];
  if (keyboardEvent.ctrlKey || keyboardEvent.metaKey) hotkeyParts.push('Mod');
  if (keyboardEvent.altKey) hotkeyParts.push('Alt');
  if (keyboardEvent.shiftKey) hotkeyParts.push('Shift');
  hotkeyParts.push(hotkeyKey);
  return normalizeHotkeyTextUtil(hotkeyParts.join('+'));
}

// ============================================================================
// Plugin core: data load, command registration, persistence, and graph data collection.
// ============================================================================
module.exports = class GraphFrontierPlugin extends Plugin {
  async onload() {
    this.metadataResolvedOnce = false;
    this.metadataResolutionPending = false;
    this._graphRefreshReady = false;
    this._persistTimer = null;
    this._refreshTimer = null;
    this._pendingRefreshOptions = {};
    // Subscribe before disk/MCP awaits, so the initial resolution cannot be missed.
    this.registerEvent(
      this.app.metadataCache.on('changed', () => {
        this.metadataResolutionPending = true;
      })
    );
    this.registerEvent(
      this.app.metadataCache.on('resolved', () => {
        this.metadataResolvedOnce = true;
        this.metadataResolutionPending = false;
        if (this._graphRefreshReady)
          this.scheduleRefreshAllViews({ metadataResolved: true, passive: true });
      })
    );
    const loadedData = await this.loadData();
    this.data = this.normalizeData(loadedData);
    await this.bootstrapActiveLayoutData();
    this.nodeListStore = new NodeListStore(
      this.app.vault.adapter,
      `${this.app.vault.configDir}/plugins/${this.manifest.id}/node-lists.json`,
      () => this.nodeListsChanged()
    );
    try {
      await this.nodeListStore.load();
    } catch (error) {
      new Notice(`GraphFrontier node lists: ${error.message}`);
    }

    // UI entry point: ribbon icon opens GraphFrontier view.
    this.addRibbonIcon('orbit', 'Open GraphFrontier', () => this.openOrRevealGraphFrontierView());

    // Register plugin commands for Command Palette and custom hotkeys.
    registerGraphFrontierCommands(this);

    // Register custom view type that renders the graph.
    this.registerView(GRAPHFRONTIER_VIEW_TYPE, (leaf) => new GraphFrontierView(leaf, this));
    this.registerView(
      LOCAL_GRAPHFRONTIER_VIEW_TYPE,
      (leaf) => new LocalGraphFrontierView(leaf, this)
    );
    this.registerEvent(
      this.app.workspace.on('file-open', (file) => this.followLocalGraphFile(file))
    );
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf) =>
        this.followLocalGraphFile(leaf?.view?.file)
      )
    );

    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file, source, leaf) => {
        if (
          !leaf ||
          source === 'graphfrontier' ||
          source === 'sidebar-context-menu' ||
          String(file?.extension || '').toLowerCase() !== 'md'
        )
          return;
        menu.addItem((item) =>
          item
            .setSection('view.linked')
            .setTitle('Open local GraphFrontier')
            .setIcon('dot-network')
            .onClick(() => this.openLocalGraphFrontierView(file))
        );
      })
    );

    // Subscribe to vault/workspace changes and refresh all open GraphFrontier views.
    registerGraphFrontierRefreshEvents(this);
    this.api = new GraphFrontierApi(this);
    this.mcp = new McpController(this);
    await this.mcp.load();
    this.addSettingTab(new GraphFrontierMcpSettingTab(this.app, this));
    if (this.mcp.error) new Notice(this.mcp.error);
    this.backups = new BackupManager(this, loadedData?.backups);
    this.app.workspace.onLayoutReady(() => {
      void this.backups
        .initialize()
        .then(async () => {
          await this.persistPluginDataOnly();
        })
        .catch((error) => new Notice(error.message));
    });
    this._graphRefreshReady = true;
    if (this.metadataResolvedOnce && !this.metadataResolutionPending)
      this.scheduleRefreshAllViews({ metadataResolved: true, passive: true });
  }

  onunload() {
    this.backups?.dispose();
    this.api?.close();
    void this.mcp?.stop();
    if (this._persistTimer) window.clearTimeout(this._persistTimer);
    if (this._refreshTimer) window.clearTimeout(this._refreshTimer);
    this._pendingRefreshOptions = {};
  }

  isGraphMetadataReady() {
    if (this.metadataResolutionPending) return false;
    if (this.metadataResolvedOnce) return true;
    if (!this.app.workspace.layoutReady) return false;
    // Hot enabling may miss `resolved`. Check the public indexed links against
    // the resolved graph; linkless notes need no entries in either link map.
    const cache = this.app.metadataCache;
    return this.app.vault.getMarkdownFiles().every((file) => {
      const indexed = cache.getFileCache(file);
      if (!indexed) return false;
      const expected = new Map();
      for (const link of [
        ...(indexed.links || []),
        ...(indexed.embeds || []),
        ...(indexed.frontmatterLinks || []),
      ]) {
        const target = cache.getFirstLinkpathDest(parseLinktext(link.link).path, file.path);
        if (target) expected.set(target.path, (expected.get(target.path) || 0) + 1);
      }
      const resolved = Object.entries(cache.resolvedLinks?.[file.path] || {});
      return (
        resolved.length === expected.size &&
        resolved.every(([id, count]) => expected.get(id) === count)
      );
    });
  }

  // Persisted-data normalization: sanitize and repair loaded state before use.
  normalizeData(data) {
    const safe = prepareRenderModel(data && typeof data === 'object' ? data : {});
    const activeLayoutName = this.normalizeLayoutFileName(safe.active_layout_name);

    const pins = safe.pins && typeof safe.pins === 'object' ? safe.pins : {};
    const orbitPins = safe.orbit_pins && typeof safe.orbit_pins === 'object' ? safe.orbit_pins : {};
    const savedPositions =
      safe.saved_positions && typeof safe.saved_positions === 'object' ? safe.saved_positions : {};
    const savedLayoutSettings =
      safe.saved_layout_settings && typeof safe.saved_layout_settings === 'object'
        ? safe.saved_layout_settings
        : {};
    const savedLayoutPins =
      safe.saved_layout_pins && typeof safe.saved_layout_pins === 'object'
        ? safe.saved_layout_pins
        : {};
    const savedLayoutOrbitPins =
      safe.saved_layout_orbit_pins && typeof safe.saved_layout_orbit_pins === 'object'
        ? safe.saved_layout_orbit_pins
        : {};
    const multipliers =
      safe.node_force_multipliers && typeof safe.node_force_multipliers === 'object'
        ? safe.node_force_multipliers
        : {};
    const strongPullNodes =
      safe.strong_pull_nodes && typeof safe.strong_pull_nodes === 'object'
        ? safe.strong_pull_nodes
        : {};
    const paintedEdgeColors =
      safe.painted_edge_colors && typeof safe.painted_edge_colors === 'object'
        ? safe.painted_edge_colors
        : {};
    const rawGroups = Array.isArray(safe.groups) ? safe.groups : [];
    const rawBlacklist = Array.isArray(safe.blacklist) ? safe.blacklist : [];
    const rawWhitelist = Array.isArray(safe.whitelist) ? safe.whitelist : [];
    const rawHotkeys = safe.hotkeys && typeof safe.hotkeys === 'object' ? safe.hotkeys : {};
    const settings = safe.settings && typeof safe.settings === 'object' ? safe.settings : {};
    const viewState = safe.view_state && typeof safe.view_state === 'object' ? safe.view_state : {};

    const normalized = {
      active_layout_name: activeLayoutName,
      pins: {},
      orbit_pins: {},
      saved_positions: {},
      saved_layout_sleep: normalizeLayoutSleep(safe.saved_layout_sleep),
      saved_layout_settings: {},
      saved_layout_pins: {},
      saved_layout_orbit_pins: {},
      node_force_multipliers: {},
      strong_pull_nodes: {},
      painted_edge_colors: {},
      node_label_sizes: {},
      node_visual_settings: normalizeNodeVisuals(safe.node_visual_settings),
      groups: [],
      dark_energy: normalizeDarkEnergy(safe.dark_energy, (query) => this.parseGroupQuery(query)),
      subgraphs: normalizeSubgraphs(safe.subgraphs),
      subgraph_cameras: {},
      subgraph_filters: {},
      blacklist: [],
      whitelist: [],
      hotkeys: {},
      settings: Object.assign({}, DEFAULT_DATA.settings, settings),
      view_state: Object.assign({}, DEFAULT_DATA.view_state, viewState),
    };

    for (const group of normalized.subgraphs) {
      const filter = safe.subgraph_filters?.[group.id];
      if (filter && typeof filter === 'object') {
        normalized.subgraph_filters[group.id] = {
          query:
            typeof filter.query === 'string' && this.parseGroupQuery(filter.query)
              ? filter.query.slice(0, 4096)
              : 'name:',
          mode: filter.mode === 'filter' ? 'filter' : 'find',
          node_filter: Array.isArray(filter.node_filter)
            ? [
                ...new Set(
                  filter.node_filter.filter((id) => typeof id === 'string' && id.length <= 4096)
                ),
              ]
            : null,
        };
      }
      const camera = safe.subgraph_cameras?.[group.id];
      if (camera && [camera.x, camera.y, camera.zoom].every(Number.isFinite)) {
        normalized.subgraph_cameras[group.id] = {
          x: camera.x,
          y: camera.y,
          zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, camera.zoom)),
        };
      }
    }

    for (const [nodeId, size] of Object.entries(safe.node_label_sizes || {})) {
      if (typeof size !== 'number' || !Number.isFinite(size)) continue;
      normalized.node_label_sizes[nodeId] = this.clampNumber(size, 5, 20, 9);
    }
    for (const [nodeId, position] of Object.entries(pins)) {
      if (!position || typeof position !== 'object') continue;
      const x = Number(position.x);
      const y = Number(position.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const mode = position.mode === 'grid' ? 'grid' : 'exact';
      normalized.pins[nodeId] = { x, y, mode };
    }
    for (const [nodeId, orbitMeta] of Object.entries(orbitPins)) {
      if (!orbitMeta || typeof orbitMeta !== 'object') continue;
      const anchorId = String(orbitMeta.anchor_id || '').trim();
      const radius = Number(orbitMeta.radius);
      const angle = Number(orbitMeta.angle);
      if (!anchorId || anchorId === nodeId) continue;
      if (!Number.isFinite(radius) || radius <= 0) continue;
      if (!Number.isFinite(angle)) continue;
      normalized.orbit_pins[nodeId] = {
        anchor_id: anchorId,
        radius,
        angle,
      };
      delete normalized.pins[nodeId];
    }
    for (const [nodeId, position] of Object.entries(savedPositions)) {
      if (!position || typeof position !== 'object') continue;
      const x = Number(position.x);
      const y = Number(position.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      normalized.saved_positions[nodeId] = { x, y };
    }
    normalized.saved_layout_settings = Object.assign({}, savedLayoutSettings);
    // Drop obsolete attachment controls from both live and rollback settings, without migration.
    for (const key of [
      'attachment_size_multiplier',
      'attachment_link_distance_multiplier',
      'attachments_on_orbits',
    ]) {
      delete normalized.settings[key];
      delete normalized.saved_layout_settings[key];
    }
    for (const [nodeId, position] of Object.entries(savedLayoutPins)) {
      if (!position || typeof position !== 'object') continue;
      const x = Number(position.x);
      const y = Number(position.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const mode = position.mode === 'grid' ? 'grid' : 'exact';
      normalized.saved_layout_pins[nodeId] = { x, y, mode };
    }
    for (const [nodeId, orbitMeta] of Object.entries(savedLayoutOrbitPins)) {
      if (!orbitMeta || typeof orbitMeta !== 'object') continue;
      const anchorId = String(orbitMeta.anchor_id || '').trim();
      const radius = Number(orbitMeta.radius);
      const angle = Number(orbitMeta.angle);
      if (!anchorId || anchorId === nodeId) continue;
      if (!Number.isFinite(radius) || radius <= 0) continue;
      if (!Number.isFinite(angle)) continue;
      normalized.saved_layout_orbit_pins[nodeId] = {
        anchor_id: anchorId,
        radius,
        angle,
      };
      delete normalized.saved_layout_pins[nodeId];
    }

    normalized.settings.grid_step = this.clampGridStep(normalized.settings.grid_step);
    normalized.settings.grid_line_width = this.clampGridLineWidth(
      normalized.settings.grid_line_width
    );
    // Backward compatibility: old link strength stored as tiny float (e.g. 0.001 -> new scale 40).
    if (Number(normalized.settings.base_link_strength) < 1) {
      normalized.settings.base_link_strength =
        Number(normalized.settings.base_link_strength) / 0.000025;
    }
    normalized.settings.base_link_strength = this.clampNumber(
      normalized.settings.base_link_strength,
      1,
      100,
      DEFAULT_DATA.settings.base_link_strength
    );
    normalized.settings.link_distance = this.clampNumber(
      normalized.settings.link_distance,
      1,
      50,
      DEFAULT_DATA.settings.link_distance
    );
    normalized.settings.repel_strength = this.clampNumber(
      normalized.settings.repel_strength,
      0,
      200,
      DEFAULT_DATA.settings.repel_strength
    );
    normalized.settings.repel_radius = this.clampNumber(
      normalized.settings.repel_radius,
      20,
      1000,
      DEFAULT_DATA.settings.repel_radius
    );
    // Backward compatibility: old center strength (e.g. 0.0001 -> new scale 10).
    if (Number(normalized.settings.center_strength) < 1) {
      normalized.settings.center_strength = Number(normalized.settings.center_strength) / 0.00001;
    }
    normalized.settings.center_strength = this.clampNumber(
      normalized.settings.center_strength,
      1,
      100,
      DEFAULT_DATA.settings.center_strength
    );
    normalized.settings.damping = this.clampNumber(
      normalized.settings.damping,
      0.01,
      0.9,
      DEFAULT_DATA.settings.damping
    );
    normalized.settings.node_size_scale = this.clampNumber(
      normalized.settings.node_size_scale,
      0.1,
      2,
      DEFAULT_DATA.settings.node_size_scale
    );
    if (!/^#[0-9a-f]{6}$/i.test(normalized.settings.node_color))
      normalized.settings.node_color = DEFAULT_DATA.settings.node_color;
    for (const settings of [normalized.settings, normalized.saved_layout_settings]) {
      for (const key of ['background_color', 'grid_color'])
        settings[key] = /^#[0-9a-f]{6}$/i.test(settings[key]) ? settings[key].toLowerCase() : null;
      for (const key of [
        'dim_low_degree_nodes',
        'custom_background',
        'show_arrows',
        'reverse_arrows',
      ])
        settings[key] = settings[key] === true;
      settings.grid_opacity =
        typeof settings.grid_opacity === 'number' && Number.isFinite(settings.grid_opacity)
          ? Math.max(0, Math.min(1, settings.grid_opacity))
          : null;
      settings.grid_line_width = this.clampGridLineWidth(settings.grid_line_width);
      settings.strong_pull_multiplier = this.clampStrongPullMultiplier(
        settings.strong_pull_multiplier
      );
      if (!/^#[0-9a-f]{6}$/i.test(settings.attachment_node_color))
        settings.attachment_node_color = null;
      settings.edge_color = /^#[0-9a-f]{6}$/i.test(settings.edge_color)
        ? settings.edge_color.toLowerCase()
        : null;
      settings.hover_highlight_color = /^#[0-9a-f]{6}$/i.test(settings.hover_highlight_color)
        ? settings.hover_highlight_color.toLowerCase()
        : null;
      settings.group_hide_mode = settings.group_hide_mode === 'hide' ? 'hide' : 'exclude';
    }
    normalized.settings.aura_brightness = this.clampNumber(
      normalized.settings.aura_brightness,
      0,
      50,
      22
    );
    normalized.settings.aura_radius = this.clampNumber(normalized.settings.aura_radius, 0, 5000, 0);
    // Edge widths are physical pixels (0.1-5); older stored values keep their number.
    normalized.settings.edge_width_scale = this.clampNumber(
      normalized.settings.edge_width_scale,
      0.1,
      5,
      DEFAULT_DATA.settings.edge_width_scale
    );
    normalized.settings.edge_opacity = this.clampNumber(
      normalized.settings.edge_opacity,
      0,
      1,
      DEFAULT_DATA.settings.edge_opacity
    );
    // Removed settings: painted edges share the edge width; Sharpness was withdrawn.
    for (const settings of [normalized.settings, normalized.saved_layout_settings]) {
      delete settings.painted_edge_width;
      delete settings.render_resolution_scale;
    }
    if (normalized.settings.label_zoom_steps == null && settings.label_min_zoom != null) {
      const legacySlider = this.clampNumber(settings.label_min_zoom, 0.01, 1, 0.35);
      const legacyThreshold = this.clampNumber(1.01 - legacySlider, MIN_ZOOM, MAX_ZOOM, 1);
      const legacySteps =
        Math.round(Math.log(MAX_ZOOM / legacyThreshold) / Math.log(ZOOM_STEP_FACTOR)) + 1;
      normalized.settings.label_zoom_steps = legacySteps;
    }
    normalized.settings.label_zoom_steps = this.clampNumber(
      normalized.settings.label_zoom_steps,
      1,
      40,
      DEFAULT_DATA.settings.label_zoom_steps
    );
    normalized.settings.label_font_size = this.clampNumber(
      normalized.settings.label_font_size,
      5,
      20,
      DEFAULT_DATA.settings.label_font_size
    );
    normalized.settings.hover_dim_strength = this.clampNumber(
      normalized.settings.hover_dim_strength,
      0,
      100,
      DEFAULT_DATA.settings.hover_dim_strength
    );
    normalized.settings.strong_pull_multiplier = this.clampNumber(
      normalized.settings.strong_pull_multiplier,
      NODE_MULTIPLIER_MIN,
      NODE_MULTIPLIER_MAX,
      DEFAULT_DATA.settings.strong_pull_multiplier
    );
    const hasOrbitDistanceSetting = settings.orbit_distance != null;
    let orbitDistanceSetting = Number(normalized.settings.orbit_distance);
    if (!hasOrbitDistanceSetting && settings.orbit_distance_multiplier != null) {
      const legacyOrbitDistanceMultiplier = this.clampNumber(
        settings.orbit_distance_multiplier,
        0.1,
        2,
        0.2
      );
      orbitDistanceSetting = normalized.settings.link_distance * legacyOrbitDistanceMultiplier;
    }
    normalized.settings.orbit_distance = this.clampNumber(
      orbitDistanceSetting,
      1,
      100,
      DEFAULT_DATA.settings.orbit_distance
    );
    normalized.settings.show_grid = !!normalized.settings.show_grid;
    normalized.settings.hide_orphans = !!normalized.settings.hide_orphans;
    normalized.settings.hide_attachments = !!normalized.settings.hide_attachments;
    normalized.settings.excluded_attachment_extensions = normalizeAttachmentExtensions(
      normalized.settings.excluded_attachment_extensions
    );
    normalized.saved_layout_settings.excluded_attachment_extensions = normalizeAttachmentExtensions(
      normalized.saved_layout_settings.excluded_attachment_extensions
    );
    normalized.settings.include_unlinked_attachments =
      !!normalized.settings.include_unlinked_attachments;
    normalized.settings.existing_files_only = !!normalized.settings.existing_files_only;
    normalized.settings.show_only_groups = normalized.settings.show_only_groups === true;
    normalized.settings.show_search_connections =
      normalized.settings.show_search_connections === true;
    normalized.settings.search_mode =
      normalized.settings.search_mode === 'filter' || normalized.settings.search_mode === 'filtr'
        ? 'filter'
        : 'find';
    normalized.settings.quick_pick_modifier = ['alt', 'ctrl', 'meta', 'shift', 'none'].includes(
      normalized.settings.quick_pick_modifier
    )
      ? normalized.settings.quick_pick_modifier
      : DEFAULT_DATA.settings.quick_pick_modifier;
    normalized.settings.selection_box_modifier = ['alt', 'ctrl', 'meta', 'shift', 'none'].includes(
      normalized.settings.selection_box_modifier
    )
      ? normalized.settings.selection_box_modifier
      : DEFAULT_DATA.settings.selection_box_modifier;
    normalized.settings.selection_toggle_modifier = [
      'alt',
      'ctrl',
      'meta',
      'shift',
      'none',
    ].includes(normalized.settings.selection_toggle_modifier)
      ? normalized.settings.selection_toggle_modifier
      : DEFAULT_DATA.settings.selection_toggle_modifier;
    normalized.settings.layout_autosave = !!normalized.settings.layout_autosave;
    normalized.settings.export_static_html_path =
      typeof normalized.settings.export_static_html_path === 'string'
        ? normalized.settings.export_static_html_path.trim()
        : '';
    normalized.settings.export_static_html_mobile_path =
      typeof normalized.settings.export_static_html_mobile_path === 'string'
        ? normalized.settings.export_static_html_mobile_path.trim()
        : '';
    delete normalized.settings.max_multiplier;
    delete normalized.settings.label_min_zoom;
    delete normalized.settings.orbit_distance_multiplier;

    if (
      Number(settings.base_link_strength) === 0.08 &&
      Number(settings.link_distance) === 220 &&
      Number(settings.repel_strength) === 2800 &&
      Number(settings.center_strength) === 0.015 &&
      Number(settings.damping) === 0.86
    ) {
      normalized.settings.base_link_strength = DEFAULT_DATA.settings.base_link_strength;
      normalized.settings.link_distance = DEFAULT_DATA.settings.link_distance;
      normalized.settings.repel_strength = DEFAULT_DATA.settings.repel_strength;
      normalized.settings.center_strength = DEFAULT_DATA.settings.center_strength;
      normalized.settings.damping = DEFAULT_DATA.settings.damping;
    }

    for (const [nodeId, rawValue] of Object.entries(multipliers)) {
      const multiplier = this.clampMultiplier(rawValue);
      if (multiplier > 1 || Number(rawValue) === 1)
        normalized.node_force_multipliers[nodeId] = multiplier;
    }
    for (const [nodeId, rawValue] of Object.entries(strongPullNodes)) {
      if (rawValue) normalized.strong_pull_nodes[nodeId] = true;
    }
    for (const [nodeId, rawColor] of Object.entries(paintedEdgeColors)) {
      const colorText = String(rawColor || '').trim();
      if (!colorText) continue;
      normalized.painted_edge_colors[nodeId] = this.normalizeGroupColor(colorText);
    }
    if (Object.keys(normalized.strong_pull_nodes).length === 0) {
      for (const nodeId of Object.keys(normalized.node_force_multipliers)) {
        normalized.strong_pull_nodes[nodeId] = true;
      }
    }

    for (const rawGroup of rawGroups) {
      if (!rawGroup || typeof rawGroup !== 'object') continue;
      const query = String(rawGroup.query || '').trim();
      if (!query) continue;
      const color = this.normalizeGroupColor(rawGroup.color);
      normalized.groups.push({
        id: typeof rawGroup.id === 'string' && rawGroup.id ? rawGroup.id : this.createGroupId(),
        query,
        color,
        enabled: rawGroup.enabled !== false,
        ...(rawGroup.hidden === true ? { hidden: true } : {}),
        settings: normalizeGroupVisuals(rawGroup.settings),
      });
    }
    for (const rawRule of rawBlacklist) {
      if (!rawRule || typeof rawRule !== 'object') continue;
      const query = String(rawRule.query || '').trim();
      if (!query) continue;
      normalized.blacklist.push({
        id: typeof rawRule.id === 'string' && rawRule.id ? rawRule.id : this.createGroupId(),
        query,
        enabled: rawRule.enabled !== false,
      });
    }
    for (const rawRule of rawWhitelist) {
      if (!rawRule || typeof rawRule !== 'object') continue;
      const query = String(rawRule.query || '').trim();
      if (!query) continue;
      normalized.whitelist.push({
        id: typeof rawRule.id === 'string' && rawRule.id ? rawRule.id : this.createGroupId(),
        query,
        enabled: rawRule.enabled !== false,
      });
    }
    for (const [commandId, rawHotkey] of Object.entries(rawHotkeys)) {
      if (!HOTKEY_COMMAND_IDS.has(commandId)) continue;
      const normalizedHotkey = this.normalizeHotkeyText(rawHotkey);
      if (!normalizedHotkey) continue;
      normalized.hotkeys[commandId] = normalizedHotkey;
    }

    normalized.view_state.pan_x = this.clampNumber(normalized.view_state.pan_x, -1e7, 1e7, 0);
    normalized.view_state.pan_y = this.clampNumber(normalized.view_state.pan_y, -1e7, 1e7, 0);
    normalized.view_state.zoom = this.clampNumber(
      normalized.view_state.zoom,
      MIN_ZOOM,
      MAX_ZOOM,
      1
    );
    const rawSidePanelSections =
      normalized.view_state.side_panel_sections &&
      typeof normalized.view_state.side_panel_sections === 'object'
        ? normalized.view_state.side_panel_sections
        : {};
    const nextSidePanelSections = {};
    for (const [rawSectionId, rawState] of Object.entries(rawSidePanelSections)) {
      const sectionId = String(rawSectionId || '')
        .trim()
        .toLowerCase();
      if (!sectionId) continue;
      nextSidePanelSections[sectionId] = !!rawState;
    }
    normalized.view_state.side_panel_sections = nextSidePanelSections;
    const settingsTab = LEGACY_SETTINGS_TABS[viewState.settings_tab] || viewState.settings_tab;
    normalized.view_state.settings_tab = SETTINGS_TABS.includes(settingsTab)
      ? settingsTab
      : DEFAULT_DATA.view_state.settings_tab;
    normalized.view_state.camera_saved = viewState.camera_saved === true;
    normalized.view_state.search_query =
      typeof viewState.search_query === 'string' && this.parseGroupQuery(viewState.search_query)
        ? viewState.search_query.slice(0, 4096)
        : 'name:';
    // Display order of filter rows across blacklist and whitelist; the rules stay as they are.
    normalized.view_state.filter_order = Array.isArray(viewState.filter_order)
      ? [
          ...new Set(
            viewState.filter_order.filter((id) => typeof id === 'string' && id.length <= 256)
          ),
        ]
      : [];
    normalized.view_state.node_filter = Array.isArray(viewState.node_filter)
      ? [
          ...new Set(
            viewState.node_filter.filter((id) => typeof id === 'string' && id.length <= 4096)
          ),
        ]
      : null;

    const legacyRender = normalizeLegacyRenderSettings(safe.legacy_render_settings);
    if (legacyRender) normalized.legacy_render_settings = legacyRender;
    if (safe.render_model === RENDER_MODEL && !legacyRender?.pending_edge_dpr)
      normalized.render_model = RENDER_MODEL;

    return normalizeSubgraphSpaces(normalized, safe.subgraph_coordinates);
  }

  // Finishes the render model 2 migration once the device pixel ratio is known.
  applyPendingRenderMigration(devicePixelRatio) {
    if (!applyEdgeDprMigration(this.data, devicePixelRatio)) return false;
    for (const view of this.getGraphViews()) if (view) view.layoutAutosaveDirty = true;
    this.schedulePersist();
    this.renderAllViews?.();
    return true;
  }

  // Utility helpers: clamp functions, id generation, and color normalization.
  normalizeGroupColor(rawColor) {
    const fallback = '#7aa2f7';
    const text = String(rawColor || '').trim();
    if (!/^#([0-9a-f]{6})$/i.test(text)) return fallback;
    return text.toLowerCase();
  }

  createGroupId() {
    return `group_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  clampGridStep(value) {
    return this.clampNumber(value, 5, 50, DEFAULT_DATA.settings.grid_step);
  }

  clampGridLineWidth(value) {
    return this.clampNumber(value, 0.1, 2, DEFAULT_DATA.settings.grid_line_width);
  }

  clampMultiplier(value) {
    return this.clampNumber(value, NODE_MULTIPLIER_MIN, NODE_MULTIPLIER_MAX, NODE_MULTIPLIER_MIN);
  }

  clampStrongPullMultiplier(value) {
    return this.clampNumber(
      value,
      NODE_MULTIPLIER_MIN,
      NODE_MULTIPLIER_MAX,
      DEFAULT_DATA.settings.strong_pull_multiplier
    );
  }

  clampNumber(value, min, max, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, num));
  }

  getSidePanelSectionsState() {
    const rawSidePanelSections =
      this.data?.view_state?.side_panel_sections &&
      typeof this.data.view_state.side_panel_sections === 'object'
        ? this.data.view_state.side_panel_sections
        : {};
    const nextSidePanelSections = {};
    for (const [rawSectionId, rawState] of Object.entries(rawSidePanelSections)) {
      const sectionId = String(rawSectionId || '')
        .trim()
        .toLowerCase();
      if (!sectionId) continue;
      nextSidePanelSections[sectionId] = !!rawState;
    }
    return nextSidePanelSections;
  }

  getSettingsTab() {
    const stored = this.data?.view_state?.settings_tab;
    const tab = LEGACY_SETTINGS_TABS[stored] || stored;
    return SETTINGS_TABS.includes(tab) ? tab : DEFAULT_DATA.view_state.settings_tab;
  }

  applySidePanelSectionsState(targetData, sidePanelSectionsState = null) {
    if (!targetData || typeof targetData !== 'object') return targetData;
    if (!targetData.view_state || typeof targetData.view_state !== 'object') {
      targetData.view_state = Object.assign({}, DEFAULT_DATA.view_state);
    }
    const normalizedSections =
      sidePanelSectionsState && typeof sidePanelSectionsState === 'object'
        ? sidePanelSectionsState
        : this.getSidePanelSectionsState();
    targetData.view_state.side_panel_sections = Object.assign({}, normalizedSections);
    targetData.view_state.settings_tab = this.getSettingsTab();
    return targetData;
  }

  // Hotkey handling: normalize combos, detect conflicts, and intercept key events.
  normalizeHotkeyKey(rawKey) {
    return normalizeHotkeyKeyUtil(rawKey);
  }

  normalizeHotkeyText(rawHotkey) {
    return normalizeHotkeyTextUtil(rawHotkey);
  }

  getHotkeyFromKeyboardEvent(keyboardEvent) {
    if (!keyboardEvent || keyboardEvent.repeat) return '';
    return getHotkeyFromKeyboardEventUtil(keyboardEvent);
  }

  getHotkeyCommandIdByHotkey(hotkeyText, ignoreCommandId = '') {
    const normalizedHotkey = this.normalizeHotkeyText(hotkeyText);
    if (!normalizedHotkey) return '';
    for (const commandMeta of HOTKEY_COMMANDS) {
      if (commandMeta.id === ignoreCommandId) continue;
      if (this.data.hotkeys?.[commandMeta.id] === normalizedHotkey) {
        return commandMeta.id;
      }
    }
    return '';
  }

  getHotkeyDisplayName(commandId) {
    const commandMeta = HOTKEY_COMMANDS.find((item) => item.id === commandId);
    return commandMeta ? commandMeta.name : commandId;
  }

  getCommandHotkey(commandId) {
    return this.normalizeHotkeyText(this.data.hotkeys?.[commandId] || '');
  }

  setCommandHotkey(commandId, rawHotkey) {
    if (!HOTKEY_COMMAND_IDS.has(commandId)) return;
    const normalizedHotkey = this.normalizeHotkeyText(rawHotkey);
    if (!normalizedHotkey) {
      this.clearCommandHotkey(commandId);
      return;
    }
    if (!this.data.hotkeys || typeof this.data.hotkeys !== 'object') {
      this.data.hotkeys = {};
    }
    this.data.hotkeys[commandId] = normalizedHotkey;
    this.schedulePersist(250, { layout: false });
  }

  clearCommandHotkey(commandId) {
    if (!this.data.hotkeys?.[commandId]) return;
    delete this.data.hotkeys[commandId];
    this.schedulePersist(250, { layout: false });
  }

  isEditableTarget(targetElement) {
    if (!targetElement || typeof targetElement !== 'object') return false;
    if (targetElement.isContentEditable) return true;
    if (typeof targetElement.closest !== 'function') return false;
    return !!targetElement.closest('input, textarea, select, [contenteditable="true"]');
  }

  handleCustomHotkeyEvent(keyboardEvent) {
    if (this.isEditableTarget(keyboardEvent.target)) return;
    const hotkeyText = this.getHotkeyFromKeyboardEvent(keyboardEvent);
    if (!hotkeyText) return;

    const commandId = this.getHotkeyCommandIdByHotkey(hotkeyText);
    if (!commandId) return;
    if (commandId !== 'graphfrontier-open-view' && !this.getActiveGraphFrontierView()) return;

    keyboardEvent.preventDefault();
    keyboardEvent.stopPropagation();
    this.app.commands.executeCommandById(commandId);
  }

  // Every data change is persisted to data.json. Layout content changes also become unsaved
  // layout data, which Autosave writes to the active layout; UI preferences pass layout: false.
  schedulePersist(delayMs = 250, options = {}) {
    if (this.backups?.restoring) return;
    const clean = !this.hasUnsavedLayoutData();
    this._persistRevision = (this._persistRevision || 0) + 1;
    if (options.layout === false && clean) this.markLayoutSaved();
    if (this._persistTimer) window.clearTimeout(this._persistTimer);
    const safeDelayMs = this.clampNumber(delayMs, 100, 5000, 250);
    this._persistTimer = window.setTimeout(() => {
      void this.persistPluginDataOnly();
      this.autosaveLayoutData();
    }, safeDelayMs);
  }

  hasUnsavedLayoutData() {
    return (this._persistRevision || 0) !== (this.layoutSavedRevision || 0);
  }

  // The active layout file now matches the plugin data, after a save or a load.
  markLayoutSaved(revision = this._persistRevision || 0) {
    this.layoutSavedRevision = revision;
  }

  // Settings, colors, groups and rules do not move nodes, so physics never autosaves them;
  // they are saved here once persisted. A graph that is still moving saves when it settles.
  autosaveLayoutData() {
    if (!this.getSettings().layout_autosave || !this.hasUnsavedLayoutData()) return;
    const view = this.getGraphViews().find(
      (entry) => entry?.isOpen && !entry.subgraphScope && entry.graphDataRef === this.data
    );
    if (!view) return;
    view.layoutAutosaveDirty = true;
    if (view.layoutPaused && !view.dragNodeId) void view.saveCurrentLayout({ silent: true });
  }

  getLayoutsFolderRelativePath() {
    const configDir = String(this.app?.vault?.configDir || '.obsidian').replace(/\/+$/u, '');
    const pluginId = String(this.manifest?.id || 'graphfrontier').trim() || 'graphfrontier';
    return `${configDir}/plugins/${pluginId}/layouts`;
  }

  normalizeLayoutFileName(rawLayoutFileName) {
    const fallback = String(DEFAULT_DATA.active_layout_name || 'data.json');
    const rawText = String(rawLayoutFileName || '').trim();
    if (!rawText) return fallback;
    const tail = rawText.split(/[\\/]/u).filter(Boolean).pop();
    let fileName = String(tail || '').trim();
    if (!fileName) return fallback;
    fileName = fileName.replace(/[^\w.\- ]/gu, '_').trim();
    if (!fileName) return fallback;
    if (!/\.json$/iu.test(fileName)) fileName = `${fileName}.json`;
    return fileName;
  }

  getActiveLayoutFileName() {
    return this.normalizeLayoutFileName(this.data?.active_layout_name);
  }

  async ensureLayoutsFolder() {
    const adapter = this.app?.vault?.adapter;
    if (!adapter || typeof adapter.mkdir !== 'function') return;
    const folderPath = this.getLayoutsFolderRelativePath();
    try {
      await adapter.mkdir(folderPath);
    } catch {
      // Folder already exists or adapter does not support this operation.
    }
  }

  async listLayoutFileNames() {
    const adapter = this.app?.vault?.adapter;
    if (!adapter || typeof adapter.list !== 'function') return [];
    const folderPath = this.getLayoutsFolderRelativePath();
    let files = [];
    try {
      const listed = await adapter.list(folderPath);
      files = Array.isArray(listed?.files) ? listed.files : [];
    } catch {
      return [];
    }
    return files
      .map((filePath) =>
        String(filePath || '')
          .split(/[\\/]/u)
          .pop()
      )
      .filter((fileName) => !!fileName && /\.json$/iu.test(fileName))
      .sort((leftName, rightName) => leftName.localeCompare(rightName));
  }

  getLayoutFileRelativePath(layoutFileName) {
    const fileName = this.normalizeLayoutFileName(layoutFileName);
    return `${this.getLayoutsFolderRelativePath()}/${fileName}`;
  }

  async readLayoutFileData(layoutFileName) {
    const adapter = this.app?.vault?.adapter;
    if (!adapter || typeof adapter.read !== 'function') return { status: 'error' };
    const filePath = this.getLayoutFileRelativePath(layoutFileName);
    try {
      if (typeof adapter.exists === 'function' && (await adapter.exists(filePath)) === false) {
        return { status: 'missing' };
      }
      const rawText = await adapter.read(filePath);
      const parsed = JSON.parse(rawText);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { status: 'error' };
      }
      return { status: 'ok', data: parsed };
    } catch {
      // A failed read is not proof of absence; never bootstrap over it.
      return { status: 'error' };
    }
  }

  async writeLayoutFileData(layoutFileName, dataObject) {
    const adapter = this.app?.vault?.adapter;
    if (!adapter || typeof adapter.write !== 'function') return false;
    const fileName = this.normalizeLayoutFileName(layoutFileName);
    const filePath = this.getLayoutFileRelativePath(fileName);
    const normalizedData = this.normalizeData(dataObject);
    normalizedData.active_layout_name = fileName;
    // Side panel section state is global UI state, not layout-specific.
    if (!normalizedData.view_state || typeof normalizedData.view_state !== 'object') {
      normalizedData.view_state = Object.assign({}, DEFAULT_DATA.view_state);
    }
    normalizedData.view_state.side_panel_sections = {};
    delete normalizedData.view_state.settings_tab;
    try {
      const contents = `${JSON.stringify(normalizedData, null, 2)}\n`;
      await this.ensureLayoutsFolder();
      await adapter.write(filePath, contents);
      this.backups?.schedule();
      return true;
    } catch {
      return false;
    }
  }

  async deleteLayoutFile(layoutFileName, options = {}) {
    return this.runLayoutFileOperation(() => this.deleteLayoutFileNow(layoutFileName, options));
  }

  async deleteLayoutFileNow(layoutFileName, options = {}) {
    const fileName = this.normalizeLayoutFileName(layoutFileName);
    const existingLayoutNames = await this.listLayoutFileNames();
    if (!existingLayoutNames.includes(fileName)) {
      return { ok: false, reason: 'not-found' };
    }
    if (existingLayoutNames.length <= 1) {
      return { ok: false, reason: 'last-layout' };
    }

    const wasActiveLayout = this.getActiveLayoutFileName() === fileName;
    const remainingLayoutNames = existingLayoutNames.filter((name) => name !== fileName);
    const preferredFallback = this.normalizeLayoutFileName(DEFAULT_DATA.active_layout_name);
    const nextActiveLayoutName = remainingLayoutNames.includes(preferredFallback)
      ? preferredFallback
      : remainingLayoutNames[0];
    // Validate the fallback before deleting the active file, not after it is gone.
    if (wasActiveLayout && (await this.readLayoutFileData(nextActiveLayoutName)).status !== 'ok') {
      return { ok: false, reason: 'invalid-fallback' };
    }
    if (options.beforeDelete) await options.beforeDelete();

    const filePath = this.getLayoutFileRelativePath(fileName);
    const adapter = this.app?.vault?.adapter;
    let removed = false;

    if (adapter && typeof adapter.remove === 'function') {
      try {
        await adapter.remove(filePath);
        removed = true;
      } catch {
        removed = false;
      }
    }

    if (!removed) {
      const abstractFile = this.app?.vault?.getAbstractFileByPath(filePath);
      if (abstractFile && typeof this.app?.vault?.trash === 'function') {
        try {
          await this.app.vault.trash(abstractFile, false);
          removed = true;
        } catch {
          removed = false;
        }
      }
    }

    if (!removed) {
      return { ok: false, reason: 'delete-failed' };
    }

    if (!wasActiveLayout) {
      return {
        ok: true,
        deletedLayoutName: fileName,
        activeLayoutName: this.getActiveLayoutFileName(),
        activeChanged: false,
      };
    }

    if (!nextActiveLayoutName) {
      return { ok: false, reason: 'no-fallback' };
    }

    const switched = await this.setActiveLayoutFileNow(nextActiveLayoutName, {
      loadFromFile: true,
    });
    if (!switched) {
      return { ok: false, reason: 'active-switch-failed' };
    }

    return {
      ok: true,
      deletedLayoutName: fileName,
      activeLayoutName: this.getActiveLayoutFileName(),
      activeChanged: true,
    };
  }

  // Renames a layout file; the active layout keeps being active under its new name.
  async renameLayoutFile(layoutFileName, nextName) {
    return this.runLayoutFileOperation(async () => {
      const from = this.normalizeLayoutFileName(layoutFileName);
      const to = this.normalizeLayoutFileName(nextName);
      if (from === to) return { ok: true, layoutName: to };
      const names = await this.listLayoutFileNames();
      if (!names.includes(from)) return { ok: false, reason: 'not-found' };
      if (names.includes(to)) return { ok: false, reason: 'exists', layoutName: to };
      try {
        await this.app.vault.adapter.rename(
          this.getLayoutFileRelativePath(from),
          this.getLayoutFileRelativePath(to)
        );
      } catch {
        return { ok: false, reason: 'rename-failed' };
      }
      if (this.getActiveLayoutFileName() === from) {
        this.data.active_layout_name = to;
        await this.persistPluginDataOnly();
      }
      this.backups?.schedule();
      return { ok: true, layoutName: to };
    });
  }

  async persistPluginDataOnly() {
    const activeLayoutName = this.getActiveLayoutFileName();
    this.data.active_layout_name = activeLayoutName;
    await this.saveData(
      this.backups ? { ...this.data, backups: this.backups.preferences } : this.data
    );
    this.backups?.schedule();
  }

  async persistActiveLayoutFile(data = this.data, layoutName = this.getActiveLayoutFileName()) {
    if (this._layoutReadFailedName === layoutName) return false;
    return this.writeLayoutFileData(layoutName, data);
  }

  // Serialize save commits and full-file reloads, not unrelated UI work.
  runLayoutFileOperation(operation) {
    const pending = (this._layoutFileOperation || Promise.resolve()).then(operation);
    this._layoutFileOperation = pending.catch(() => {});
    return pending;
  }

  async bootstrapActiveLayoutData() {
    const activeLayoutName = this.getActiveLayoutFileName();
    const result = await this.readLayoutFileData(activeLayoutName);
    if (result.status === 'ok') {
      const normalizedLayoutData = this.normalizeData(result.data);
      normalizedLayoutData.active_layout_name = activeLayoutName;
      this.applySidePanelSectionsState(normalizedLayoutData);
      this.data = normalizedLayoutData;
      this._layoutReadFailedName = null;
      await this.persistPluginDataOnly();
      return true;
    }
    if (result.status !== 'missing') {
      this._layoutReadFailedName = activeLayoutName;
      new Notice(`Cannot read layout: ${activeLayoutName}. File left unchanged.`);
      return false;
    }
    this.data.active_layout_name = activeLayoutName;
    const written = await this.persistActiveLayoutFile();
    if (!written) {
      new Notice(`Failed to create layout: ${activeLayoutName}`);
      return false;
    }
    await this.persistPluginDataOnly();
    return true;
  }

  async setActiveLayoutFile(layoutFileName, options = {}) {
    return this.runLayoutFileOperation(() => this.setActiveLayoutFileNow(layoutFileName, options));
  }

  async setActiveLayoutFileNow(layoutFileName, options = {}) {
    options.assertCurrent?.();
    const nextLayoutName = this.normalizeLayoutFileName(layoutFileName);
    const shouldLoadFromFile = options.loadFromFile !== false;
    let nextData = this.normalizeData(this.data);
    if (shouldLoadFromFile) {
      const result = await this.readLayoutFileData(nextLayoutName);
      if (result.status !== 'ok') return false;
      nextData = this.normalizeData(result.data);
    }
    options.assertCurrent?.();
    if (this._persistTimer) {
      window.clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }
    nextData.active_layout_name = nextLayoutName;
    this.applySidePanelSectionsState(nextData);
    try {
      await this.saveData(
        this.backups ? { ...nextData, backups: this.backups.preferences } : nextData
      );
    } catch {
      new Notice('Layout selected, but plugin preferences could not be saved');
    }
    // Publish after the last await so queued saves still identify the old layout
    // until the full-file switch is ready to update its views.
    this.applySidePanelSectionsState(nextData);
    this.data = nextData;
    if (shouldLoadFromFile) this._layoutReadFailedName = null;
    this.backups?.schedule();
    return true;
  }

  // Node-state management: pin/grid/orbit modes, strong pull, and painted edges.
  getPin(nodeId) {
    const pin = this.data.pins[nodeId];
    if (!pin || typeof pin !== 'object') return null;
    const x = Number(pin.x);
    const y = Number(pin.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return {
      x,
      y,
      mode: pin.mode === 'grid' ? 'grid' : 'exact',
    };
  }

  isPinned(nodeId) {
    return !!this.data.pins[nodeId];
  }

  getPinMode(nodeId) {
    const pin = this.getPin(nodeId);
    if (!pin) return 'exact';
    return pin.mode === 'grid' ? 'grid' : 'exact';
  }

  setPin(nodeId, position, options = {}) {
    const x = Number(position?.x);
    const y = Number(position?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    let nextMode = null;
    if (options.mode === 'grid') nextMode = 'grid';
    else if (options.mode === 'exact') nextMode = 'exact';
    if (!nextMode) nextMode = this.getPinMode(nodeId);
    delete this.data.orbit_pins[nodeId];
    this.data.pins[nodeId] = { x, y, mode: nextMode };
    this.schedulePersist();
  }

  removePin(nodeId) {
    if (!this.data.pins[nodeId]) return;
    delete this.data.pins[nodeId];
    this.schedulePersist();
  }

  getOrbitPin(nodeId) {
    const orbitPin = this.data.orbit_pins?.[nodeId];
    if (!orbitPin || typeof orbitPin !== 'object') return null;
    const anchorId = String(orbitPin.anchor_id || '').trim();
    const radius = Number(orbitPin.radius);
    const angle = Number(orbitPin.angle);
    if (!anchorId || anchorId === nodeId) return null;
    if (!Number.isFinite(radius) || radius <= 0) return null;
    if (!Number.isFinite(angle)) return null;
    return {
      anchor_id: anchorId,
      radius,
      angle,
    };
  }

  isOrbitPinned(nodeId) {
    return !!this.getOrbitPin(nodeId);
  }

  setOrbitPin(nodeId, orbitMeta) {
    const anchorId = String(orbitMeta?.anchor_id || '').trim();
    const radius = Number(orbitMeta?.radius);
    const angle = Number(orbitMeta?.angle);
    if (!anchorId || anchorId === nodeId) return;
    if (!Number.isFinite(radius) || radius <= 0) return;
    if (!Number.isFinite(angle)) return;
    delete this.data.pins[nodeId];
    this.data.orbit_pins[nodeId] = {
      anchor_id: anchorId,
      radius,
      angle,
    };
    this.schedulePersist();
  }

  removeOrbitPin(nodeId) {
    if (!this.data.orbit_pins?.[nodeId]) return;
    delete this.data.orbit_pins[nodeId];
    this.schedulePersist();
  }

  getNodeLabelSize(nodeId) {
    return this.data.node_label_sizes?.[nodeId] ?? null;
  }

  setNodeVisualSetting(nodeId, key, value) {
    const spec = NODE_VISUAL_SETTINGS.find((item) => item.key === key);
    if (!spec) return;
    if (
      value !== null &&
      (spec.type === 'color'
        ? !/^#[0-9a-f]{6}$/i.test(value)
        : spec.type === 'boolean'
          ? typeof value !== 'boolean'
          : typeof value !== 'number' || !Number.isFinite(value))
    )
      return;
    if (key === 'label_font_size') {
      this.setNodeLabelSize(nodeId, value);
      return;
    }
    const settings = { ...this.data.node_visual_settings?.[nodeId] };
    if (key === 'edge_color') delete this.data.painted_edge_colors?.[nodeId];
    if (value === null) delete settings[key];
    else
      settings[key] =
        spec.type === 'color' || spec.type === 'boolean'
          ? value
          : Math.max(spec.min, Math.min(spec.max, value));
    this.data.node_visual_settings = { ...this.data.node_visual_settings, [nodeId]: settings };
    if (!Object.keys(settings).length) delete this.data.node_visual_settings[nodeId];
    this.persistNodeVisualSettings();
  }

  setNodeLabelSize(nodeId, size) {
    if (size !== null && (typeof size !== 'number' || !Number.isFinite(size))) return;
    this.data.node_label_sizes ??= {};
    if (size === null) delete this.data.node_label_sizes[nodeId];
    else this.data.node_label_sizes[nodeId] = this.clampNumber(size, 5, 20, 9);
    this.persistNodeVisualSettings();
  }

  resetNodeVisualSettings(nodeId) {
    delete this.data.node_visual_settings?.[nodeId];
    delete this.data.node_label_sizes?.[nodeId];
    delete this.data.painted_edge_colors?.[nodeId];
    this.persistNodeVisualSettings();
  }

  persistNodeVisualSettings() {
    this.appearanceVersion = (this.appearanceVersion || 0) + 1;
    for (const leaf of this.app.workspace.getLeavesOfType(GRAPHFRONTIER_VIEW_TYPE)) {
      if (!leaf.view) continue;
      leaf.view.layoutEditVersion = (leaf.view.layoutEditVersion || 0) + 1;
      leaf.view.layoutAutosaveDirty = true;
      leaf.view.layoutStillFrames = 0;
    }
    this.schedulePersist();
    this.renderAllViews();
  }

  getNodeMultiplier(nodeId, context) {
    const group =
      this.data.node_force_multipliers[nodeId] == null
        ? this.getGroupVisualSettings(nodeId, context)
        : null;
    const stored =
      this.data.node_force_multipliers[nodeId] ??
      (group?.strong_pull
        ? this.clampStrongPullMultiplier(
            group.strong_pull_multiplier ?? this.getSettings().strong_pull_multiplier
          )
        : 1);
    const multiplier = this.clampMultiplier(stored);
    return multiplier > 1 ? multiplier : 1;
  }

  isStrongPullNode(nodeId) {
    if (this.data.node_force_multipliers[nodeId] != null || this.data.strong_pull_nodes[nodeId])
      return !!this.data.strong_pull_nodes[nodeId];
    return !!this.getGroupVisualSettings(nodeId)?.strong_pull;
  }

  // Graph views this plugin owns: every main pane, or the one local graph pane.
  getGraphViews() {
    return this.isLocalGraphFrontier
      ? [this.getScopeView?.()]
      : this.app.workspace.getLeavesOfType(GRAPHFRONTIER_VIEW_TYPE).map((leaf) => leaf.view);
  }

  // Filter rules changed: every view recomputes which nodes are visible.
  markQueryRulesDirty() {
    const views = this.getGraphViews();
    for (const view of views) view?.markQueryRuleVisibilityDirty?.();
    return views;
  }

  // Force multipliers change link forces, so settled layouts must re-settle.
  kickPhysicsViews(nodeId) {
    for (const view of this.getGraphViews()) {
      if (!view?.nodeById?.has(nodeId)) continue;
      const visible = view.getPhysicsVisibleNodeIds?.() ?? view.getFilterVisibleNodeIds?.();
      if (visible instanceof Set && !visible.has(nodeId)) continue;
      view.kickLayoutSearch?.();
    }
  }

  setNodeMultiplier(nodeId, value, options = {}) {
    const multiplier = this.clampMultiplier(value);
    this.data.node_force_multipliers[nodeId] = multiplier;
    if (options.mode === 'strong-pull') {
      this.data.strong_pull_nodes[nodeId] = true;
    } else if (options.mode === 'manual') {
      delete this.data.strong_pull_nodes[nodeId];
    }
    this.kickPhysicsViews(nodeId);
    this.schedulePersist();
  }

  clearNodeMultiplier(nodeId) {
    if (!this.data.node_force_multipliers[nodeId] && !this.data.strong_pull_nodes[nodeId]) return;
    delete this.data.node_force_multipliers[nodeId];
    delete this.data.strong_pull_nodes[nodeId];
    this.kickPhysicsViews(nodeId);
    this.schedulePersist();
  }

  applyStrongPullToMarkedNodes() {
    const target = this.clampStrongPullMultiplier(this.data.settings.strong_pull_multiplier);
    for (const nodeId of Object.keys(this.data.strong_pull_nodes)) {
      this.data.node_force_multipliers[nodeId] = target;
      this.kickPhysicsViews(nodeId);
    }
    this.schedulePersist();
  }

  getPaintedEdgeColor(nodeId, context) {
    const colorText = String(
      this.data.painted_edge_colors?.[nodeId] ??
        this.data.node_visual_settings?.[nodeId]?.edge_color ??
        getNodeGroupVisuals(this, nodeId, context)?.edge_color ??
        ''
    ).trim();
    if (!/^#([0-9a-f]{6})$/i.test(colorText)) return null;
    return colorText.toLowerCase();
  }

  setPaintedEdgeColor(nodeId, color) {
    const normalizedColor = this.normalizeGroupColor(color);
    if (this.data.node_visual_settings?.[nodeId])
      delete this.data.node_visual_settings[nodeId].edge_color;
    this.data.painted_edge_colors[nodeId] = normalizedColor;
    this.appearanceVersion = (this.appearanceVersion || 0) + 1;
    this.schedulePersist();
  }

  clearPaintedEdgeColor(nodeId) {
    if (
      !this.data.painted_edge_colors?.[nodeId] &&
      this.data.node_visual_settings?.[nodeId]?.edge_color == null
    )
      return;
    this.setNodeVisualSetting(nodeId, 'edge_color', null);
  }

  // View sync across all open GraphFrontier tabs (refresh/render/recompute).
  getSettings() {
    return this.data.settings;
  }

  scheduleRefreshAllViews(options = {}) {
    if (!this._pendingRefreshOptions || typeof this._pendingRefreshOptions !== 'object') {
      this._pendingRefreshOptions = {};
    }
    const safeOptions = options && typeof options === 'object' ? options : {};
    this._pendingRefreshOptions = Object.assign({}, this._pendingRefreshOptions, safeOptions);
    if (this._refreshTimer) window.clearTimeout(this._refreshTimer);
    this._refreshTimer = window.setTimeout(() => {
      const nextOptions = Object.assign({}, this._pendingRefreshOptions);
      this._pendingRefreshOptions = {};
      this.refreshAllViews(nextOptions);
      this.refreshLocalViews(nextOptions);
    }, 300);
  }

  refreshAllViews(options = {}) {
    const viewOptions = Object.assign({ keepCamera: true }, options || {});
    const leaves = this.app.workspace.getLeavesOfType(GRAPHFRONTIER_VIEW_TYPE);
    for (const leaf of leaves) {
      const view = leaf?.view;
      if (view && typeof view.refreshFromVault === 'function') {
        view.refreshFromVault(viewOptions);
      }
    }
  }

  refreshLocalViews(options = {}) {
    for (const leaf of this.app.workspace.getLeavesOfType(LOCAL_GRAPHFRONTIER_VIEW_TYPE)) {
      leaf.view?.refreshFromVault({ keepCamera: true, ...options });
    }
  }

  renderAllViews() {
    const leaves = this.app.workspace.getLeavesOfType(GRAPHFRONTIER_VIEW_TYPE);
    for (const leaf of leaves) {
      const view = leaf?.view;
      if (view && typeof view.render === 'function') {
        view.render();
      }
    }
  }

  recomputeOrbitRadiiAllViews() {
    const leaves = this.app.workspace.getLeavesOfType(GRAPHFRONTIER_VIEW_TYPE);
    for (const leaf of leaves) {
      const view = leaf?.view;
      if (view && typeof view.recomputeOrbitRadii === 'function') {
        view.recomputeOrbitRadii();
      }
    }
  }

  // Grouping and suggestions: query parsing, metadata indexing, and suggestion output.
  openBackupsModal() {
    this.openDataSettings();
  }

  openDataSettings() {
    this.app.setting.open();
    this.app.setting.openTabById(this.manifest.id);
  }

  getNodeLists() {
    observeNodeLists(this.owner || this);
    return this.nodeListStore?.lists || EMPTY_NODE_LISTS;
  }

  async updateNodeList(args) {
    if (!this.nodeListStore) throw new Error('Node lists are not available.');
    return this.nodeListStore.update(args);
  }

  nodeListsChanged() {
    this.backups?.schedule();
    for (const type of [GRAPHFRONTIER_VIEW_TYPE, LOCAL_GRAPHFRONTIER_VIEW_TYPE]) {
      for (const leaf of this.app.workspace.getLeavesOfType(type)) {
        const view = leaf.view;
        if (!view?.isOpen) continue;
        view.groupColorCache = null;
        view.appearanceCache = null;
        view.markQueryRuleVisibilityDirty();
        view.nodeListsTab?.render();
        view.queryRuleCountsKey = '';
        view.refreshQueryRuleCounts?.();
        const query = view.searchInputEl?.value ?? view.searchInputValue;
        if (view.parseSearchQuery(query).source === 'list') view.syncSearchMatchesLive();
        if (
          view.plugin.data.groups.some(
            (group) => group.enabled !== false && group.settings?.strong_pull
          )
        )
          view.kickLayoutSearch();
        view.render();
      }
    }
  }

  getGroupVisualSettings(nodeId, context) {
    const leaves =
      context?.leaves ||
      (this.isLocalGraphFrontier
        ? [{ view: this.getScopeView() }]
        : this.app.workspace.getLeavesOfType(GRAPHFRONTIER_VIEW_TYPE));
    if (context) context.leaves = leaves;
    const view = leaves.find((leaf) => leaf.view?.nodeById?.has(nodeId))?.view;
    return view ? getGroupStyleMap(view)?.get(nodeId) : null;
  }

  updateGroups(nextGroups) {
    const pullRules = (groups) =>
      JSON.stringify(
        groups
          .filter((group) => group.settings?.strong_pull != null)
          .map((group) => [
            group.query,
            group.enabled,
            group.settings.strong_pull,
            group.settings.strong_pull_multiplier,
          ])
      );
    const previousPull = pullRules(this.data.groups);
    const normalizedGroups = [];
    if (Array.isArray(nextGroups)) {
      for (const rawGroup of nextGroups) {
        if (!rawGroup || typeof rawGroup !== 'object') continue;
        const query = String(rawGroup.query || '').trim();
        if (!query) continue;
        const color = this.normalizeGroupColor(rawGroup.color);
        normalizedGroups.push({
          id: typeof rawGroup.id === 'string' && rawGroup.id ? rawGroup.id : this.createGroupId(),
          query,
          color,
          enabled: rawGroup.enabled !== false,
          // Hidden groups remove their nodes like blacklist rules; the flag belongs to the layout.
          ...(rawGroup.hidden === true ? { hidden: true } : {}),
          settings: normalizeGroupVisuals(rawGroup.settings),
        });
      }
    }
    // Hidden groups filter nodes, and with Show only groups every group query does.
    const visibilityRules = (groups) =>
      JSON.stringify(
        groups
          .filter((group) => group.hidden || this.getSettings().show_only_groups)
          .map((group) => [group.query, group.hidden, group.enabled])
      );
    const previousVisibility = visibilityRules(this.data.groups);
    this.data.groups = normalizedGroups;
    if (previousVisibility !== visibilityRules(normalizedGroups)) this.markQueryRulesDirty();
    if (previousPull !== pullRules(normalizedGroups))
      for (const view of this.getGraphViews()) view?.kickLayoutSearch();
    this.schedulePersist();
    this.renderAllViews();
  }

  // Switching modes changes only which hidden-group nodes stay in physics.
  setGroupHideMode(mode) {
    const next = mode === 'hide' ? 'hide' : 'exclude';
    if (this.data.settings.group_hide_mode === next) return;
    this.data.settings.group_hide_mode = next;
    for (const view of this.markQueryRulesDirty()) view?.syncGroupHideModeToggleUi?.();
    this.schedulePersist();
    this.renderAllViews();
  }

  normalizeQueryRuleList(nextRules) {
    const normalizedRules = [];
    if (Array.isArray(nextRules)) {
      for (const rawRule of nextRules) {
        if (!rawRule || typeof rawRule !== 'object') continue;
        const query = String(rawRule.query || '').trim();
        if (!query) continue;
        normalizedRules.push({
          id: typeof rawRule.id === 'string' && rawRule.id ? rawRule.id : this.createGroupId(),
          query,
          enabled: rawRule.enabled !== false,
        });
      }
    }
    return normalizedRules;
  }

  updateBlacklist(nextRules) {
    this.data.blacklist = this.normalizeQueryRuleList(nextRules);
    this.schedulePersist();
    this.renderAllViews();
  }

  updateWhitelist(nextRules) {
    this.data.whitelist = this.normalizeQueryRuleList(nextRules);
    this.schedulePersist();
    this.renderAllViews();
  }

  parseGroupQuery(query) {
    const text = String(query || '').trim();
    const plainMatch = /^(name|tag|path|file|line|section|list)\s*:\s*(.*)$/i.exec(text);
    if (plainMatch) {
      return {
        type: plainMatch[1].toLowerCase(),
        value: String(plainMatch[2] || '').trim(),
      };
    }
    const propertyMatch = /^\[([^\]]+)\]\s*:\s*(.*)$/i.exec(text);
    if (propertyMatch) {
      return {
        type: 'property',
        propertyKey: String(propertyMatch[1] || '')
          .trim()
          .toLowerCase(),
        value: String(propertyMatch[2] || '').trim(),
      };
    }
    return null;
  }

  composeGroupQuery(type, value, propertyKey = '') {
    const cleanType = String(type || '')
      .trim()
      .toLowerCase();
    const cleanValue = String(value || '').trim();
    const cleanPropertyKey = String(propertyKey || '')
      .trim()
      .toLowerCase();
    if (!cleanType || !cleanValue) return '';
    if (cleanType === 'property') {
      if (!cleanPropertyKey) return '';
      return `[${cleanPropertyKey}]:${cleanValue}`;
    }
    if (!['name', 'tag', 'path', 'file', 'line', 'section', 'list'].includes(cleanType)) return '';
    return `${cleanType}:${cleanValue}`;
  }

  getGroupSuggestions(query, limit = 30) {
    const suggestions = [];
    const text = String(query || '').trim();
    const index =
      this.groupSuggestionIndex ||
      this.buildGroupSuggestionIndex(this.app.vault.getMarkdownFiles());

    const addSuggestions = (items, prefix) => {
      const sorted = Array.from(items).sort((a, b) => a.localeCompare(b));
      for (const item of sorted) {
        if (suggestions.length >= limit) break;
        const full = `${prefix}${item}`;
        if (!text || full.toLowerCase().includes(text.toLowerCase())) suggestions.push(full);
      }
    };

    const parsed = this.parseGroupQuery(text);
    if (!parsed) {
      addSuggestions(index.tags, 'tag:');
      addSuggestions(index.paths, 'path:');
      addSuggestions(index.files, 'file:');
      addSuggestions(index.sections, 'section:');
      for (const key of Array.from(index.properties.keys()).sort((a, b) => a.localeCompare(b))) {
        addSuggestions(index.properties.get(key) || new Set(), `[${key}]:`);
      }
      return suggestions.slice(0, limit);
    }

    if (parsed.type === 'tag') addSuggestions(index.tags, 'tag:');
    if (parsed.type === 'path') addSuggestions(index.paths, 'path:');
    if (parsed.type === 'file') addSuggestions(index.files, 'file:');
    if (parsed.type === 'section') addSuggestions(index.sections, 'section:');
    if (parsed.type === 'property') {
      const key = parsed.propertyKey || '';
      const options = index.properties.get(key) || new Set();
      addSuggestions(options, `[${key}]:`);
    }

    return suggestions.slice(0, limit);
  }

  getGroupPropertyKeySuggestions(query = '', limit = 40) {
    const text = String(query || '')
      .trim()
      .toLowerCase();
    const index =
      this.groupSuggestionIndex ||
      this.buildGroupSuggestionIndex(this.app.vault.getMarkdownFiles());
    const keys = Array.from(index.properties.keys()).sort((a, b) => a.localeCompare(b));
    const filtered = [];
    for (const key of keys) {
      if (filtered.length >= limit) break;
      if (!text || key.toLowerCase().includes(text)) filtered.push(key);
    }
    return filtered;
  }

  getGroupValueSuggestions(type, query = '', propertyKey = '', limit = 40) {
    if (type === 'list')
      return this.getNodeLists()
        .filter((list) =>
          `${list.id} ${list.name}`.toLowerCase().includes(String(query).toLowerCase())
        )
        .slice(0, limit)
        .map((list) => list.id);
    const cleanType = String(type || '')
      .trim()
      .toLowerCase();
    const text = String(query || '')
      .trim()
      .toLowerCase();
    const index =
      this.groupSuggestionIndex ||
      this.buildGroupSuggestionIndex(this.app.vault.getMarkdownFiles());

    let items = [];
    if (cleanType === 'tag') items = Array.from(index.tags);
    else if (cleanType === 'path') items = Array.from(index.paths);
    else if (cleanType === 'file') items = Array.from(index.files);
    else if (cleanType === 'section') items = Array.from(index.sections);
    else if (cleanType === 'property') {
      const cleanKey = String(propertyKey || '')
        .trim()
        .toLowerCase();
      if (!cleanKey) return [];
      items = Array.from(index.properties.get(cleanKey) || []);
    } else {
      return [];
    }

    items.sort((a, b) => String(a).localeCompare(String(b)));
    const filtered = [];
    for (const item of items) {
      if (filtered.length >= limit) break;
      const textItem = String(item || '');
      if (!text || textItem.toLowerCase().includes(text)) filtered.push(textItem);
    }
    return filtered;
  }

  buildGroupSuggestionIndex(markdownFiles) {
    const index = {
      tags: new Set(),
      paths: new Set(),
      files: new Set(),
      sections: new Set(),
      properties: new Map(),
    };

    for (const file of markdownFiles) {
      const meta = this.buildNodeMetaByPath(file.path, file);
      index.paths.add(file.path);
      index.files.add(file.basename);
      for (const tag of meta.tags) index.tags.add(tag);
      for (const section of meta.sections) index.sections.add(section);
      for (const [key, values] of meta.properties.entries()) {
        if (!index.properties.has(key)) index.properties.set(key, new Set());
        const bucket = index.properties.get(key);
        for (const value of values) bucket.add(value);
      }
    }

    return index;
  }

  buildNodeMetaByPath(path, abstractFile = null, options = {}) {
    const file = abstractFile || this.app.vault.getAbstractFileByPath(path);
    const forcedAttachment = options && options.isAttachment === true;
    const pathText = String(path || '');
    const fallbackExtMatch = /\.([^.\/]+)$/u.exec(pathText);
    const fallbackExt = fallbackExtMatch ? String(fallbackExtMatch[1] || '').toLowerCase() : '';
    const fileExt = typeof file?.extension === 'string' ? file.extension.toLowerCase() : '';
    const meta = {
      path,
      fileName:
        typeof file?.basename === 'string'
          ? file.basename
          : String(path).split('/').pop() || String(path),
      tags: [],
      sections: [],
      lines: [],
      properties: new Map(),
      isAttachment: forcedAttachment,
      fileType: fileExt || fallbackExt || (forcedAttachment ? 'attachment' : 'md'),
    };

    if (!file || typeof file.extension !== 'string' || file.extension.toLowerCase() !== 'md') {
      if (file && typeof file.extension === 'string' && file.extension.toLowerCase() !== 'md') {
        meta.isAttachment = true;
      }
      if (!meta.fileType) meta.fileType = meta.isAttachment ? 'attachment' : 'file';
      return meta;
    }
    meta.isAttachment = false;
    meta.fileType = 'md';
    meta.lines = this.noteLines?.get(path)?.lines || [];

    const cache = this.app.metadataCache.getFileCache(file) || {};
    const tags = new Set();
    if (Array.isArray(cache.tags)) {
      for (const tagObj of cache.tags) {
        if (!tagObj || typeof tagObj.tag !== 'string') continue;
        tags.add(tagObj.tag.replace(/^#/, ''));
      }
    }
    const fm = cache.frontmatter && typeof cache.frontmatter === 'object' ? cache.frontmatter : {};
    const fmTags = fm.tags;
    if (Array.isArray(fmTags)) {
      for (const tag of fmTags) {
        const text = String(tag || '')
          .replace(/^#/, '')
          .trim();
        if (text) tags.add(text);
      }
    } else if (typeof fmTags === 'string') {
      for (const piece of fmTags.split(/[, ]+/)) {
        const text = piece.replace(/^#/, '').trim();
        if (text) tags.add(text);
      }
    }
    meta.tags = Array.from(tags);

    if (Array.isArray(cache.headings)) {
      for (const heading of cache.headings) {
        if (!heading) continue;
        if (typeof heading.heading === 'string' && heading.heading.trim()) {
          meta.sections.push(heading.heading.trim());
        }
      }
    }

    for (const [rawKey, rawValue] of Object.entries(fm)) {
      const key = String(rawKey || '')
        .trim()
        .toLowerCase();
      if (!key || key === 'position') continue;
      if (!meta.properties.has(key)) meta.properties.set(key, []);
      const bucket = meta.properties.get(key);
      if (Array.isArray(rawValue)) {
        for (const item of rawValue) {
          const text = String(item ?? '').trim();
          if (text) bucket.push(text);
        }
      } else {
        const text = String(rawValue ?? '').trim();
        if (text) bucket.push(text);
      }
    }

    return meta;
  }

  getAttachmentExtensionInventory() {
    const counts = new Map();
    for (const file of this.app.vault.getFiles()) {
      if (typeof file.extension !== 'string') continue;
      const extension = file.extension.toLowerCase();
      if (extension === 'md') continue;
      counts.set(extension, (counts.get(extension) || 0) + 1);
    }
    return [...counts].sort(([a], [b]) => a.localeCompare(b));
  }

  // Note text for `line:` queries is read only after one is first used; a note is read again
  // when its modification time changes, and the graph refreshes once the text is in.
  requestNoteLines() {
    if (this.noteLinesWanted) return;
    this.noteLinesWanted = true;
    this.noteLines = new Map();
    this.scheduleRefreshAllViews({ passive: true });
  }

  async readNoteLines(files) {
    if (this.noteLinesReading) return;
    this.noteLinesReading = true;
    try {
      for (const file of files) {
        let text = '';
        try {
          text = await this.app.vault.cachedRead(file);
        } catch {
          // An unreadable note simply has no lines to match.
        }
        this.noteLines.set(file.path, {
          mtime: file.stat?.mtime,
          lines: String(text || '')
            .toLowerCase()
            .split(/\r?\n/),
        });
      }
    } finally {
      this.noteLinesReading = false;
    }
    // The refresh also picks up notes that changed while these were read.
    this.scheduleRefreshAllViews({ passive: true });
  }

  // Graph-data builder: assemble nodes/edges from markdown, links, and filter settings.
  collectGraphData() {
    const settings = this.getSettings();
    const includeAttachments = !settings.hide_attachments;
    const excludedExtensions = new Set(
      normalizeAttachmentExtensions(settings.excluded_attachment_extensions)
    );
    const hideOrphans = !!settings.hide_orphans;
    const existingFilesOnly = !!settings.existing_files_only;

    const markdownFiles = this.app.vault.getMarkdownFiles();
    const markdownSet = new Set();
    const nodeMap = new Map();

    const staleNotes = [];
    for (const file of markdownFiles) {
      markdownSet.add(file.path);
      if (this.noteLinesWanted && this.noteLines.get(file.path)?.mtime !== file.stat?.mtime)
        staleNotes.push(file);
      nodeMap.set(file.path, {
        id: file.path,
        label: file.basename,
        meta: this.buildNodeMetaByPath(file.path, file, { isAttachment: false }),
      });
    }
    if (this.noteLinesWanted) {
      for (const path of this.noteLines.keys())
        if (!markdownSet.has(path)) this.noteLines.delete(path);
      if (staleNotes.length) this.readNoteLines(staleNotes);
    }

    const addNodeIfMissing = (nodeId, label, options = {}) => {
      if (nodeMap.has(nodeId)) return;
      nodeMap.set(nodeId, {
        id: nodeId,
        label,
        meta: this.buildNodeMetaByPath(nodeId, null, {
          isAttachment: options.isAttachment === true,
        }),
      });
    };

    if (includeAttachments && settings.include_unlinked_attachments) {
      for (const file of this.app.vault.getFiles()) {
        if (file.extension.toLowerCase() === 'md') continue;
        if (excludedExtensions.has(file.extension.toLowerCase())) continue;
        addNodeIfMissing(file.path, file.basename, { isAttachment: true });
      }
    }

    const edgeSet = new Map();
    const edges = [];
    const touchedNodeIds = new Set();
    const resolved = this.app.metadataCache.resolvedLinks || {};
    // Links to missing files are kept apart, keyed by link text, as in the core graph.
    const unresolved = existingFilesOnly ? {} : this.app.metadataCache.unresolvedLinks || {};

    for (const [sourcePath, targets] of [
      ...Object.entries(resolved),
      ...Object.entries(unresolved),
    ]) {
      if (!markdownSet.has(sourcePath)) continue;
      if (!targets || typeof targets !== 'object') continue;

      for (const targetPath of Object.keys(targets)) {
        if (sourcePath === targetPath) continue;

        const targetAbs = this.app.vault.getAbstractFileByPath(targetPath);
        const targetExists = !!targetAbs && typeof targetAbs.path === 'string';
        const targetExt =
          targetExists && typeof targetAbs.extension === 'string'
            ? targetAbs.extension.toLowerCase()
            : '';
        const isAttachmentExisting =
          targetExists && typeof targetAbs.extension === 'string' && targetExt !== 'md';

        const unresolvedExtMatch = /(?:\.([^.\/]+))$/u.exec(targetPath);
        const unresolvedExt = unresolvedExtMatch ? unresolvedExtMatch[1].toLowerCase() : '';
        const isAttachmentUnresolved =
          !targetExists && unresolvedExt !== '' && unresolvedExt !== 'md';

        if (!includeAttachments && (isAttachmentExisting || isAttachmentUnresolved)) continue;
        if (
          (isAttachmentExisting || isAttachmentUnresolved) &&
          excludedExtensions.has(targetExists ? targetExt : unresolvedExt)
        )
          continue;
        if (existingFilesOnly && !targetExists) continue;

        const targetIsMarkdown = targetExists ? targetExt === 'md' : !isAttachmentUnresolved;
        if (!targetIsMarkdown && !includeAttachments) continue;

        const targetLabel =
          targetExists && typeof targetAbs.basename === 'string'
            ? targetAbs.basename
            : targetPath.split('/').pop() || targetPath;

        addNodeIfMissing(targetPath, targetLabel, {
          isAttachment: isAttachmentExisting || isAttachmentUnresolved,
        });

        const pair =
          sourcePath < targetPath
            ? `${sourcePath}\u0000${targetPath}`
            : `${targetPath}\u0000${sourcePath}`;

        const existing = edgeSet.get(pair);
        if (existing) {
          if (existing.source !== sourcePath) existing.bidirectional = true;
          continue;
        }
        const edge = {
          source: sourcePath,
          target: targetPath,
        };
        edgeSet.set(pair, edge);
        edges.push(edge);
        touchedNodeIds.add(sourcePath);
        touchedNodeIds.add(targetPath);
      }
    }

    let nodes = Array.from(nodeMap.values());
    let filteredEdges = edges;

    if (hideOrphans) {
      const keepIds = touchedNodeIds;
      nodes = nodes.filter((node) => keepIds.has(node.id));
      const keepSet = new Set(nodes.map((node) => node.id));
      filteredEdges = edges.filter((edge) => keepSet.has(edge.source) && keepSet.has(edge.target));
    }

    this.groupSuggestionIndex = this.buildGroupSuggestionIndex(markdownFiles);
    nodes.push(...darkEnergyNodes(this.data.dark_energy));
    nodes.push(...subgraphNodes(this.data.subgraphs));
    return { nodes, edges: filteredEdges };
  }

  // View control: get active GraphFrontier view or open one if missing.
  getActiveGraphFrontierView() {
    const activeLeaf = this.app.workspace.activeLeaf;
    if (
      [GRAPHFRONTIER_VIEW_TYPE, LOCAL_GRAPHFRONTIER_VIEW_TYPE].includes(
        activeLeaf?.view?.getViewType?.()
      )
    ) {
      return activeLeaf.view;
    }
    const leaf = this.app.workspace.getLeavesOfType(GRAPHFRONTIER_VIEW_TYPE)[0];
    return leaf?.view || null;
  }

  followLocalGraphFile(file) {
    if (!file || String(file.extension || '').toLowerCase() !== 'md') return;
    for (const leaf of this.app.workspace.getLeavesOfType(LOCAL_GRAPHFRONTIER_VIEW_TYPE)) {
      leaf.view?.followFile(file);
    }
  }

  async openLocalGraphFrontierView(file = this.app.workspace.getActiveFile()) {
    if (!file || String(file.extension || '').toLowerCase() !== 'md') {
      new Notice('Open a Markdown note first');
      return;
    }
    const workspace = this.app.workspace;
    let leaf = workspace.getLeavesOfType(LOCAL_GRAPHFRONTIER_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf('split');
      this.pendingLocalFiles ||= new WeakMap();
      this.pendingLocalFiles.set(leaf, file.path);
      try {
        await leaf.setViewState({ type: LOCAL_GRAPHFRONTIER_VIEW_TYPE, active: true });
      } finally {
        this.pendingLocalFiles.delete(leaf);
      }
    }
    leaf.view?.followFile(file);
    await workspace.revealLeaf(leaf);
  }

  async openOrRevealGraphFrontierView() {
    const existingLeaf = this.app.workspace.getLeavesOfType(GRAPHFRONTIER_VIEW_TYPE)[0];
    const leaf =
      existingLeaf || this.app.workspace.getLeaf('tab') || this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: GRAPHFRONTIER_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);

    const view = leaf?.view;
    if (!view || view.getViewType?.() !== GRAPHFRONTIER_VIEW_TYPE) return;
    if (typeof view.centerCameraOnActiveFileNode !== 'function') return;
    if (view.centerCameraOnActiveFileNode()) {
      view.render?.();
      view.persistViewState?.();
    }
  }
};
