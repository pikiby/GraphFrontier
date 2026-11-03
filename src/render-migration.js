// One-time migration of visual settings saved before render model 2: node sizes
// lost their radius ceiling and edge widths moved from CSS to physical pixels.
const RENDER_MODEL = 2;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

// Keeps the old radius of an unlinked node, min(4 * max(1, s / 2), 2.2 * s), under
// the uncapped formula 2.2 * s.
function migrateLegacyNodeSize(size) {
  const value = Number(size);
  if (!Number.isFinite(value)) return size;
  const cap = 4 * Math.max(1, value / 2);
  return clamp(Math.min(cap, 2.2 * value) / 2.2, 0.1, 2);
}

function migrateLegacyEdgeWidth(width, devicePixelRatio) {
  const value = Number(width);
  if (!Number.isFinite(value)) return width;
  return clamp(value * (Number(devicePixelRatio) || 1), 0.1, 5);
}

function hasStoredVisuals(data) {
  return ['settings', 'saved_layout_settings', 'node_visual_settings'].some(
    (key) => isObject(data[key]) && Object.keys(data[key]).length > 0
  );
}

function pickLegacy(settings) {
  const picked = {};
  for (const key of ['node_size_scale', 'edge_width_scale']) {
    if (settings?.[key] !== undefined) picked[key] = settings[key];
  }
  return picked;
}

// Node sizes migrate immediately; edge widths wait for the device pixel ratio of the
// first view. Originals are kept in legacy_render_settings so the change can be undone.
function prepareRenderModel(raw) {
  const data = isObject(raw) ? raw : {};
  if (data.render_model === RENDER_MODEL) return data;
  if (data.legacy_render_settings?.pending_edge_dpr) return data;
  if (!hasStoredVisuals(data)) return { ...data, render_model: RENDER_MODEL };

  const next = { ...data };
  const legacy = {
    from_model: 1,
    settings: pickLegacy(data.settings),
    saved_layout_settings: pickLegacy(data.saved_layout_settings),
    node_visual_settings: {},
    dpr: null,
    pending_edge_dpr: true,
  };
  for (const key of ['settings', 'saved_layout_settings']) {
    if (!isObject(data[key])) continue;
    next[key] = { ...data[key] };
    if (next[key].node_size_scale !== undefined)
      next[key].node_size_scale = migrateLegacyNodeSize(next[key].node_size_scale);
  }
  if (isObject(data.node_visual_settings)) {
    next.node_visual_settings = {};
    for (const [id, visuals] of Object.entries(data.node_visual_settings)) {
      if (!isObject(visuals)) {
        next.node_visual_settings[id] = visuals;
        continue;
      }
      const picked = pickLegacy(visuals);
      if (Object.keys(picked).length) legacy.node_visual_settings[id] = picked;
      next.node_visual_settings[id] = { ...visuals };
      if (visuals.node_size_scale !== undefined)
        next.node_visual_settings[id].node_size_scale = migrateLegacyNodeSize(
          visuals.node_size_scale
        );
    }
  }
  delete next.render_model;
  next.legacy_render_settings = legacy;
  return next;
}

// Normalized copy of the migration record, or null.
function normalizeLegacyRenderSettings(value) {
  if (!isObject(value)) return null;
  const nodeVisuals = {};
  for (const [id, visuals] of Object.entries(
    isObject(value.node_visual_settings) ? value.node_visual_settings : {}
  )) {
    if (isObject(visuals)) nodeVisuals[id] = pickLegacy(visuals);
  }
  const dpr = Number(value.dpr);
  return {
    from_model: 1,
    settings: pickLegacy(value.settings),
    saved_layout_settings: pickLegacy(value.saved_layout_settings),
    node_visual_settings: nodeVisuals,
    dpr: Number.isFinite(dpr) && dpr > 0 ? dpr : null,
    ...(value.pending_edge_dpr ? { pending_edge_dpr: true } : {}),
  };
}

// Converts stored CSS-pixel edge widths once, using the original values, then marks
// the data as render model 2. Returns whether anything changed.
function applyEdgeDprMigration(data, devicePixelRatio) {
  const legacy = data?.legacy_render_settings;
  if (!legacy?.pending_edge_dpr) return false;
  const dpr = Number(devicePixelRatio) > 0 ? Number(devicePixelRatio) : 1;
  for (const key of ['settings', 'saved_layout_settings']) {
    const original = legacy[key]?.edge_width_scale;
    if (original !== undefined && isObject(data[key]))
      data[key].edge_width_scale = migrateLegacyEdgeWidth(original, dpr);
  }
  for (const [id, original] of Object.entries(legacy.node_visual_settings || {})) {
    const visuals = data.node_visual_settings?.[id];
    if (original.edge_width_scale !== undefined && isObject(visuals))
      visuals.edge_width_scale = migrateLegacyEdgeWidth(original.edge_width_scale, dpr);
  }
  legacy.dpr = dpr;
  delete legacy.pending_edge_dpr;
  data.render_model = RENDER_MODEL;
  return true;
}

module.exports = {
  RENDER_MODEL,
  migrateLegacyNodeSize,
  migrateLegacyEdgeWidth,
  prepareRenderModel,
  normalizeLegacyRenderSettings,
  applyEdgeDprMigration,
};
