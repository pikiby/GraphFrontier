const {
  Plugin,
  Notice,
} = require('obsidian');

const {
  GRAPHFRONTIER_VIEW_TYPE,
  NODE_MULTIPLIER_MIN,
  NODE_MULTIPLIER_MAX,
  ZOOM_STEP_FACTOR,
  DEFAULT_DATA,
  MIN_ZOOM,
  MAX_ZOOM,
  HOTKEY_COMMANDS,
  HOTKEY_COMMAND_IDS,
  HOTKEY_MODIFIER_KEYS,
  HOTKEY_KEY_ALIASES,
} = require('./constants');

const { GraphFrontierView } = require('./view');

// Register all Command Palette / hotkey actions in one place to keep plugin boot logic compact.
function registerGraphFrontierCommands(plugin) {
  plugin.addCommand({
    id: 'graphfrontier-open-view',
    name: 'Open GraphFrontier',
    callback: () => plugin.openOrRevealGraphFrontierView(),
  });

  // Cursor-targeted actions: resolve active GraphFrontier view first, then run the matching handler.
  const viewActions = [
    { id: 'graphfrontier-toggle-pin-under-cursor', name: 'Toggle pin under cursor', method: 'togglePinUnderCursor' },
    { id: 'graphfrontier-set-force-multiplier-under-cursor', name: 'Set force multiplier under cursor', method: 'promptSetMultiplierUnderCursor' },
    { id: 'graphfrontier-clear-force-multiplier-under-cursor', name: 'Clear force multiplier under cursor', method: 'clearMultiplierUnderCursor' },
    { id: 'graphfrontier-align-pins-to-grid', name: 'Align pins to grid', method: 'alignPinsToGrid' },
    { id: 'graphfrontier-pin-node-under-cursor', name: 'Pin node under cursor', method: 'commandPinNode' },
    { id: 'graphfrontier-pin-to-grid-under-cursor', name: 'Pin node to grid under cursor', method: 'commandPinToGrid' },
    { id: 'graphfrontier-unpin-node-under-cursor', name: 'Unpin node under cursor', method: 'commandUnpinNode' },
    { id: 'graphfrontier-pin-linked-to-orbit-under-cursor', name: 'Pin linked to orbit under cursor', method: 'commandPinLinkedToOrbit' },
    { id: 'graphfrontier-unpin-linked-nodes-under-cursor', name: 'Unpin linked nodes under cursor', method: 'commandUnpinLinkedNodes' },
    { id: 'graphfrontier-add-to-search-under-cursor', name: 'Add to search under cursor', method: 'commandAddToSearch' },
    { id: 'graphfrontier-show-local-graph-under-cursor', name: 'Show local graph under cursor', method: 'commandShowLocalGraph' },
    { id: 'graphfrontier-pin-linked-nodes-under-cursor', name: 'Pin linked nodes under cursor', method: 'commandPinLinkedNodes' },
    { id: 'graphfrontier-pin-linked-nodes-to-grid-under-cursor', name: 'Pin linked nodes to grid under cursor', method: 'commandPinLinkedNodesToGrid' },
    { id: 'graphfrontier-paint-edges-under-cursor', name: 'Paint edges under cursor', method: 'commandPaintEdges' },
    { id: 'graphfrontier-clear-painted-edges-under-cursor', name: 'Clear painted edges under cursor', method: 'commandClearPaintedEdges' },
    { id: 'graphfrontier-strong-pull-under-cursor', name: 'Strong pull under cursor', method: 'commandStrongPull' },
    { id: 'graphfrontier-clear-strong-pull-under-cursor', name: 'Clear strong pull under cursor', method: 'commandClearStrongPull' },
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
        await handler.call(view);
      },
    });
  }
}

