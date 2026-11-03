const { DEFAULT_DATA, MAX_ZOOM, ZOOM_STEP_FACTOR } = require('./constants');
const { DARK_THEME, getLabelAppearance } = require('./theme');
const { getNodeVisualSetting, getEdgeVisualSetting, getNodeColor } = require('./node-visuals');
const EMPTY_LISTS = [];
const { nodeListContains } = require('./node-lists');
const {
  getFocusEdgeWidth,
  getFocusEdgeColor,
  getFocusEdgeAlpha,
  quantizeFocusProgress,
  getNodeScreenRadius,
  getEdgeCssWidth,
  setCrispStroke,
  getCrispCoordinate,
} = require('./render-metrics');

// Backing-store pixels per CSS pixel.
function getBackingScale(view) {
  return Number(view.devicePixelRatio) || 1;
}

// Custom hover highlight color, or null for the theme-derived default.
function getHoverHighlightColor(view) {
  const color = view.plugin.getSettings().hover_highlight_color;
  return /^#[0-9a-f]{6}$/i.test(String(color || '')) ? color : null;
}

// Global edge appearance: theme color unless a valid custom color is set.
function getEdgeAppearance(view) {
  const settings = view.plugin.getSettings();
  const theme = view.canvasTheme || DARK_THEME;
  return {
    color: /^#[0-9a-f]{6}$/i.test(settings.edge_color) ? settings.edge_color : theme.mutedText,
    opacity: view.plugin.clampNumber(
      settings.edge_opacity,
      0,
      1,
      DEFAULT_DATA.settings.edge_opacity
    ),
  };
}

// Focus dimming helper: computes alpha of non-focused graph elements.
function getHoverDimAlpha(plugin, focusProgress, nodeId) {
  const clampedProgress = Math.max(0, Math.min(1, Number(focusProgress) || 0));
  const dimStrength = plugin.clampNumber(
    getNodeVisualSetting(plugin, nodeId, 'hover_dim_strength'),
    0,
    100,
    DEFAULT_DATA.settings.hover_dim_strength
  );
  if (dimStrength <= 0 || clampedProgress <= 0) return 1;
  const dimFactor = dimStrength / 100;
  const minAlpha = Math.max(0.02, 1 - dimFactor);
  return Math.max(minAlpha, 1 - clampedProgress * dimFactor);
}

