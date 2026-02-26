// Core constants and defaults shared by the plugin runtime.
const GRAPHFRONTIER_VIEW_TYPE = 'graphfrontier-view';
const NODE_MULTIPLIER_MIN = 1;
const NODE_MULTIPLIER_MAX = 10;
const ZOOM_STEP_FACTOR = 1.12;
const TWO_PI = Math.PI * 2;

const DEFAULT_DATA = {
  active_layout_name: 'data.json',
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
  blacklist: [],
  whitelist: [],
  hotkeys: {},
  settings: {
    grid_step: 20,
    show_grid: true,
    hide_orphans: true,
    hide_attachments: true,
    existing_files_only: true,
    search_mode: 'find',
    quick_pick_modifier: 'alt',
    node_size_scale: 1,
    edge_width_scale: 0.34,
    painted_edge_width: 0.2,
    label_zoom_steps: 10,
    label_font_size: 9,
    hover_dim_strength: 80,
    strong_pull_multiplier: 5,
    orbit_distance: 48,
    attachment_size_multiplier: 1,
    attachment_link_distance_multiplier: 20,
    base_link_strength: 46,
    link_distance: 24,
    repel_strength: 51,
    repel_radius: 265,
    center_strength: 52,
    damping: 0.18,
    layout_autosave: false,
  },
  view_state: {
    pan_x: 0,
    pan_y: 0,
    zoom: 1,
  },
};

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 12;

const HOTKEY_COMMANDS = [
  { id: 'graphfrontier-open-view', name: 'Open GraphFrontier' },
  { id: 'graphfrontier-toggle-pin-under-cursor', name: 'Toggle pin under cursor' },
  {
    id: 'graphfrontier-set-force-multiplier-under-cursor',
    name: 'Set force multiplier under cursor',
  },
  {
    id: 'graphfrontier-clear-force-multiplier-under-cursor',
    name: 'Clear force multiplier under cursor',
  },
  { id: 'graphfrontier-align-pins-to-grid', name: 'Align pins to grid' },
  { id: 'graphfrontier-pin-node-under-cursor', name: 'Pin node under cursor' },
  { id: 'graphfrontier-pin-to-grid-under-cursor', name: 'Pin node to grid under cursor' },
  { id: 'graphfrontier-unpin-node-under-cursor', name: 'Unpin node under cursor' },
  {
    id: 'graphfrontier-pin-linked-to-orbit-under-cursor',
    name: 'Pin linked to orbit under cursor',
  },
  { id: 'graphfrontier-unpin-linked-nodes-under-cursor', name: 'Unpin linked nodes under cursor' },
  { id: 'graphfrontier-paint-edges-under-cursor', name: 'Paint edges under cursor' },
  {
    id: 'graphfrontier-clear-painted-edges-under-cursor',
    name: 'Clear painted edges under cursor',
  },
  { id: 'graphfrontier-strong-pull-under-cursor', name: 'Strong pull under cursor' },
  { id: 'graphfrontier-clear-strong-pull-under-cursor', name: 'Clear strong pull under cursor' },
  { id: 'graphfrontier-save-layout', name: 'Save layout' },
  { id: 'graphfrontier-load-layout', name: 'Load layout' },
  { id: 'graphfrontier-pin-all', name: 'Pin all nodes' },
  { id: 'graphfrontier-unpin-all', name: 'Unpin all nodes' },
];

const HOTKEY_COMMAND_IDS = new Set(HOTKEY_COMMANDS.map((commandMeta) => commandMeta.id));
const HOTKEY_MODIFIER_KEYS = new Set(['control', 'shift', 'alt', 'meta', 'mod']);
const HOTKEY_KEY_ALIASES = {
  esc: 'Escape',
  escape: 'Escape',
  enter: 'Enter',
  return: 'Enter',
  tab: 'Tab',
  space: 'Space',
  spacebar: 'Space',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  plus: '+',
  minus: '-',
};

module.exports = {
  GRAPHFRONTIER_VIEW_TYPE,
  NODE_MULTIPLIER_MIN,
  NODE_MULTIPLIER_MAX,
  ZOOM_STEP_FACTOR,
  TWO_PI,
  DEFAULT_DATA,
  MIN_ZOOM,
  MAX_ZOOM,
  HOTKEY_COMMANDS,
  HOTKEY_COMMAND_IDS,
  HOTKEY_MODIFIER_KEYS,
  HOTKEY_KEY_ALIASES,
};
