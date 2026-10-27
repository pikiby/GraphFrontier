const { DEFAULT_DATA } = require('./constants');

const NODE_VISUAL_SETTINGS = [
  { key: 'node_size_scale', label: 'Node size', min: 0.1, max: 4, step: 0.01 },
  { key: 'node_color', label: 'Node color', type: 'color' },
  { key: 'aura_radius', label: 'Color aura', min: 0, max: 5000, step: 10 },
  { key: 'aura_brightness', label: 'Aura brightness', min: 0, max: 50, step: 1 },
  { edges: true, key: 'edge_width_scale', label: 'Edge width', min: 0.01, max: 1, step: 0.01 },
  {
    edges: true,
    key: 'painted_edge_width',
    label: 'Painted edge width',
    min: 0.01,
    max: 1,
    step: 0.01,
  },
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
      if (type === 'color') {
        if (/^#[0-9a-f]{6}$/i.test(value)) clean[key] = value;
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

function getNodeVisualOverride(plugin, id, key) {
  if (key === 'label_font_size') return plugin.getNodeLabelSize(id);
  return plugin.data?.node_visual_settings?.[id]?.[key] ?? null;
}

function getNodeVisualSetting(plugin, id, key) {
  return (
    getNodeVisualOverride(plugin, id, key) ??
    plugin.getSettings()[key] ??
    DEFAULT_DATA.settings[key]
  );
}

function getEdgeVisualSetting(plugin, source, target, key) {
  const a = getNodeVisualOverride(plugin, source, key);
  const b = getNodeVisualOverride(plugin, target, key);
  if (a !== null && b !== null) return Math.max(a, b);
  return a ?? b ?? plugin.getSettings()[key] ?? DEFAULT_DATA.settings[key];
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
  getNodeColor,
  NODE_VISUAL_SETTINGS,
  normalizeNodeVisuals,
  getNodeVisualOverride,
  getNodeVisualSetting,
  getEdgeVisualSetting,
};
