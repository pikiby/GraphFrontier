const { z } = require('./schema-runtime');
const { DEFAULT_DATA, MIN_ZOOM, MAX_ZOOM, HOTKEY_COMMANDS } = require('./constants');
const { NODE_VISUAL_SETTINGS } = require('./node-visuals');

const color = z.string().regex(/^#[0-9a-f]{6}$/i);
const number = (min, max) => z.number().finite().min(min).max(max);
const id = z.string().min(1).max(4096);
const ids = z.array(id).max(500);
const position = { x: number(-1e7, 1e7), y: number(-1e7, 1e7) };
const ref = { viewId: z.string().min(1).max(200), contextToken: z.string().min(1).max(300) };
const readRef = { ...ref, contextToken: ref.contextToken.optional() };
const page = {
  offset: z.number().int().nonnegative().optional(),
  limit: number(1, 500).int().optional(),
};
const visuals = Object.fromEntries(
  NODE_VISUAL_SETTINGS.map((s) => [s.key, s.type === 'color' ? color : number(s.min, s.max)])
);
const settings = Object.fromEntries(
  Object.entries(DEFAULT_DATA.settings).map(([key, value]) => [
    key,
    typeof value === 'boolean'
      ? z.boolean()
      : typeof value === 'string'
        ? z.string().max(4096)
        : z.number().finite(),
  ])
);
Object.assign(settings, visuals, {
  attachment_node_color: color.nullable(),
  excluded_attachment_extensions: z.array(z.string().max(4096)).max(4096),
  grid_step: number(5, 50).multipleOf(5),
  grid_line_width: number(0.1, 1).multipleOf(0.1),
  base_link_strength: number(1, 100),
  link_distance: number(1, 50),
  repel_strength: number(0, 200),
  repel_radius: number(20, 1000),
  center_strength: number(1, 100),
  damping: number(0.01, 0.9),
  strong_pull_multiplier: number(1, 10),
  orbit_distance: number(1, 100),
  search_mode: z.enum(['find', 'filter']),
});
for (const key of ['quick_pick_modifier', 'selection_box_modifier', 'selection_toggle_modifier'])
  settings[key] = z.enum(['alt', 'ctrl', 'meta', 'shift', 'none']);
const patch = (shape) => z.object(shape).partial().strict();
const rule = z
  .object({
    id: id.optional(),
    query: z.string().min(1).max(4096).optional(),
    enabled: z.boolean().optional(),
    color: color.optional(),
  })
  .strict();
const layoutName = z.string().min(1).max(180);
const tools = [
  [
    'get_configuration',
    'Read all settings, groups, blacklist/whitelist, gravity and subgraph definitions, hotkeys and UI state.',
    readRef,
    'getConfiguration',
    true,
  ],
  [
    'update_settings',
    'Patch any global setting, including physics, colors, display and autosave. Existing save/autosave semantics apply.',
    { ...ref, settings: patch(settings) },
    'updateSettings',
  ],
  [
    'get_node_settings',
    'Read individual visual/force/pin settings, including effective inherited values.',
    { ...readRef, nodeIds: ids.min(1) },
    'getNodeSettings',
    true,
  ],
  [
    'update_node_settings',
    'Patch individual visual settings; null removes an override. Optional reset clears all visual overrides first.',
    {
      ...ref,
      nodeIds: ids.min(1),
      settings: patch(
        Object.fromEntries(Object.entries(visuals).map(([k, v]) => [k, v.nullable()]))
      ),
      reset: z.boolean().optional(),
      edgeColor: color.nullable().optional(),
      multiplier: number(1, 10).nullable().optional(),
      strongPull: z.boolean().optional(),
    },
    'updateNodeSettings',
  ],
  [
    'edit_rules',
    'Add, update, remove, replace or clear ordered groups, blacklist or whitelist. Use explicit typed queries name:, path:, file:, tag:, line:, section:, [property]:.',
    {
      ...ref,
      list: z.enum(['groups', 'blacklist', 'whitelist']),
      action: z.enum(['add', 'update', 'remove', 'replace', 'clear']),
      rules: z.array(rule).max(500).optional(),
      ids: ids.optional(),
    },
    'editRules',
  ],
  [
    'search_nodes',
    'Search without changing the UI. Returns bounded matching IDs; same query matcher as groups and gravity nodes.',
    {
      ...readRef,
      ...page,
      query: z.string().min(1).max(4096),
      visibleOnly: z.boolean().optional(),
    },
    'searchNodes',
    true,
  ],
  [
    'set_search',
    'Set or clear the UI search and highlight, using existing find/filter behavior (name filter includes linked nodes).',
    {
      ...ref,
      query: z.string().max(4096),
      mode: z.enum(['find', 'filter']).optional(),
      showConnections: z.boolean().optional(),
    },
    'setSearch',
  ],
  [
    'highlight_nodes',
    'Highlight explicit nodes without requiring a shared search query. Empty nodeIds clears highlighting; optionally include neighbors. Uses the existing search highlight renderer.',
    { ...ref, nodeIds: ids, includeLinked: z.boolean().optional() },
    'highlightNodes',
  ],
  [
    'set_visible_nodes',
    'Set an exact node subset; only edges between these nodes remain visible. null clears this extra filter. Saved with layouts; intersects blacklist/whitelist.',
    { ...ref, nodeIds: ids.nullable() },
    'setVisibleNodes',
  ],
  [
    'set_camera',
    'Set exact camera position/zoom, or fit visible nodes. Enables restoring a previous camera.',
    {
      ...ref,
      camera: z
        .object({ ...position, zoom: number(MIN_ZOOM, MAX_ZOOM) })
        .strict()
        .optional(),
      fit: z.boolean().optional(),
    },
    'setCamera',
  ],
  [
    'move_nodes',
    'Move nodes to explicit coordinates, keeping existing pin modes unless pin is specified.',
    {
      ...ref,
      positions: z
        .array(z.object({ id, ...position }).strict())
        .min(1)
        .max(500),
      pin: z.enum(['keep', 'exact', 'grid', 'none']).optional(),
    },
    'moveNodes',
  ],
  [
    'pin_nodes',
    'Pin/unpin explicit nodes, all nodes, or linked nodes/attachments. Orbit uses anchorId and existing linked orbit logic.',
    {
      ...ref,
      nodeIds: ids.optional(),
      all: z.boolean().optional(),
      anchorId: id.optional(),
      mode: z.enum(['exact', 'grid', 'orbit', 'none']),
      targetKind: z.enum(['all', 'regular', 'attachment']).optional(),
    },
    'pinNodes',
  ],
  [
    'gravity_nodes',
    'Create, update or delete a gravity node with typed queries, attraction and repulsion.',
    {
      ...ref,
      action: z.enum(['create', 'update', 'delete']),
      id: id.optional(),
      name: z.string().min(1).max(300).optional(),
      queries: z.array(z.string().min(1).max(4096)).min(1).max(100).optional(),
      strength: number(0, 100).optional(),
      repulsion: number(0, 100).optional(),
      x: position.x.optional(),
      y: position.y.optional(),
    },
    'gravityNodes',
  ],
  [
    'subgraph_nodes',
    'Create a named layout-only container from selection or memberIds, rename it, open its independent local graph in an Obsidian pane, or ungroup at the current container position without deleting notes. No in-place expansion. Membership is fixed until Ungroup.',
    {
      ...ref,
      action: z.enum(['create', 'rename', 'open', 'ungroup']),
      id: id.optional(),
      name: z.string().min(1).max(300).optional(),
      memberIds: ids.optional(),
    },
    'subgraphNodes',
  ],
  ['list_layouts', 'List saved layouts and the current layout.', {}, 'listLayouts', true],
  [
    'create_layout',
    'Create a new layout from the current graph or a saved source; optionally switch to it. Never overwrites.',
    { ...ref, name: layoutName, source: layoutName.optional(), activate: z.boolean().optional() },
    'createLayout',
  ],
  [
    'save_layout',
    'Save current graph, settings, camera, search and exact node subset. Existing destination is backed up first.',
    { ...ref, name: layoutName.optional() },
    'saveLayout',
  ],
  [
    'load_layout',
    'Load/switch a saved layout and its settings, positions and camera. Unsaved edits are discarded as in the UI.',
    { ...ref, name: layoutName },
    'loadLayout',
  ],
  [
    'delete_layout',
    'Back up then delete a layout. Last layout cannot be deleted. Deleting the active layout selects another readable layout.',
    { ...ref, name: layoutName },
    'deleteLayout',
    false,
    true,
  ],
  [
    'backup_layout',
    'Create a backup of a saved layout. ensure=true reuses an existing identical backup.',
    { ...ref, name: layoutName, ensure: z.boolean().optional() },
    'backupLayout',
  ],
  [
    'list_backups',
    'List layout backup IDs, original names and creation dates. Backups are separate from layouts.',
    { name: layoutName.optional(), ...page },
    'listBackups',
    true,
  ],
  [
    'restore_layout',
    'Restore a backup into its original or a new layout; existing destination is backed up before replacement. Optionally activate.',
    { ...ref, backupId: id, name: layoutName.optional(), activate: z.boolean().optional() },
    'restoreLayout',
    false,
    true,
  ],
  [
    'get_export_locations',
    'Discover the current vault name and export path mode. Exports are vault-relative on every platform; home and desktop are null.',
    readRef,
    'getExportLocations',
    true,
  ],
  [
    'export_html',
    'Export an interactive static HTML graph to an explicit vault-relative filename on every platform. nodeIds exports precisely their induced subgraph. Existing files need overwrite=true. Contents optional.',
    {
      ...ref,
      path: z.string().min(1).max(4096),
      nodeIds: ids.optional(),
      includeContents: z.boolean().optional(),
      overwrite: z.boolean().optional(),
    },
    'exportHtml',
  ],
  [
    'graph_action',
    'Open/refresh graph, pause/resume simulation, align pins, select linked nodes, arm box selection or clear selection.',
    {
      viewId: readRef.viewId.optional(),
      contextToken: ref.contextToken.optional(),
      action: z.enum([
        'open',
        'refresh',
        'pause',
        'resume',
        'align_grid',
        'select_linked',
        'arm_box_select',
        'clear_selection',
      ]),
      nodeId: id.optional(),
    },
    'graphAction',
  ],
  [
    'update_ui',
    'Show/hide the side panel, change collapsed sections, or assign/clear a built-in command hotkey.',
    {
      ...ref,
      panelOpen: z.boolean().optional(),
      sections: patch(
        Object.fromEntries(
          ['search', 'selection', 'display', 'physics', 'groups', 'lists', 'layout'].map((k) => [
            k,
            z.boolean(),
          ])
        )
      ).optional(),
      commandId: z.enum(HOTKEY_COMMANDS.map((c) => c.id)).optional(),
      hotkey: z.string().max(100).optional(),
    },
    'updateUi',
  ],
  [
    'node_action',
    'Copy name/path/linked names/linked paths/Obsidian URL (also returns text), open note/path/URL/local graph, or show/close quick preview. No arbitrary code or native third-party menu callbacks.',
    {
      ...ref,
      nodeId: id,
      action: z.enum([
        'copy_name',
        'copy_path',
        'copy_linked_names',
        'copy_linked_paths',
        'copy_obsidian_url',
        'copy_system_path',
        'open_note',
        'open_path',
        'open_url',
        'local_graph',
        'preview',
        'close_preview',
      ]),
      clipboard: z.boolean().optional(),
    },
    'nodeAction',
  ],
];

const EXTENDED_TOOLS = tools.map(
  ([name, description, shape, method, readOnly = false, destructive = false]) => ({
    name,
    description,
    schema: z.object(shape).strict(),
    method,
    readOnly,
    destructive,
  })
);
function validate(method, args) {
  const definition = EXTENDED_TOOLS.find((t) => t.method === method);
  const result = definition.schema.safeParse(args);
  if (!result.success) {
    const error = new Error(
      result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    );
    error.code = 'INVALID_ARGUMENT';
    throw error;
  }
  return result.data;
}
module.exports = { EXTENDED_TOOLS, validate };
