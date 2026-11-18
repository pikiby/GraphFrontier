const { DEFAULT_DATA, NODE_MULTIPLIER_MAX } = require('./constants');

const NODE_SHAPE_NAMES = {
  1: 'Circle',
  3: 'Triangle',
  4: 'Square',
  5: 'Pentagon',
  6: 'Hexagon',
  7: 'Heptagon',
  8: 'Octagon',
};

const NODE_VISUAL_SETTINGS = [
  { key: 'node_size_scale', label: 'Node size', min: 0.1, max: 2, step: 0.005 },
  { key: 'node_color', label: 'Node color', type: 'color' },
  // 1 is a circle, 3-8 a polygon with that many sides. The slider steps through these shapes
  // by position, so there is no gap where 2 sides would be.
  {
    key: 'node_shape',
    label: 'Shape',
    min: 1,
    max: 8,
    step: 1,
    values: [1, 3, 4, 5, 6, 7, 8],
    names: NODE_SHAPE_NAMES,
  },
  { key: 'aura_radius', label: 'Color aura', min: 0, max: 5000, step: 10 },
  { key: 'aura_brightness', label: 'Aura brightness', min: 0, max: 50, step: 1 },
  // Edge widths are physical screen pixels, like Obsidian's link thickness.
  { edges: true, key: 'edge_width_scale', label: 'Link width', min: 0.1, max: 5, step: 0.01 },
  { edges: true, key: 'edge_color', label: 'Link color', type: 'color' },
  { edges: true, key: 'edge_opacity', label: 'Link opacity', min: 0, max: 1, step: 0.01 },
  { edges: true, key: 'show_arrows', label: 'Show arrows', type: 'boolean' },
  { edges: true, key: 'reverse_arrows', label: 'Reverse arrows', type: 'boolean' },
  { key: 'label_zoom_steps', label: 'Text zoom', min: 1, max: 40, step: 1 },
  { key: 'label_font_size', label: 'Text size', min: 5, max: 20, step: 1 },
  { key: 'hover_dim_strength', label: 'Hover dimming', min: 0, max: 100, step: 1 },
];

