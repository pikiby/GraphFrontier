import { z } from './schema-runtime.js';
import { EXTENDED_TOOLS } from './api-tools.js';
const MAX_PAGE = 500;
const view = { viewId: z.string().min(1).max(200), contextToken: z.string().max(300).optional() };
const page = {
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  limit: z.number().int().min(1).max(MAX_PAGE).optional(),
};
const nodes = {
  ...view,
  contextToken: z.string().min(1).max(300),
  nodeIds: z.array(z.string().min(1).max(4096)).max(MAX_PAGE),
};
const definitions = [
  [
    'list_views',
    'List open graphs, vault identity and context tokens. Does not open tabs.',
    {},
    'listViews',
    true,
  ],
  ['get_state', 'Read graph counts, active layout and camera.', view, 'getState', true],
  [
    'get_selection',
    'Read a page of explicit selection IDs; search focus is separate.',
    { ...view, ...page },
    'getSelection',
    true,
  ],
  [
    'get_graph',
    'Read a bounded page of node metadata or links, not note contents. Default visibleOnly=true. Follow nextOffset; contextToken detects layout/graph changes.',
    {
      ...view,
      ...page,
      kind: z.enum(['nodes', 'edges']).optional(),
      visibleOnly: z.boolean().optional(),
    },
    'getGraph',
    true,
  ],
  [
    'select_nodes',
    'Replace selection with these visible node IDs. Empty list clears selection. Requires current contextToken; does not save layouts.',
    nodes,
    'selectNodes',
    false,
  ],
  [
    'frame_nodes',
    'Frame these visible nodes with the camera without moving nodes or saving a layout.',
    { ...nodes, nodeIds: nodes.nodeIds.min(1) },
    'frameNodes',
    false,
  ],
];
const tools = [
  ...definitions.map(([name, description, inputSchema, method, readOnly]) => ({
    name,
    description,
    schema: z.object(inputSchema).strict(),
    method,
    readOnly,
    destructive: false,
  })),
  ...EXTENDED_TOOLS,
];
export { tools };