// Color helper: convert #rrggbb into rgba string used by edge rendering.
function hexToRgba(hexColor, alpha) {
  const text = String(hexColor || '').trim();
  const match = /^#([0-9a-f]{6})$/i.exec(text);
  if (!match) return `rgba(145, 160, 187, ${alpha})`;
  const value = match[1];
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

// Focus blending state machine for smooth highlight transitions.
function stepFocusSmoothing(view) {
  const targetFocusNodeId = view.getActiveFocusNodeId();
  const targetProgress = targetFocusNodeId ? 1 : 0;
  const smooth = 0.2;
  view.focusProgress += (targetProgress - view.focusProgress) * smooth;
  if (Math.abs(targetProgress - view.focusProgress) < 0.01) {
    view.focusProgress = targetProgress;
  }
  if (targetFocusNodeId) view.focusNodeId = targetFocusNodeId;
  else if (view.focusProgress <= 0.001) view.focusNodeId = null;

  const hoverTargetNodeId = view.hoverNodeId || null;

  if (hoverTargetNodeId && hoverTargetNodeId !== view.hoverFocusNodeId) {
    if (view.hoverFocusNodeId && view.hoverFocusProgress > 0.001) {
      view.hoverFadeNodeId = view.hoverFocusNodeId;
      view.hoverFadeProgress = Math.max(view.hoverFadeProgress, view.hoverFocusProgress);
    }
    view.hoverFocusNodeId = hoverTargetNodeId;
    view.hoverFocusProgress = 0;
    if (view.hoverFadeNodeId && view.hoverFadeNodeId === view.hoverFocusNodeId) {
      view.hoverFadeNodeId = null;
      view.hoverFadeProgress = 0;
    }
  }

  const targetHoverProgress = hoverTargetNodeId ? 1 : 0;
  const hoverSmooth = targetHoverProgress > view.hoverFocusProgress ? 0.24 : 0.3;
  view.hoverFocusProgress += (targetHoverProgress - view.hoverFocusProgress) * hoverSmooth;
  if (Math.abs(targetHoverProgress - view.hoverFocusProgress) < 0.01) {
    view.hoverFocusProgress = targetHoverProgress;
  }
  if (!hoverTargetNodeId && view.hoverFocusProgress <= 0.001) {
    view.hoverFocusNodeId = null;
  }

  const targetHoverFadeProgress = 0;
  const hoverFadeSmooth = 0.3;
  view.hoverFadeProgress += (targetHoverFadeProgress - view.hoverFadeProgress) * hoverFadeSmooth;
  if (Math.abs(targetHoverFadeProgress - view.hoverFadeProgress) < 0.01) {
    view.hoverFadeProgress = targetHoverFadeProgress;
  }
  if (view.hoverFadeProgress <= 0.001) {
    view.hoverFadeNodeId = null;
  }
}

// Main render pass: clear background, optional grid, then edges and nodes.
function renderFrame(view) {
  if (!view.ctx) return;

  const ctx = view.ctx;
  const width = view.viewWidth;
  const height = view.viewHeight;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = view.canvasBackgroundColor || '#111418';
  ctx.fillRect(0, 0, width, height);

  if (view.plugin.getSettings().show_grid) {
    drawGrid(view, ctx);
  }

  drawNodeAuras(view, ctx);
  drawEdges(view, ctx);
  drawNodes(view, ctx);
  drawHiddenGridMarkers(view, ctx);
  drawSelectionBox(view, ctx);
}

function getNodeLabelText(node) {
  if (!node.meta?.isAttachment) return node.label;

  // The real path preserves extension case and extensionless filenames.
  const path = String(node.meta.path || node.id || '');
  const filename = path.split('/').pop();
  if (filename) return filename;

  const basename = String(node.meta.fileName || node.label || '');
  const extension = String(node.meta.fileType || '').trim();
  if (!basename || !extension || /^(attachment|file)$/i.test(extension)) return basename;
  return basename.toLowerCase().endsWith(`.${extension.toLowerCase()}`)
    ? basename
    : `${basename}.${extension}`;
}

// Shared node radius formula, including attachments.
function getNodeRadius(view, node) {
  const nodeScale = view.plugin.clampNumber(
    getNodeVisualSetting(view.plugin, node.id, 'node_size_scale'),
    0.1,
    2,
    DEFAULT_DATA.settings.node_size_scale
  );
  // Radius grows with degree and is proportional to Node size, without a ceiling,
  // so relative node sizes survive any scale. Uncapped radii match earlier versions.
  return Math.max(0.2, (3 + Math.log2(node.degree + 2) * 1.4) * nodeScale * 0.5);
}

// Convert slider steps into zoom threshold for label visibility.
function getLabelZoomThreshold(view, nodeId) {
  const steps = view.plugin.clampNumber(
    getNodeVisualSetting(view.plugin, nodeId, 'label_zoom_steps'),
    1,
    40,
    DEFAULT_DATA.settings.label_zoom_steps
  );
  // Each step extends label visibility by one wheel-zoom step.
  return MAX_ZOOM / Math.pow(ZOOM_STEP_FACTOR, steps - 1);
}

// Base label font scale used before camera zoom multiplier.
function getLabelMinimumSize(view, nodeId) {
  return (10 * getLabelFontSize(view, nodeId)) / (DEFAULT_DATA.settings.label_font_size / 5);
}

function getLabelFontSize(view, nodeId) {
  const baseSize = view.plugin.clampNumber(
    getNodeVisualSetting(view.plugin, nodeId, 'label_font_size'),
    5,
    20,
    DEFAULT_DATA.settings.label_font_size
  );
  return baseSize / 5;
}

// Resolve group colors once per graph/groups version; drawing can then do cheap map lookups.
function getGroupStyleMap(view) {
  const groups = Array.isArray(view.plugin.data.groups) ? view.plugin.data.groups : [];
  if (groups.length === 0) return null;
  const lists = view.plugin.getNodeLists?.() || EMPTY_LISTS;
  const graphVersion = Number(view.visibilityGraphVersion || 0);
  const cache =
    view.groupColorCache && typeof view.groupColorCache === 'object' ? view.groupColorCache : null;
  if (
    cache &&
    cache.graphVersion === graphVersion &&
    cache.groups === groups &&
    cache.lists === lists &&
    cache.styleByNodeId instanceof Map
  ) {
    return cache.styleByNodeId;
  }

  const parsedGroups = [];
  for (const group of groups) {
    if (!group || group.enabled === false) continue;
    const parsed = view.plugin.parseGroupQuery(group.query);
    if (!parsed) continue;
    parsedGroups.push({
      parsed,
      color: view.plugin.normalizeGroupColor(group.color),
      settings: group.settings || {},
      members:
        parsed.type === 'list'
          ? new Set(lists.find((list) => list.id === parsed.value)?.nodeIds || [])
          : null,
    });
  }
  const colorByNodeId = new Map();
  const styleByNodeId = new Map();
  for (const candidateNode of view.nodes) {
    const meta = view.nodeMetaById.get(candidateNode.id) || candidateNode.meta || null;
    if (!meta) continue;
    for (const group of parsedGroups) {
      if (
        group.members
          ? group.members.has(candidateNode.id)
          : nodeMatchesParsedGroup(meta, group.parsed, candidateNode, lists)
      ) {
        if (!colorByNodeId.has(candidateNode.id)) colorByNodeId.set(candidateNode.id, group.color);
        const style = styleByNodeId.get(candidateNode.id) || {};
        for (const [key, value] of Object.entries({ ...group.settings, node_color: group.color })) {
          if (style[key] === undefined) style[key] = value;
        }
        styleByNodeId.set(candidateNode.id, style);
      }
    }
  }
  view.groupColorCache = {
    graphVersion,
    groups,
    colorByNodeId,
    styleByNodeId,
    lists,
  };
  return styleByNodeId;
}

function getGroupColorMap(view) {
  return getGroupStyleMap(view) ? view.groupColorCache.colorByNodeId : null;
}

// Resolve first matching group color for a node, according to current row priority.
function getGroupColorForNode(view, node) {
  const colorByNodeId = getGroupColorMap(view);
  return colorByNodeId instanceof Map ? colorByNodeId.get(node.id) || null : null;
}

// Match helper used by group-color rules (path/file/tag/line/section/property).
function nodeMatchesParsedGroup(meta, parsed, node = null, lists = []) {
  if (parsed.type === 'list') {
    return nodeListContains(lists, String(parsed.value || '').trim(), node?.id || meta?.path);
  }
  const needle = String(parsed.value || '')
    .trim()
    .toLowerCase();
  if (!needle) return false;

  const includesCI = (value) =>
    String(value || '')
      .toLowerCase()
      .includes(needle);
  if (parsed.type === 'name') {
    const label = String(node?.label || meta?.fileName || '');
    return includesCI(label);
  }
  if (parsed.type === 'path') return includesCI(meta.path);
  if (parsed.type === 'file') return includesCI(meta.fileName);
  if (parsed.type === 'tag')
    return Array.isArray(meta.tags) && meta.tags.some((tag) => includesCI(tag));
  if (parsed.type === 'section')
    return Array.isArray(meta.sections) && meta.sections.some((section) => includesCI(section));
  if (parsed.type === 'line')
    return Array.isArray(meta.lines) && meta.lines.some((line) => includesCI(line));
  if (parsed.type === 'property') {
    const key = String(parsed.propertyKey || '')
      .trim()
      .toLowerCase();
    if (!key) return false;
    const values = meta.properties instanceof Map ? meta.properties.get(key) : null;
    return Array.isArray(values) && values.some((value) => includesCI(value));
  }
  return false;
}

// Draw graph grid in world space with camera transform.
function drawGrid(view, ctx) {
  const step = view.plugin.clampGridStep(view.plugin.getSettings().grid_step);
  const zoom = view.camera.zoom;
  const scaledStep = step * zoom;

  if (scaledStep < 8) return;

  const leftWorld = view.screenToWorld(0, 0).x;
  const rightWorld = view.screenToWorld(view.viewWidth, 0).x;
  const topWorld = view.screenToWorld(0, 0).y;
  const bottomWorld = view.screenToWorld(0, view.viewHeight).y;

  const startX = Math.floor(leftWorld / step) * step;
  const endX = Math.ceil(rightWorld / step) * step;
  const startY = Math.floor(topWorld / step) * step;
  const endY = Math.ceil(bottomWorld / step) * step;

  const theme = view.canvasTheme || DARK_THEME;
  const backingScale = getBackingScale(view);
  ctx.save();
  ctx.strokeStyle = theme.grid;
  setCrispStroke(
    ctx,
    view.plugin.clampGridLineWidth(view.plugin.getSettings().grid_line_width),
    theme.gridOpacity,
    backingScale
  );

  // Chromium can drop subpixel lines when a crossed grid shares one path.
  const strokeSeparately = ctx.lineWidth < 1;
  if (!strokeSeparately) ctx.beginPath();
  for (let x = startX; x <= endX; x += step) {
    if (strokeSeparately) ctx.beginPath();
    const sx = view.worldToScreen(x, 0).x;
    const crispX = getCrispCoordinate(sx, backingScale, ctx.lineWidth);
    ctx.moveTo(crispX, 0);
    ctx.lineTo(crispX, view.viewHeight);
    if (strokeSeparately) ctx.stroke();
  }
  for (let y = startY; y <= endY; y += step) {
    if (strokeSeparately) ctx.beginPath();
    const sy = view.worldToScreen(0, y).y;
    const crispY = getCrispCoordinate(sy, backingScale, ctx.lineWidth);
    ctx.moveTo(0, crispY);
    ctx.lineTo(view.viewWidth, crispY);
    if (strokeSeparately) ctx.stroke();
  }
  if (!strokeSeparately) ctx.stroke();

  ctx.restore();
}

// While a grid-pinned node is dragged over a cell held by a hidden pinned node, show a
// faint dashed ring and the holder's name; release still snaps to the nearest free cell.
let canvasFontFamily = null;
function getCanvasFontFamily() {
  if (canvasFontFamily) return canvasFontFamily;
  try {
    const family = globalThis.getComputedStyle?.(globalThis.document?.body).fontFamily;
    canvasFontFamily = family && !family.includes('var(') ? family : 'sans-serif';
  } catch {
    canvasFontFamily = 'sans-serif';
  }
  return canvasFontFamily;
}

function drawHiddenGridMarkers(view, ctx) {
  const holders = view.getDragHiddenGridHolders?.() || [];
  if (!holders.length) return;
  const step = view.plugin.clampGridStep(view.plugin.getSettings().grid_step);
  const theme = view.canvasTheme || DARK_THEME;
  const zoom = Math.max(view.camera.zoom, 0.0001);
  const backingScale = getBackingScale(view);
  const screenRadius = (node) => (node ? getNodeScreenRadius(getNodeRadius(view, node), zoom) : 0);
  const dragged = [
    ...(view.dragSelectionOffsets instanceof Map && view.dragSelectionOffsets.size > 0
      ? view.dragSelectionOffsets.keys()
      : view.dragNodeId
        ? [view.dragNodeId]
        : []),
  ]
    .map((id) => view.nodeById.get(id))
    .filter(Boolean);
  // A hidden holder has no visible label of its own, so it follows the global Text size
  // and zoom exactly like an emphasized node label; per-node overrides would be surprising.
  const baseSize =
    view.plugin.clampNumber(
      view.plugin.getSettings().label_font_size,
      5,
      20,
      DEFAULT_DATA.settings.label_font_size
    ) / 5;
  const fontSize = getLabelAppearance(
    zoom,
    0,
    baseSize,
    1,
    true,
    (10 * baseSize) / (DEFAULT_DATA.settings.label_font_size / 5)
  ).fontSize;
  const padding = Math.max(2, fontSize * 0.25);
  ctx.save();
  // Canvas fonts cannot resolve CSS variables.
  ctx.font = `${fontSize}px ${getCanvasFontFamily()}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  for (const { nodeId, gx, gy } of holders) {
    const point = view.worldToScreen(gx * step, gy * step);
    const markerRadius = Math.max(4, screenRadius(view.nodeById.get(nodeId)));
    // The label sits above both the hidden marker and any dragged node in this cell.
    let clearance = markerRadius;
    for (const node of dragged) {
      if (Math.round(node.x / step) !== gx || Math.round(node.y / step) !== gy) continue;
      clearance = Math.max(clearance, screenRadius(node));
    }
    ctx.strokeStyle = theme.mutedText;
    setCrispStroke(ctx, 1, 0.55, backingScale);
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.arc(point.x, point.y, markerRadius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    const text = `Hidden: ${view.nodeById.get(nodeId)?.label || nodeId}`;
    const textY = point.y - clearance - 6 - padding;
    const textWidth = ctx.measureText ? ctx.measureText(text).width : text.length * fontSize * 0.55;
    ctx.globalAlpha = 0.75;
    ctx.fillStyle = theme.background;
    ctx.fillRect?.(
      point.x - textWidth / 2 - padding,
      textY - fontSize - padding,
      textWidth + padding * 2,
      fontSize + padding * 2
    );
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = theme.mutedText;
    ctx.fillText(text, point.x, textY);
  }
  ctx.restore();
}

// Draw all edges with focus/fade interpolation and painted-edge overrides.
function drawEdges(view, ctx) {
  const zoom = Math.max(view.camera.zoom, 0.0001);
  const halfWidthWorld = view.viewWidth / (2 * zoom);
  const halfHeightWorld = view.viewHeight / (2 * zoom);
  const edgePadWorld = 80 / zoom;
  const minWorldX = view.camera.x - halfWidthWorld - edgePadWorld;
  const maxWorldX = view.camera.x + halfWidthWorld + edgePadWorld;
  const minWorldY = view.camera.y - halfHeightWorld - edgePadWorld;
  const maxWorldY = view.camera.y + halfHeightWorld + edgePadWorld;
  const screenCenterX = view.viewWidth / 2;
  const screenCenterY = view.viewHeight / 2;
  const visibleNodeIds = view.getFilterVisibleNodeIds();
  const hasFilter = visibleNodeIds instanceof Set;
  const filterNodeIds = hasFilter ? view.getFilterNodeIds() : new Set();
  const isNameFilterMode =
    hasFilter && view.getEffectiveSearchSource() === 'name' && filterNodeIds.size > 0;
  const focusNodeId = view.focusNodeId;
  const focusProgress = view.focusProgress;
  const hasFocus = !!focusNodeId && focusProgress > 0.001;
  const hoverFocusNodeId = view.hoverFocusNodeId;
  const hoverFocusProgress = view.hoverFocusProgress;
  const hasHoverFocus = !!hoverFocusNodeId && hoverFocusProgress > 0.001;
  const hoverFadeNodeId = view.hoverFadeNodeId;
  const hoverFadeProgress = view.hoverFadeProgress;
  const hasHoverFade = !!hoverFadeNodeId && hoverFadeProgress > 0.001;
  const hasAnyFocus = hasFocus || hasHoverFocus || hasHoverFade;
  const combinedFocusProgress = Math.max(focusProgress, hoverFocusProgress, hoverFadeProgress);
  const searchHighlightNodeIds = view.getSearchHighlightNodeIds();
  const hasSearchHighlight =
    view.searchMode === 'find' &&
    searchHighlightNodeIds instanceof Set &&
    searchHighlightNodeIds.size > 0;
  const searchDimAlpha = hasSearchHighlight ? getHoverDimAlpha(view.plugin, 1) : 1;
  const focusDimAlpha = getHoverDimAlpha(view.plugin, combinedFocusProgress);
  const normalEdgeAlpha = hasSearchHighlight ? searchDimAlpha : hasAnyFocus ? focusDimAlpha : 1;
  const devicePixelRatio = Number(view.devicePixelRatio) || 1;
  const backingScale = getBackingScale(view);
  const edgeAppearance = getEdgeAppearance(view);
  // Highlighted edges move towards the theme text color for contrast.
  const focusContrastColor = (view.canvasTheme || DARK_THEME).text;
  const hoverHighlightColor = getHoverHighlightColor(view);
  // Edges sharing one appearance are stroked as a single path, so translucent edges
  // never stack where they cross or overlap. Layers keep painted and focused edges on top.
  const edgeBuckets = new Map();
  const addEdgeSegment = (layer, color, physicalWidth, alpha, x1, y1, x2, y2) => {
    const key = `${layer}|${color}|${physicalWidth}|${alpha}`;
    let bucket = edgeBuckets.get(key);
    if (!bucket) {
      bucket = { layer, color, physicalWidth, alpha, points: [] };
      edgeBuckets.set(key, bucket);
    }
    bucket.points.push(x1, y1, x2, y2);
  };

  for (const edge of view.edges) {
    if (hasFilter) {
      if (!visibleNodeIds.has(edge.source) || !visibleNodeIds.has(edge.target)) continue;
      if (isNameFilterMode) {
        const isFilterEdge = filterNodeIds.has(edge.source) || filterNodeIds.has(edge.target);
        if (!isFilterEdge) continue;
      }
    }
    const sourceNode = edge.sourceNode || view.nodeById.get(edge.source);
    const targetNode = edge.targetNode || view.nodeById.get(edge.target);
    if (!sourceNode || !targetNode) continue;

    if (
      (sourceNode.x < minWorldX && targetNode.x < minWorldX) ||
      (sourceNode.x > maxWorldX && targetNode.x > maxWorldX) ||
      (sourceNode.y < minWorldY && targetNode.y < minWorldY) ||
      (sourceNode.y > maxWorldY && targetNode.y > maxWorldY)
    ) {
      continue;
    }

    const sourcePointX = (sourceNode.x - view.camera.x) * zoom + screenCenterX;
    const sourcePointY = (sourceNode.y - view.camera.y) * zoom + screenCenterY;
    const targetPointX = (targetNode.x - view.camera.x) * zoom + screenCenterX;
    const targetPointY = (targetNode.y - view.camera.y) * zoom + screenCenterY;
    const sourcePaintColor = view.plugin.getPaintedEdgeColor(sourceNode.id);
    const targetPaintColor = view.plugin.getPaintedEdgeColor(targetNode.id);
    const paintedColor = sourcePaintColor || targetPaintColor;
    const edgeScale = getEdgeVisualSetting(
      view.plugin,
      edge.source,
      edge.target,
      'edge_width_scale'
    );

    const isHoverFocusEdge =
      !!hoverFocusNodeId && (edge.source === hoverFocusNodeId || edge.target === hoverFocusNodeId);
    const isHoverFadeEdge =
      !!hoverFadeNodeId && (edge.source === hoverFadeNodeId || edge.target === hoverFadeNodeId);
    const hoverFocusEdgeProgress = isHoverFocusEdge ? hoverFocusProgress : 0;
    const hoverFadeEdgeProgress = isHoverFadeEdge ? hoverFadeProgress : 0;
    const searchEdgeProgress =
      hasSearchHighlight &&
      view.plugin.getSettings().show_search_connections &&
      (searchHighlightNodeIds.has(edge.source) || searchHighlightNodeIds.has(edge.target))
        ? 1
        : 0;
    const focusEdgeProgress = Math.max(
      searchEdgeProgress,
      hoverFocusEdgeProgress,
      hoverFadeEdgeProgress
    );

    if (!paintedColor && focusEdgeProgress <= 0.001) {
      addEdgeSegment(
        0,
        edgeAppearance.color,
        edgeScale,
        normalEdgeAlpha * edgeAppearance.opacity,
        sourcePointX,
        sourcePointY,
        targetPointX,
        targetPointY
      );
      continue;
    }

    // Quantized progress keeps the number of distinct edge buckets small during animation.
    const edgeProgress = quantizeFocusProgress(focusEdgeProgress);
    const physicalWidth = getFocusEdgeWidth(edgeScale, edgeProgress);
    const color = getFocusEdgeColor(
      paintedColor && /^#[0-9a-f]{6}$/i.test(paintedColor) ? paintedColor : edgeAppearance.color,
      focusContrastColor,
      edgeProgress,
      hoverHighlightColor
    );
    // Painted edges stay softer at rest; highlighted edges of any kind become fully opaque.
    const restAlpha = normalEdgeAlpha * (paintedColor ? 0.65 : 1) * edgeAppearance.opacity;
    const alpha = getFocusEdgeAlpha(restAlpha, edgeProgress);
    addEdgeSegment(
      edgeProgress > 0 ? 2 : 1,
      color,
      physicalWidth,
      alpha,
      sourcePointX,
      sourcePointY,
      targetPointX,
      targetPointY
    );
  }

  const buckets = [...edgeBuckets.values()].sort((a, b) => a.layer - b.layer);
  for (const bucket of buckets) {
    ctx.strokeStyle = bucket.color;
    setCrispStroke(
      ctx,
      getEdgeCssWidth(bucket.physicalWidth, devicePixelRatio),
      bucket.alpha,
      backingScale
    );
    ctx.beginPath();
    const points = bucket.points;
    for (let i = 0; i < points.length; i += 4) {
      ctx.moveTo(points[i], points[i + 1]);
      ctx.lineTo(points[i + 2], points[i + 3]);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

// Draw node auras.
function drawNodeAuras(view, ctx) {
  const visible = view.getFilterVisibleNodeIds();
  const colors = getGroupColorMap(view);
  for (const node of view.nodes) {
    if (visible instanceof Set && !visible.has(node.id)) continue;
    const radius =
      (getNodeVisualSetting(view.plugin, node.id, 'aura_radius') * view.camera.zoom) / 10;
    const brightness = getNodeVisualSetting(view.plugin, node.id, 'aura_brightness') / 100;
    if (!(radius > 0) || !(brightness > 0)) continue;
    const point = view.worldToScreen(node.x, node.y);
    if (
      point.x + radius < 0 ||
      point.y + radius < 0 ||
      point.x - radius > view.viewWidth ||
      point.y - radius > view.viewHeight
    )
      continue;
    const color = getNodeColor(view.plugin, node, colors?.get(node.id));
    const gradient = ctx.createRadialGradient(point.x, point.y, 0, point.x, point.y, radius);
    gradient.addColorStop(0, hexToRgba(color, brightness));
    gradient.addColorStop(0.4, hexToRgba(color, brightness * (6 / 11)));
    gradient.addColorStop(1, hexToRgba(color, 0));
    ctx.save();
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function drawNodes(view, ctx) {
  const zoom = Math.max(view.camera.zoom, 0.0001);
  const halfWidthWorld = view.viewWidth / (2 * zoom);
  const halfHeightWorld = view.viewHeight / (2 * zoom);
  const nodePadWorld = 80 / zoom;
  const minWorldX = view.camera.x - halfWidthWorld - nodePadWorld;
  const maxWorldX = view.camera.x + halfWidthWorld + nodePadWorld;
  const minWorldY = view.camera.y - halfHeightWorld - nodePadWorld;
  const maxWorldY = view.camera.y + halfHeightWorld + nodePadWorld;
  const screenCenterX = view.viewWidth / 2;
  const screenCenterY = view.viewHeight / 2;
  const theme = view.canvasTheme || DARK_THEME;
  const hoverRingColor = getHoverHighlightColor(view);
  const nowMs = Date.now();
  const visibleNodeIds = view.getFilterVisibleNodeIds();
  const hasFilter = visibleNodeIds instanceof Set;
  const focusNodeId = view.focusNodeId;
  const focusProgress = view.focusProgress;
  const hasFocus = !!focusNodeId && focusProgress > 0.001;
  const hoverFocusNodeId = view.hoverFocusNodeId;
  const hoverFocusProgress = view.hoverFocusProgress;
  const hasHoverFocus = !!hoverFocusNodeId && hoverFocusProgress > 0.001;
  const hoverFadeNodeId = view.hoverFadeNodeId;
  const hoverFadeProgress = view.hoverFadeProgress;
  const hasHoverFade = !!hoverFadeNodeId && hoverFadeProgress > 0.001;
  const hoverFocusNeighbors = hasHoverFocus
    ? view.neighborsById.get(hoverFocusNodeId) || new Set()
    : new Set();
  const hoverFadeNeighbors = hasHoverFade
    ? view.neighborsById.get(hoverFadeNodeId) || new Set()
    : new Set();
  const hasAnyFocus = hasFocus || hasHoverFocus || hasHoverFade;
  const combinedFocusProgress = Math.max(focusProgress, hoverFocusProgress, hoverFadeProgress);
  const searchHighlightNodeIds = view.getSearchHighlightNodeIds();
  const hasSearchHighlight =
    view.searchMode === 'find' &&
    searchHighlightNodeIds instanceof Set &&
    searchHighlightNodeIds.size > 0;
  const groupColorByNodeId = getGroupColorMap(view);
  const searchNeighbors = new Set();
  if (hasSearchHighlight && view.plugin.getSettings().show_search_connections) {
    for (const id of searchHighlightNodeIds) {
      if (hasFilter && !visibleNodeIds.has(id)) continue;
      for (const neighbor of view.neighborsById.get(id) || []) searchNeighbors.add(neighbor);
    }
  }
  const selectedNodeIds = view.selectedNodeIds instanceof Set ? view.selectedNodeIds : null;
  const backingScale = getBackingScale(view);

  for (const node of view.nodes) {
    if (hasFilter && (!visibleNodeIds || !visibleNodeIds.has(node.id))) continue;
    if (node.x < minWorldX || node.x > maxWorldX || node.y < minWorldY || node.y > maxWorldY) {
      continue;
    }
    const pointX = (node.x - view.camera.x) * zoom + screenCenterX;
    const pointY = (node.y - view.camera.y) * zoom + screenCenterY;

    const radius = getNodeScreenRadius(getNodeRadius(view, node), zoom);

    const isFocusNode = hasFocus && node.id === focusNodeId;
    const isHoverFocusNode = hasHoverFocus && node.id === hoverFocusNodeId;
    const isHoverNodeRaw = view.hoverNodeId === node.id;
    const isHoverFadeNode = hasHoverFade && node.id === hoverFadeNodeId;
    const isSearchHighlightNode = hasSearchHighlight && searchHighlightNodeIds.has(node.id);
    const isSelectedNode =
      isSearchHighlightNode || (selectedNodeIds ? selectedNodeIds.has(node.id) : false);
    const focusNodeProgress = isFocusNode ? focusProgress : 0;
    const hoverFocusNodeProgress = isHoverFocusNode ? hoverFocusProgress : 0;
    const hoverFadeNodeProgress = isHoverFadeNode ? hoverFadeProgress : 0;
    const hoverFocusNeighborProgress =
      hasHoverFocus && hoverFocusNeighbors.has(node.id) ? hoverFocusProgress : 0;
    const hoverFadeNeighborProgress =
      hasHoverFade && hoverFadeNeighbors.has(node.id) ? hoverFadeProgress : 0;
    const relationProgress = Math.max(
      focusNodeProgress,
      hoverFocusNodeProgress,
      hoverFadeNodeProgress,
      hoverFocusNeighborProgress,
      hoverFadeNeighborProgress
    );
    const hoverVisualProgressBase = isHoverFocusNode
      ? hoverFocusProgress
      : isFocusNode
        ? focusProgress
        : isHoverNodeRaw
          ? 1
          : 0;
    const hoverVisualProgress = Math.max(
      hoverVisualProgressBase,
      isFocusNode ? focusProgress : 0,
      isHoverFadeNode ? hoverFadeProgress : 0
    );
    const isHover = hoverVisualProgress > 0.001;
    const isClickFlash = view.clickFlashNodeId === node.id && nowMs < view.clickFlashUntilMs;
    const groupColor = groupColorByNodeId instanceof Map ? groupColorByNodeId.get(node.id) : null;
    const searchDimAlpha = hasSearchHighlight ? getHoverDimAlpha(view.plugin, 1, node.id) : 1;
    const focusDimAlpha = getHoverDimAlpha(view.plugin, combinedFocusProgress, node.id);
    const nodeAlpha = isClickFlash
      ? 1
      : hasSearchHighlight
        ? isSearchHighlightNode
          ? 1
          : searchDimAlpha +
            (1 - searchDimAlpha) *
              Math.max(
                searchNeighbors.has(node.id) ? 1 : 0,
                hoverFocusNodeProgress,
                hoverFadeNodeProgress,
                hoverFocusNeighborProgress,
                hoverFadeNeighborProgress
              )
        : hasAnyFocus
          ? focusDimAlpha + (1 - focusDimAlpha) * relationProgress
          : 1;

    let fillColor = getNodeColor(view.plugin, node, groupColor);
    if (isClickFlash) fillColor = '#ffffff';

    ctx.globalAlpha = nodeAlpha;
    ctx.fillStyle = fillColor;
    ctx.beginPath();
    ctx.arc(pointX, pointY, radius + (node.meta?.subgraph ? 2 : 0), 0, Math.PI * 2);
    if (node.meta?.subgraph) {
      ctx.strokeStyle = fillColor;
      setCrispStroke(ctx, 3, nodeAlpha, backingScale);
      ctx.stroke();
    } else ctx.fill();

    if (node.meta?.darkEnergy) {
      ctx.strokeStyle = fillColor;
      setCrispStroke(ctx, 1.5, nodeAlpha, backingScale);
      ctx.beginPath();
      ctx.arc(pointX, pointY, radius + 4, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (isHover || isSelectedNode) {
      const hoverStrokeAlpha = Math.max(0.12, hoverVisualProgress);
      const selectedStrokeAlpha = isSelectedNode ? 0.95 : 0;
      const hoverLineWidth = 1 + hoverVisualProgress;
      const selectedLineWidth = isSelectedNode ? 1.4 : 0;
      ctx.strokeStyle = isHover && hoverRingColor ? hoverRingColor : theme.selection;
      setCrispStroke(
        ctx,
        Math.max(hoverLineWidth, selectedLineWidth),
        Math.max(hoverStrokeAlpha, selectedStrokeAlpha),
        backingScale
      );
      ctx.beginPath();
      ctx.arc(pointX, pointY, radius + (node.meta?.subgraph ? 4 : 2), 0, Math.PI * 2);
      ctx.stroke();
    }

    const label = getLabelAppearance(
      zoom,
      getLabelZoomThreshold(view, node.id),
      getLabelFontSize(view, node.id),
      nodeAlpha,
      isSelectedNode || isHover || isFocusNode,
      getLabelMinimumSize(view, node.id)
    );
    if (label.alpha > 0) {
      ctx.globalAlpha = label.alpha;
      ctx.fillStyle = theme.text;
      ctx.font = `${label.fontSize}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(getNodeLabelText(node), pointX, pointY + radius + 8);
    }
  }
  ctx.globalAlpha = 1;

  if (view.clickFlashNodeId && nowMs >= view.clickFlashUntilMs) {
    view.clickFlashNodeId = null;
    view.clickFlashUntilMs = 0;
  }
}