function normalizeNodeVisuals(raw) {
  const result = {};
  for (const [id, values] of Object.entries(raw || {})) {
    if (!values || typeof values !== 'object') continue;
    const clean = {};
    for (const { key, min, max, type } of NODE_VISUAL_SETTINGS) {
      // Keep existing text-size storage compatible with older layouts.
      if (key === 'label_font_size') continue;
      const value = values[key];
      if (type === 'boolean') {
        if (typeof value === 'boolean') clean[key] = value;
        continue;
      }
      if (type === 'color') {
        if (/^#[0-9a-f]{6}$/i.test(value)) clean[key] = value;
        continue;
      }
      if (key === 'node_shape') {
        if (typeof value === 'number' && Number.isFinite(value))
          clean[key] = normalizeNodeShape(value);
        continue;
      }
      if (typeof value === 'number' && Number.isFinite(value))
        clean[key] = Math.max(min, Math.min(max, value));
    }
    if (Object.keys(clean).length)
      Object.defineProperty(result, id, {
        value: clean,
        enumerable: true,
        configurable: true,
        writable: true,
      });
  }
  return result;
}

// 1 is a circle; 3-8 are polygons. 2 sides is no shape, so it reads as a circle.
function normalizeNodeShape(value) {
  const sides = Math.round(Math.max(1, Math.min(8, Number(value) || 1)));
  return sides === 2 ? 1 : sides;
}

// Outlines a node: a circle, or a regular polygon with the circle's area, so every shape keeps
// the same visual weight. Odd polygons point up, even ones sit on a flat side.
function traceNodeShape(ctx, x, y, radius, sides) {
  if (!(sides >= 3)) {
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    return;
  }
  const r = radius * Math.sqrt((2 * Math.PI) / (sides * Math.sin((2 * Math.PI) / sides)));
  const start = -Math.PI / 2 + (sides % 2 ? 0 : Math.PI / sides);
  for (let i = 0; i < sides; i++) {
    const angle = start + (i * 2 * Math.PI) / sides;
    if (i === 0) ctx.moveTo(x + r * Math.cos(angle), y + r * Math.sin(angle));
    else ctx.lineTo(x + r * Math.cos(angle), y + r * Math.sin(angle));
  }
  ctx.closePath();
}

function getNodeVisualOverride(plugin, id, key) {
  if (key === 'label_font_size') return plugin.getNodeLabelSize(id);
  if (key === 'edge_color')
    return (
      plugin.data?.node_visual_settings?.[id]?.[key] ??
      plugin.data?.painted_edge_colors?.[id] ??
      null
    );
  return plugin.data?.node_visual_settings?.[id]?.[key] ?? null;
}

function getNodeVisualSetting(plugin, id, key, context) {
  return (
    getNodeVisualOverride(plugin, id, key) ??
    getNodeGroupVisuals(plugin, id, context)?.[key] ??
    plugin.getSettings()[key] ??
    DEFAULT_DATA.settings[key]
  );
}

function getNodeGroupVisuals(plugin, id, context) {
  if (!context) return plugin.getGroupVisualSettings?.(id);
  const groups = context.visualGroups || (context.visualGroups = new Map());
  if (!groups.has(id)) groups.set(id, plugin.getGroupVisualSettings?.(id, context));
  return groups.get(id);
}

function getEdgeVisualSetting(plugin, source, target, key, context) {
  const a = getNodeVisualOverride(plugin, source, key);
  const b = getNodeVisualOverride(plugin, target, key);
  const groupA = getNodeGroupVisuals(plugin, source, context)?.[key] ?? null;
  const groupB = getNodeGroupVisuals(plugin, target, context)?.[key] ?? null;
  // Width retains the established maximum-endpoint rule. Other settings prefer
  // individual > group > global, then the stored source at equal priority.
  if (key === 'edge_width_scale') {
    const widthA = a ?? groupA;
    const widthB = b ?? groupB;
    if (widthA !== null && widthB !== null) return Math.max(widthA, widthB);
    return widthA ?? widthB ?? plugin.getSettings()[key] ?? DEFAULT_DATA.settings[key];
  }
  return a ?? b ?? groupA ?? groupB ?? plugin.getSettings()[key] ?? DEFAULT_DATA.settings[key];
}

function normalizeGroupVisuals(raw) {
  const normalized = normalizeNodeVisuals({ group: raw }).group || {};
  delete normalized.node_color;
  if (typeof raw?.label_font_size === 'number' && Number.isFinite(raw.label_font_size))
    normalized.label_font_size = Math.max(5, Math.min(20, raw.label_font_size));
  if (typeof raw?.strong_pull === 'boolean') normalized.strong_pull = raw.strong_pull;
  if (
    typeof raw?.strong_pull_multiplier === 'number' &&
    Number.isFinite(raw.strong_pull_multiplier)
  )
    normalized.strong_pull_multiplier = Math.max(
      1,
      Math.min(NODE_MULTIPLIER_MAX, raw.strong_pull_multiplier)
    );
  if (/^#[0-9a-f]{6}$/i.test(raw?.edge_color)) normalized.edge_color = raw.edge_color.toLowerCase();
  return normalized;
}

function getNodeColor(plugin, node, groupColor) {
  return (
    getNodeVisualOverride(plugin, node.id, 'node_color') ??
    groupColor ??
    (node.meta?.isAttachment ? plugin.getSettings().attachment_node_color : null) ??
    getNodeVisualSetting(plugin, node.id, 'node_color')
  );
}

module.exports = {
  normalizeNodeShape,
  NODE_SHAPE_NAMES,
  traceNodeShape,
  getNodeGroupVisuals,
  getNodeColor,
  NODE_VISUAL_SETTINGS,
  normalizeNodeVisuals,
  normalizeGroupVisuals,
  getNodeVisualOverride,
  getNodeVisualSetting,
  getEdgeVisualSetting,
};