// Register all data/layout change listeners that trigger a graph refresh.
function registerGraphFrontierRefreshEvents(plugin) {
  plugin.registerEvent(plugin.app.metadataCache.on('resolved', () => plugin.scheduleRefreshAllViews()));
  plugin.registerEvent(plugin.app.vault.on('create', () => plugin.scheduleRefreshAllViews()));
  plugin.registerEvent(plugin.app.vault.on('modify', () => plugin.scheduleRefreshAllViews()));
  plugin.registerEvent(plugin.app.vault.on('delete', () => plugin.scheduleRefreshAllViews()));
  plugin.registerEvent(plugin.app.vault.on('rename', () => plugin.scheduleRefreshAllViews()));
  plugin.registerEvent(plugin.app.workspace.on('layout-change', () => plugin.scheduleRefreshAllViews()));
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
    if (part === 'mod' || part === 'cmd' || part === 'command' || part === 'ctrl' || part === 'control' || part === 'meta') {
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
    const loadedData = await this.loadData();
    this.data = this.normalizeData(loadedData);
    this._persistTimer = null;
    this._refreshTimer = null;

    // UI entry point: ribbon icon opens GraphFrontier view.
    this.addRibbonIcon('orbit', 'Open GraphFrontier', () => this.openOrRevealGraphFrontierView());

    // Register plugin commands for Command Palette and custom hotkeys.
    registerGraphFrontierCommands(this);

    // Register custom view type that renders the graph.
    this.registerView(
      GRAPHFRONTIER_VIEW_TYPE,
      (leaf) => new GraphFrontierView(leaf, this),
    );

    // Subscribe to vault/workspace changes and refresh all open GraphFrontier views.
    registerGraphFrontierRefreshEvents(this);
  }

  onunload() {
    if (this._persistTimer) window.clearTimeout(this._persistTimer);
    if (this._refreshTimer) window.clearTimeout(this._refreshTimer);
  }

  // Persisted-data normalization: sanitize and repair loaded state before use.
  normalizeData(data) {
    const safe = data && typeof data === 'object' ? data : {};

    const pins = safe.pins && typeof safe.pins === 'object' ? safe.pins : {};
    const orbitPins = safe.orbit_pins && typeof safe.orbit_pins === 'object' ? safe.orbit_pins : {};
    const savedPositions = safe.saved_positions && typeof safe.saved_positions === 'object' ? safe.saved_positions : {};
    const savedLayoutSettings = safe.saved_layout_settings && typeof safe.saved_layout_settings === 'object'
      ? safe.saved_layout_settings
      : {};
    const savedLayoutPins = safe.saved_layout_pins && typeof safe.saved_layout_pins === 'object'
      ? safe.saved_layout_pins
      : {};
    const savedLayoutOrbitPins = safe.saved_layout_orbit_pins && typeof safe.saved_layout_orbit_pins === 'object'
      ? safe.saved_layout_orbit_pins
      : {};
    const multipliers = safe.node_force_multipliers && typeof safe.node_force_multipliers === 'object'
      ? safe.node_force_multipliers
      : {};
    const strongPullNodes = safe.strong_pull_nodes && typeof safe.strong_pull_nodes === 'object'
      ? safe.strong_pull_nodes
      : {};
    const paintedEdgeColors = safe.painted_edge_colors && typeof safe.painted_edge_colors === 'object'
      ? safe.painted_edge_colors
      : {};
    const rawGroups = Array.isArray(safe.groups) ? safe.groups : [];
    const rawHotkeys = safe.hotkeys && typeof safe.hotkeys === 'object' ? safe.hotkeys : {};
    const settings = safe.settings && typeof safe.settings === 'object' ? safe.settings : {};
    const viewState = safe.view_state && typeof safe.view_state === 'object' ? safe.view_state : {};

    const normalized = {
      pins: {},
      orbit_pins: {},
      saved_positions: {},
      saved_layout_settings: {},
      saved_layout_pins: {},
      saved_layout_orbit_pins: {},
      node_force_multipliers: {},
      strong_pull_nodes: {},
      painted_edge_colors: {},
      groups: [],
      hotkeys: {},
      settings: Object.assign({}, DEFAULT_DATA.settings, settings),
      view_state: Object.assign({}, DEFAULT_DATA.view_state, viewState),
    };

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
    // Backward compatibility: old link strength stored as tiny float (e.g. 0.001 -> new scale 40).
    if (Number(normalized.settings.base_link_strength) < 1) {
      normalized.settings.base_link_strength = Number(normalized.settings.base_link_strength) / 0.000025;
    }
    normalized.settings.base_link_strength = this.clampNumber(normalized.settings.base_link_strength, 1, 100, DEFAULT_DATA.settings.base_link_strength);
    normalized.settings.link_distance = this.clampNumber(normalized.settings.link_distance, 1, 100, DEFAULT_DATA.settings.link_distance);
    normalized.settings.repel_strength = this.clampNumber(normalized.settings.repel_strength, 0, 100, DEFAULT_DATA.settings.repel_strength);
    normalized.settings.repel_radius = this.clampNumber(
      normalized.settings.repel_radius,
      20,
      200,
      DEFAULT_DATA.settings.repel_radius,
    );
    // Backward compatibility: old center strength (e.g. 0.0001 -> new scale 10).
    if (Number(normalized.settings.center_strength) < 1) {
      normalized.settings.center_strength = Number(normalized.settings.center_strength) / 0.00001;
    }
    normalized.settings.center_strength = this.clampNumber(normalized.settings.center_strength, 0, 100, DEFAULT_DATA.settings.center_strength);
    normalized.settings.damping = this.clampNumber(normalized.settings.damping, 0.01, 0.9, DEFAULT_DATA.settings.damping);
    normalized.settings.node_size_scale = this.clampNumber(normalized.settings.node_size_scale, 0.1, 2, DEFAULT_DATA.settings.node_size_scale);
    normalized.settings.edge_width_scale = this.clampNumber(normalized.settings.edge_width_scale, 0.01, 1, DEFAULT_DATA.settings.edge_width_scale);
    normalized.settings.painted_edge_width = this.clampNumber(
      normalized.settings.painted_edge_width,
      0.01,
      1,
      DEFAULT_DATA.settings.painted_edge_width,
    );
    if (normalized.settings.label_zoom_steps == null && settings.label_min_zoom != null) {
      const legacySlider = this.clampNumber(settings.label_min_zoom, 0.01, 1, 0.35);
      const legacyThreshold = this.clampNumber(1.01 - legacySlider, MIN_ZOOM, MAX_ZOOM, 1);
      const legacySteps = Math.round(Math.log(MAX_ZOOM / legacyThreshold) / Math.log(ZOOM_STEP_FACTOR)) + 1;
      normalized.settings.label_zoom_steps = legacySteps;
    }
    normalized.settings.label_zoom_steps = this.clampNumber(
      normalized.settings.label_zoom_steps,
      1,
      20,
      DEFAULT_DATA.settings.label_zoom_steps,
    );
    normalized.settings.label_font_size = this.clampNumber(normalized.settings.label_font_size, 5, 20, DEFAULT_DATA.settings.label_font_size);
    normalized.settings.hover_dim_strength = this.clampNumber(
      normalized.settings.hover_dim_strength,
      0,
      100,
      DEFAULT_DATA.settings.hover_dim_strength,
    );
    normalized.settings.strong_pull_multiplier = this.clampNumber(
      normalized.settings.strong_pull_multiplier,
      NODE_MULTIPLIER_MIN,
      NODE_MULTIPLIER_MAX,
      DEFAULT_DATA.settings.strong_pull_multiplier,
    );
    const hasOrbitDistanceSetting = settings.orbit_distance != null;
    let orbitDistanceSetting = Number(normalized.settings.orbit_distance);
    if (!hasOrbitDistanceSetting && settings.orbit_distance_multiplier != null) {
      const legacyOrbitDistanceMultiplier = this.clampNumber(
        settings.orbit_distance_multiplier,
        0.1,
        2,
        0.2,
      );
      orbitDistanceSetting = normalized.settings.link_distance * legacyOrbitDistanceMultiplier;
    }
    normalized.settings.orbit_distance = this.clampNumber(
      orbitDistanceSetting,
      1,
      100,
      DEFAULT_DATA.settings.orbit_distance,
    );
    normalized.settings.attachment_size_multiplier = this.clampNumber(
      normalized.settings.attachment_size_multiplier,
      0.1,
      1,
      DEFAULT_DATA.settings.attachment_size_multiplier,
    );
    let attachmentLinkDistanceSetting = Number(normalized.settings.attachment_link_distance_multiplier);
    if (
      Number.isFinite(attachmentLinkDistanceSetting)
      && attachmentLinkDistanceSetting > 0
      && attachmentLinkDistanceSetting <= 1
    ) {
      attachmentLinkDistanceSetting *= normalized.settings.link_distance;
    }
    normalized.settings.attachment_link_distance_multiplier = this.clampNumber(
      attachmentLinkDistanceSetting,
      1,
      100,
      DEFAULT_DATA.settings.attachment_link_distance_multiplier,
    );
    normalized.settings.show_grid = !!normalized.settings.show_grid;
    normalized.settings.hide_orphans = !!normalized.settings.hide_orphans;
    normalized.settings.hide_attachments = !!normalized.settings.hide_attachments;
    normalized.settings.existing_files_only = !!normalized.settings.existing_files_only;
    normalized.settings.search_mode = (
      normalized.settings.search_mode === 'filter'
      || normalized.settings.search_mode === 'filtr'
    ) ? 'filter' : 'find';
    normalized.settings.quick_pick_modifier = ['alt', 'ctrl', 'meta', 'shift', 'none'].includes(normalized.settings.quick_pick_modifier)
      ? normalized.settings.quick_pick_modifier
      : DEFAULT_DATA.settings.quick_pick_modifier;
    normalized.settings.layout_autosave = !!normalized.settings.layout_autosave;
    delete normalized.settings.max_multiplier;
    delete normalized.settings.label_min_zoom;
    delete normalized.settings.orbit_distance_multiplier;

    if (
      Number(settings.base_link_strength) === 0.08
      && Number(settings.link_distance) === 220
      && Number(settings.repel_strength) === 2800
      && Number(settings.center_strength) === 0.015
      && Number(settings.damping) === 0.86
    ) {
      normalized.settings.base_link_strength = DEFAULT_DATA.settings.base_link_strength;
      normalized.settings.link_distance = DEFAULT_DATA.settings.link_distance;
      normalized.settings.repel_strength = DEFAULT_DATA.settings.repel_strength;
      normalized.settings.center_strength = DEFAULT_DATA.settings.center_strength;
      normalized.settings.damping = DEFAULT_DATA.settings.damping;
    }

    for (const [nodeId, rawValue] of Object.entries(multipliers)) {
      const multiplier = this.clampMultiplier(rawValue);
      if (multiplier > 1) normalized.node_force_multipliers[nodeId] = multiplier;
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
    normalized.view_state.zoom = this.clampNumber(normalized.view_state.zoom, MIN_ZOOM, MAX_ZOOM, 1);

    return normalized;
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

  clampMultiplier(value) {
    return this.clampNumber(value, NODE_MULTIPLIER_MIN, NODE_MULTIPLIER_MAX, NODE_MULTIPLIER_MIN);
  }

  clampStrongPullMultiplier(value) {
    return this.clampNumber(value, NODE_MULTIPLIER_MIN, NODE_MULTIPLIER_MAX, DEFAULT_DATA.settings.strong_pull_multiplier);
  }

  clampNumber(value, min, max, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, num));
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
    this.schedulePersist();
  }

  clearCommandHotkey(commandId) {
    if (!this.data.hotkeys?.[commandId]) return;
    delete this.data.hotkeys[commandId];
    this.schedulePersist();
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

  schedulePersist() {
    if (this._persistTimer) window.clearTimeout(this._persistTimer);
    this._persistTimer = window.setTimeout(() => {
      this.saveData(this.data);
    }, 250);
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

  getNodeMultiplier(nodeId) {
    const stored = this.data.node_force_multipliers[nodeId];
    const multiplier = this.clampMultiplier(stored);
    return multiplier > 1 ? multiplier : 1;
  }

  isStrongPullNode(nodeId) {
    return !!this.data.strong_pull_nodes[nodeId];
  }

  setNodeMultiplier(nodeId, value, options = {}) {
    const multiplier = this.clampMultiplier(value);
    if (multiplier <= 1) {
      this.clearNodeMultiplier(nodeId);
      return;
    }
    this.data.node_force_multipliers[nodeId] = multiplier;
    if (options.mode === 'strong-pull') {
      this.data.strong_pull_nodes[nodeId] = true;
    } else if (options.mode === 'manual') {
      delete this.data.strong_pull_nodes[nodeId];
    }
    this.schedulePersist();
  }

  clearNodeMultiplier(nodeId) {
    if (!this.data.node_force_multipliers[nodeId] && !this.data.strong_pull_nodes[nodeId]) return;
    delete this.data.node_force_multipliers[nodeId];
    delete this.data.strong_pull_nodes[nodeId];
    this.schedulePersist();
  }

  applyStrongPullToMarkedNodes() {
    const target = this.clampStrongPullMultiplier(this.data.settings.strong_pull_multiplier);
    for (const nodeId of Object.keys(this.data.strong_pull_nodes)) {
      this.data.node_force_multipliers[nodeId] = target;
    }
    this.schedulePersist();
  }

  getPaintedEdgeColor(nodeId) {
    const colorText = String(this.data.painted_edge_colors?.[nodeId] || '').trim();
    if (!/^#([0-9a-f]{6})$/i.test(colorText)) return null;
    return colorText.toLowerCase();
  }

  setPaintedEdgeColor(nodeId, color) {
    const normalizedColor = this.normalizeGroupColor(color);
    this.data.painted_edge_colors[nodeId] = normalizedColor;
    this.schedulePersist();
  }

  clearPaintedEdgeColor(nodeId) {
    if (!this.data.painted_edge_colors?.[nodeId]) return;
    delete this.data.painted_edge_colors[nodeId];
    this.schedulePersist();
  }

  // View sync across all open GraphFrontier tabs (refresh/render/recompute).
  getSettings() {
    return this.data.settings;
  }

  scheduleRefreshAllViews() {
    if (this._refreshTimer) window.clearTimeout(this._refreshTimer);
    this._refreshTimer = window.setTimeout(() => {
      this.refreshAllViews();
    }, 300);
  }

  refreshAllViews() {
    const leaves = this.app.workspace.getLeavesOfType(GRAPHFRONTIER_VIEW_TYPE);
    for (const leaf of leaves) {
      const view = leaf?.view;
      if (view && typeof view.refreshFromVault === 'function') {
        view.refreshFromVault({ keepCamera: true });
      }
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
  updateGroups(nextGroups) {
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
        });
      }
    }
    this.data.groups = normalizedGroups;
    this.schedulePersist();
    this.renderAllViews();
  }

  parseGroupQuery(query) {
    const text = String(query || '').trim();
    const plainMatch = /^(tag|path|file|line|section)\s*:\s*(.*)$/i.exec(text);
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
        propertyKey: String(propertyMatch[1] || '').trim().toLowerCase(),
        value: String(propertyMatch[2] || '').trim(),
      };
    }
    return null;
  }

  composeGroupQuery(type, value, propertyKey = '') {
    const cleanType = String(type || '').trim().toLowerCase();
    const cleanValue = String(value || '').trim();
    const cleanPropertyKey = String(propertyKey || '').trim().toLowerCase();
    if (!cleanType || !cleanValue) return '';
    if (cleanType === 'property') {
      if (!cleanPropertyKey) return '';
      return `[${cleanPropertyKey}]:${cleanValue}`;
    }
    if (!['tag', 'path', 'file', 'line', 'section'].includes(cleanType)) return '';
    return `${cleanType}:${cleanValue}`;
  }

  getGroupSuggestions(query, limit = 30) {
    const suggestions = [];
    const text = String(query || '').trim();
    const index = this.groupSuggestionIndex || this.buildGroupSuggestionIndex(this.app.vault.getMarkdownFiles());

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
      addSuggestions(index.lines, 'line:');
      for (const key of Array.from(index.properties.keys()).sort((a, b) => a.localeCompare(b))) {
        addSuggestions(index.properties.get(key) || new Set(), `[${key}]:`);
      }
      return suggestions.slice(0, limit);
    }

    if (parsed.type === 'tag') addSuggestions(index.tags, 'tag:');
    if (parsed.type === 'path') addSuggestions(index.paths, 'path:');
    if (parsed.type === 'file') addSuggestions(index.files, 'file:');
    if (parsed.type === 'section') addSuggestions(index.sections, 'section:');
    if (parsed.type === 'line') addSuggestions(index.lines, 'line:');
    if (parsed.type === 'property') {
      const key = parsed.propertyKey || '';
      const options = index.properties.get(key) || new Set();
      addSuggestions(options, `[${key}]:`);
    }

    return suggestions.slice(0, limit);
  }

  getGroupPropertyKeySuggestions(query = '', limit = 40) {
    const text = String(query || '').trim().toLowerCase();
    const index = this.groupSuggestionIndex || this.buildGroupSuggestionIndex(this.app.vault.getMarkdownFiles());
    const keys = Array.from(index.properties.keys()).sort((a, b) => a.localeCompare(b));
    const filtered = [];
    for (const key of keys) {
      if (filtered.length >= limit) break;
      if (!text || key.toLowerCase().includes(text)) filtered.push(key);
    }
    return filtered;
  }

  getGroupValueSuggestions(type, query = '', propertyKey = '', limit = 40) {
    const cleanType = String(type || '').trim().toLowerCase();
    const text = String(query || '').trim().toLowerCase();
    const index = this.groupSuggestionIndex || this.buildGroupSuggestionIndex(this.app.vault.getMarkdownFiles());

    let items = [];
    if (cleanType === 'tag') items = Array.from(index.tags);
    else if (cleanType === 'path') items = Array.from(index.paths);
    else if (cleanType === 'file') items = Array.from(index.files);
    else if (cleanType === 'line') items = Array.from(index.lines);
    else if (cleanType === 'section') items = Array.from(index.sections);
    else if (cleanType === 'property') {
      const cleanKey = String(propertyKey || '').trim().toLowerCase();
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
      lines: new Set(),
      properties: new Map(),
    };

    for (const file of markdownFiles) {
      const meta = this.buildNodeMetaByPath(file.path, file);
      index.paths.add(file.path);
      index.files.add(file.basename);
      for (const tag of meta.tags) index.tags.add(tag);
      for (const section of meta.sections) index.sections.add(section);
      for (const line of meta.lines) index.lines.add(String(line));
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
    const meta = {
      path,
      fileName: typeof file?.basename === 'string' ? file.basename : (String(path).split('/').pop() || String(path)),
      tags: [],
      sections: [],
      lines: [],
      properties: new Map(),
      isAttachment: forcedAttachment,
    };

    if (!file || typeof file.extension !== 'string' || file.extension.toLowerCase() !== 'md') {
      if (file && typeof file.extension === 'string' && file.extension.toLowerCase() !== 'md') {
        meta.isAttachment = true;
      }
      return meta;
    }
    meta.isAttachment = false;

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
        const text = String(tag || '').replace(/^#/, '').trim();
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
        const line = Number(heading?.position?.start?.line);
        if (Number.isFinite(line)) meta.lines.push(String(line + 1));
      }
    }
    if (Array.isArray(cache.sections)) {
      for (const section of cache.sections) {
        const line = Number(section?.position?.start?.line);
        if (Number.isFinite(line)) meta.lines.push(String(line + 1));
      }
    }

    for (const [rawKey, rawValue] of Object.entries(fm)) {
      const key = String(rawKey || '').trim().toLowerCase();
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

    const uniqueLines = new Set(meta.lines);
    meta.lines = Array.from(uniqueLines);
    return meta;
  }

  // Graph-data builder: assemble nodes/edges from markdown, links, and filter settings.
  collectGraphData() {
    const settings = this.getSettings();
    const includeAttachments = !settings.hide_attachments;
    const hideOrphans = !!settings.hide_orphans;
    const existingFilesOnly = !!settings.existing_files_only;

    const markdownFiles = this.app.vault.getMarkdownFiles();
    const markdownSet = new Set();
    const nodeMap = new Map();

    for (const file of markdownFiles) {
      markdownSet.add(file.path);
      nodeMap.set(file.path, {
        id: file.path,
        label: file.basename,
        meta: this.buildNodeMetaByPath(file.path, file, { isAttachment: false }),
      });
    }

    const addNodeIfMissing = (nodeId, label, options = {}) => {
      if (nodeMap.has(nodeId)) return;
      nodeMap.set(nodeId, {
        id: nodeId,
        label,
        meta: this.buildNodeMetaByPath(nodeId, null, { isAttachment: options.isAttachment === true }),
      });
    };

    const edgeSet = new Set();
    const edges = [];
    const touchedNodeIds = new Set();
    const resolved = this.app.metadataCache.resolvedLinks || {};

    for (const [sourcePath, targets] of Object.entries(resolved)) {
      if (!markdownSet.has(sourcePath)) continue;
      if (!targets || typeof targets !== 'object') continue;

      for (const targetPath of Object.keys(targets)) {
        if (sourcePath === targetPath) continue;

        const targetAbs = this.app.vault.getAbstractFileByPath(targetPath);
        const targetExists = !!targetAbs && typeof targetAbs.path === 'string';
        const targetExt = targetExists && typeof targetAbs.extension === 'string'
          ? targetAbs.extension.toLowerCase()
          : '';
        const isAttachmentExisting = targetExists && targetExt !== '' && targetExt !== 'md';

        const unresolvedExtMatch = /(?:\.([^.\/]+))$/u.exec(targetPath);
        const unresolvedExt = unresolvedExtMatch ? unresolvedExtMatch[1].toLowerCase() : '';
        const isAttachmentUnresolved = !targetExists && unresolvedExt !== '' && unresolvedExt !== 'md';

        if (!includeAttachments && (isAttachmentExisting || isAttachmentUnresolved)) continue;
        if (existingFilesOnly && !targetExists) continue;

        const targetIsMarkdown = targetExists ? targetExt === 'md' : !isAttachmentUnresolved;
        if (!targetIsMarkdown && !includeAttachments) continue;

        const targetLabel = targetExists && typeof targetAbs.basename === 'string'
          ? targetAbs.basename
          : targetPath.split('/').pop() || targetPath;

        addNodeIfMissing(targetPath, targetLabel, {
          isAttachment: isAttachmentExisting || isAttachmentUnresolved,
        });

        const pair = sourcePath < targetPath
          ? `${sourcePath}\u0000${targetPath}`
          : `${targetPath}\u0000${sourcePath}`;

        if (edgeSet.has(pair)) continue;
        edgeSet.add(pair);

        edges.push({
          source: sourcePath,
          target: targetPath,
        });
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
    return { nodes, edges: filteredEdges };
  }

  // View control: get active GraphFrontier view or open one if missing.
  getActiveGraphFrontierView() {
    const activeLeaf = this.app.workspace.activeLeaf;
    if (activeLeaf?.view?.getViewType?.() === GRAPHFRONTIER_VIEW_TYPE) {
      return activeLeaf.view;
    }
    const leaf = this.app.workspace.getLeavesOfType(GRAPHFRONTIER_VIEW_TYPE)[0];
    return leaf?.view || null;
  }

  async openOrRevealGraphFrontierView() {
    const existingLeaf = this.app.workspace.getLeavesOfType(GRAPHFRONTIER_VIEW_TYPE)[0];
    const leaf = existingLeaf || this.app.workspace.getLeaf('tab') || this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: GRAPHFRONTIER_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }
};