function drawSelectionBox(view, ctx) {
  const boxSelect = view.boxSelectDrag;
  if (!boxSelect) return;
  const left = Math.min(boxSelect.startX, boxSelect.currentX);
  const top = Math.min(boxSelect.startY, boxSelect.currentY);
  const width = Math.abs(boxSelect.currentX - boxSelect.startX);
  const height = Math.abs(boxSelect.currentY - boxSelect.startY);
  if (width < 1 && height < 1) return;

  ctx.save();
  const theme = view.canvasTheme || DARK_THEME;
  ctx.fillStyle = theme.selection;
  ctx.strokeStyle = theme.selection;
  ctx.setLineDash([5, 3]);
  ctx.globalAlpha = 0.12;
  ctx.fillRect(left, top, width, height);
  setCrispStroke(ctx, 1, 0.9, getBackingScale(view));
  ctx.strokeRect(left, top, width, height);
  ctx.restore();
}

module.exports = {
  stepFocusSmoothing,
  renderFrame,
  getHoverDimAlpha,
  hexToRgba,
  getNodeLabelText,
  getNodeRadius,
  getBackingScale,
  getEdgeAppearance,
  getLabelZoomThreshold,
  getLabelFontSize,
  getLabelMinimumSize,
  getGroupColorForNode,
  getGroupStyleMap,
  nodeMatchesParsedGroup,
  drawGrid,
  drawHiddenGridMarkers,
  drawEdges,
  drawNodes,
  drawNodeAuras,
  drawSelectionBox,
};
