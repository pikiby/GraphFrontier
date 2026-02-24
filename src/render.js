const { DEFAULT_DATA, MAX_ZOOM, ZOOM_STEP_FACTOR } = require('./constants');

// Focus dimming helper: computes alpha of non-focused graph elements.
function getHoverDimAlpha(plugin, focusProgress) {
  const clampedProgress = Math.max(0, Math.min(1, Number(focusProgress) || 0));
  const dimStrength = plugin.clampNumber(
    plugin.getSettings().hover_dim_strength,
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

  const baseSearchFocusNodeId = view.getFilterNodeId() || view.getFindFocusNodeId();
  const hoverTargetNodeId =
    baseSearchFocusNodeId && view.hoverNodeId && view.hoverNodeId !== baseSearchFocusNodeId
      ? view.hoverNodeId
      : null;

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
  view.syncSidePanelControls();

  const ctx = view.ctx;
  const width = view.viewWidth;
  const height = view.viewHeight;

  const styles = getComputedStyle(view.contentEl);
  const bgColor = styles.getPropertyValue('--background-primary').trim() || '#111418';

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, width, height);

  if (view.plugin.getSettings().show_grid) {
    drawGrid(view, ctx);
  }

  drawEdges(view, ctx);
  drawNodes(view, ctx);
}

// Draw hovered node title in a compact floating bubble.
function drawFocusedNodeTitle(view, ctx, node) {
  const point = view.worldToScreen(node.x, node.y);
  const labelBase = String(node.label || '');
  if (!labelBase) return;
  const fileType = getNodeFileTypeLabel(node);
  const labelText = fileType ? `${labelBase} (${fileType})` : labelBase;

  const fontSize = 13;
  const padX = 7;
  const padY = 4;

  ctx.save();
  ctx.font = `${fontSize}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`;
  const textWidth = ctx.measureText(labelText).width;
  const boxWidth = textWidth + padX * 2;
  const boxHeight = fontSize + padY * 2;
  const radius = Math.min(8, boxHeight / 2);
  const boxX = Math.max(6, Math.min(view.viewWidth - boxWidth - 6, point.x - boxWidth / 2));
  const boxY = Math.max(6, point.y - boxHeight - 10);

  ctx.fillStyle = 'rgba(9, 12, 17, 0.55)';
  ctx.beginPath();
  ctx.moveTo(boxX + radius, boxY);
  ctx.lineTo(boxX + boxWidth - radius, boxY);
  ctx.arcTo(boxX + boxWidth, boxY, boxX + boxWidth, boxY + radius, radius);
  ctx.lineTo(boxX + boxWidth, boxY + boxHeight - radius);
  ctx.arcTo(boxX + boxWidth, boxY + boxHeight, boxX + boxWidth - radius, boxY + boxHeight, radius);
  ctx.lineTo(boxX + radius, boxY + boxHeight);
  ctx.arcTo(boxX, boxY + boxHeight, boxX, boxY + boxHeight - radius, radius);
  ctx.lineTo(boxX, boxY + radius);
  ctx.arcTo(boxX, boxY, boxX + radius, boxY, radius);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = 'rgba(255, 255, 255, 1)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(labelText, boxX + padX, boxY + padY);
  ctx.restore();
}

// Extract node file type used in hover title (md, png, pdf, etc.).
function getNodeFileTypeLabel(node) {
  const metaType = String(node?.meta?.fileType || '')
    .trim()
    .toLowerCase();
  if (metaType) return metaType;
  const pathText = String(node?.id || '').trim();
  const extMatch = /\.([^.\/]+)$/u.exec(pathText);
  if (extMatch && extMatch[1]) return String(extMatch[1]).toLowerCase();
  if (node?.meta?.isAttachment) return 'attachment';
  return 'md';
}

// Node radius formula with attachment-specific size multiplier.
function getNodeRadius(view, node) {
  const nodeScaleRaw = view.plugin.clampNumber(
    view.plugin.getSettings().node_size_scale,
    0.1,
    2,
    DEFAULT_DATA.settings.node_size_scale
  );
  const attachmentSizeMultiplier = view.plugin.clampNumber(
    view.plugin.getSettings().attachment_size_multiplier,
    0.1,
    1,
    DEFAULT_DATA.settings.attachment_size_multiplier
  );
  // New node-size scale: 0.1 -> 1, max -> 20.
  const nodeScale = nodeScaleRaw * 10;
  const raw = (3 + Math.log2(node.degree + 2) * 1.4) * (nodeScale / 4);
  const isAttachmentNode = !!(node && node.meta && node.meta.isAttachment);
  const scaledRaw = isAttachmentNode ? raw * attachmentSizeMultiplier : raw;
  return Math.max(0.2, Math.min(4, scaledRaw / 5));
}

// Convert slider steps into zoom threshold for label visibility.
function getLabelZoomThreshold(view) {
  const steps = view.plugin.clampNumber(
    view.plugin.getSettings().label_zoom_steps,
    1,
    20,
    DEFAULT_DATA.settings.label_zoom_steps
  );
  // 1 => only at max zoom, 20 => visible 20 wheel-steps back from max zoom.
  return MAX_ZOOM / Math.pow(ZOOM_STEP_FACTOR, steps - 1);
}

// Base label font scale used before camera zoom multiplier.
function getLabelFontSize(view) {
  const baseSize = view.plugin.clampNumber(
    view.plugin.getSettings().label_font_size,
    5,
    20,
    DEFAULT_DATA.settings.label_font_size
  );
  return baseSize / 5;
}

// Resolve first matching group color for a node, according to current row priority.
function getGroupColorForNode(view, node) {
  const groups = Array.isArray(view.plugin.data.groups) ? view.plugin.data.groups : [];
  if (groups.length === 0) return null;
  const meta = view.nodeMetaById.get(node.id) || node.meta || null;
  if (!meta) return null;

  for (const group of groups) {
    if (!group || group.enabled === false) continue;
    const parsed = view.plugin.parseGroupQuery(group.query);
    if (!parsed) continue;
    if (nodeMatchesParsedGroup(meta, parsed)) {
      return view.plugin.normalizeGroupColor(group.color);
    }
  }
  return null;
}

// Match helper used by group-color rules (path/file/tag/line/section/property).
function nodeMatchesParsedGroup(meta, parsed) {
  const needle = String(parsed.value || '')
    .trim()
    .toLowerCase();
  if (!needle) return false;

  const includesCI = (value) =>
    String(value || '')
      .toLowerCase()
      .includes(needle);
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

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
  ctx.lineWidth = 1;

  ctx.beginPath();
  for (let x = startX; x <= endX; x += step) {
    const sx = view.worldToScreen(x, 0).x;
    const crispX = Math.round(sx) + 0.5;
    ctx.moveTo(crispX, 0);
    ctx.lineTo(crispX, view.viewHeight);
  }
  for (let y = startY; y <= endY; y += step) {
    const sy = view.worldToScreen(0, y).y;
    const crispY = Math.round(sy) + 0.5;
    ctx.moveTo(0, crispY);
    ctx.lineTo(view.viewWidth, crispY);
  }
  ctx.stroke();
}

// Draw all edges with focus/fade interpolation and painted-edge overrides.
function drawEdges(view, ctx) {
  const edgeScale = view.plugin.clampNumber(
    view.plugin.getSettings().edge_width_scale,
    0.01,
    1,
    DEFAULT_DATA.settings.edge_width_scale
  );
  const paintedEdgeScale = view.plugin.clampNumber(
    view.plugin.getSettings().painted_edge_width,
    0.01,
    1,
    DEFAULT_DATA.settings.painted_edge_width
  );
  const visibleNodeIds = view.getFilterVisibleNodeIds();
  const hasFilter = visibleNodeIds instanceof Set;
  const filterNodeId = hasFilter ? view.getFilterNodeId() : null;
  const isNameFilterMode =
    hasFilter && view.getEffectiveSearchSource() === 'name' && !!filterNodeId;
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
    !hasFilter &&
    !hasAnyFocus &&
    searchHighlightNodeIds instanceof Set &&
    searchHighlightNodeIds.size > 0;
  const searchDimAlpha = hasSearchHighlight ? getHoverDimAlpha(view.plugin, 1) : 1;

  for (const edge of view.edges) {
    if (hasFilter) {
      if (!visibleNodeIds.has(edge.source) || !visibleNodeIds.has(edge.target)) continue;
      if (isNameFilterMode) {
        const isFilterEdge = edge.source === filterNodeId || edge.target === filterNodeId;
        if (!isFilterEdge) continue;
      }
    }
    const sourceNode = view.nodeById.get(edge.source);
    const targetNode = view.nodeById.get(edge.target);
    if (!sourceNode || !targetNode) continue;

    const sourcePoint = view.worldToScreen(sourceNode.x, sourceNode.y);
    const targetPoint = view.worldToScreen(targetNode.x, targetNode.y);
    const sourcePaintColor = view.plugin.getPaintedEdgeColor(sourceNode.id);
    const targetPaintColor = view.plugin.getPaintedEdgeColor(targetNode.id);
    const paintedColor = sourcePaintColor || targetPaintColor;

    const isPrimaryFocusEdge =
      !!focusNodeId && (edge.source === focusNodeId || edge.target === focusNodeId);
    const isHoverFocusEdge =
      !!hoverFocusNodeId && (edge.source === hoverFocusNodeId || edge.target === hoverFocusNodeId);
    const isHoverFadeEdge =
      !!hoverFadeNodeId && (edge.source === hoverFadeNodeId || edge.target === hoverFadeNodeId);
    const primaryFocusEdgeProgress = isPrimaryFocusEdge ? focusProgress : 0;
    const hoverFocusEdgeProgress = isHoverFocusEdge ? hoverFocusProgress : 0;
    const hoverFadeEdgeProgress = isHoverFadeEdge ? hoverFadeProgress : 0;
    const focusEdgeProgress = Math.max(
      primaryFocusEdgeProgress,
      hoverFocusEdgeProgress,
      hoverFadeEdgeProgress
    );
    const dimAlpha = getHoverDimAlpha(view.plugin, combinedFocusProgress);
    const edgeAlpha = hasAnyFocus
      ? dimAlpha + (1 - dimAlpha) * focusEdgeProgress
      : hasSearchHighlight
        ? searchDimAlpha
        : 1;
    ctx.save();
    ctx.globalAlpha = edgeAlpha;

    if (paintedColor) {
      const alpha = 0.65 + (0.95 - 0.65) * focusEdgeProgress;
      ctx.strokeStyle = hexToRgba(paintedColor, alpha);
      ctx.lineWidth = paintedEdgeScale + (2 - paintedEdgeScale) * focusEdgeProgress;
    } else {
      const red = Math.round(145 + (166 - 145) * focusEdgeProgress);
      const green = Math.round(160 + (204 - 160) * focusEdgeProgress);
      const blue = Math.round(187 + (255 - 187) * focusEdgeProgress);
      const alpha = 0.35 + (0.95 - 0.35) * focusEdgeProgress;
      ctx.strokeStyle = `rgba(${red}, ${green}, ${blue}, ${alpha})`;
      ctx.lineWidth = edgeScale + (2 - edgeScale) * focusEdgeProgress;
    }

    ctx.beginPath();
    ctx.moveTo(sourcePoint.x, sourcePoint.y);
    ctx.lineTo(targetPoint.x, targetPoint.y);
    ctx.stroke();
    ctx.restore();
  }
}

// Draw nodes, labels, hover outlines, and hovered title popup.
function drawNodes(view, ctx) {
  const zoom = view.camera.zoom;
  const labelMinZoom = getLabelZoomThreshold(view);
  const labelFontSize = getLabelFontSize(view);
  const labelFadeRange = Math.max(0.001, labelMinZoom * 0.35);
  const nowMs = Date.now();
  const visibleNodeIds = view.getFilterVisibleNodeIds();
  const hasFilter = visibleNodeIds instanceof Set;
  const focusNodeId = view.focusNodeId;
  const focusProgress = view.focusProgress;
  const hasFocus = !!focusNodeId && focusProgress > 0.001;
  const focusNeighbors = hasFocus ? view.neighborsById.get(focusNodeId) || new Set() : new Set();
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
  const hasSearchFocus = !!(view.getFilterNodeId() || view.getFindFocusNodeId());
  const searchHighlightNodeIds = view.getSearchHighlightNodeIds();
  const hasSearchHighlight =
    !hasFilter &&
    !hasAnyFocus &&
    searchHighlightNodeIds instanceof Set &&
    searchHighlightNodeIds.size > 0;
  const searchDimAlpha = hasSearchHighlight ? getHoverDimAlpha(view.plugin, 1) : 1;

  for (const node of view.nodes) {
    if (hasFilter && (!visibleNodeIds || !visibleNodeIds.has(node.id))) continue;
    const point = view.worldToScreen(node.x, node.y);
    if (
      point.x < -80 ||
      point.x > view.viewWidth + 80 ||
      point.y < -80 ||
      point.y > view.viewHeight + 80
    ) {
      continue;
    }

    const radius = Math.max(0.6, getNodeRadius(view, node) * view.camera.zoom);

    const isFocusNode = hasFocus && node.id === focusNodeId;
    const isHoverFocusNode = hasHoverFocus && node.id === hoverFocusNodeId;
    const isHoverNodeRaw = view.hoverNodeId === node.id;
    const isHoverFadeNode = hasHoverFade && node.id === hoverFadeNodeId;
    const focusNodeProgress = isFocusNode ? focusProgress : 0;
    const hoverFocusNodeProgress = isHoverFocusNode ? hoverFocusProgress : 0;
    const hoverFadeNodeProgress = isHoverFadeNode ? hoverFadeProgress : 0;
    const focusNeighborProgress = hasFocus && focusNeighbors.has(node.id) ? focusProgress : 0;
    const hoverFocusNeighborProgress =
      hasHoverFocus && hoverFocusNeighbors.has(node.id) ? hoverFocusProgress : 0;
    const hoverFadeNeighborProgress =
      hasHoverFade && hoverFadeNeighbors.has(node.id) ? hoverFadeProgress : 0;
    const relationProgress = Math.max(
      focusNodeProgress,
      hoverFocusNodeProgress,
      hoverFadeNodeProgress,
      focusNeighborProgress,
      hoverFocusNeighborProgress,
      hoverFadeNeighborProgress
    );
    const hoverVisualProgressBase = hasSearchFocus
      ? isHoverFocusNode
        ? hoverFocusProgress
        : 0
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
    const groupColor = getGroupColorForNode(view, node);
    const dimAlpha = getHoverDimAlpha(view.plugin, combinedFocusProgress);
    const isSearchHighlightNode = hasSearchHighlight && searchHighlightNodeIds.has(node.id);
    const nodeAlpha = isClickFlash
      ? 1
      : hasAnyFocus
        ? dimAlpha + (1 - dimAlpha) * relationProgress
        : hasSearchHighlight
          ? isSearchHighlightNode
            ? 1
            : searchDimAlpha
          : 1;

    let fillColor = '#7aa2f7';
    if (groupColor) fillColor = groupColor;
    if (isClickFlash) fillColor = '#ffffff';

    ctx.save();
    ctx.globalAlpha = nodeAlpha;
    ctx.fillStyle = fillColor;
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    if (isHover) {
      const hoverStrokeAlpha = Math.max(0.12, 0.95 * hoverVisualProgress);
      const hoverLineWidth = 1 + hoverVisualProgress;
      ctx.save();
      ctx.strokeStyle = `rgba(255, 255, 255, ${hoverStrokeAlpha})`;
      ctx.lineWidth = hoverLineWidth;
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius + 2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    const labelAlphaRaw = (zoom - labelMinZoom) / labelFadeRange;
    const labelAlphaBase = Math.max(0, Math.min(1, labelAlphaRaw));
    const hoverLabelBoost = hoverVisualProgress;
    const isAttachmentNode = !!(node && node.meta && node.meta.isAttachment);
    const labelAlpha = isAttachmentNode ? 0 : Math.max(labelAlphaBase, hoverLabelBoost);
    if (labelAlpha > 0.01) {
      const zoomedFontSize = Math.max(1, labelFontSize * zoom);
      ctx.save();
      ctx.globalAlpha = labelAlpha * nodeAlpha;
      ctx.fillStyle =
        hoverLabelBoost > 0.001 ? 'rgba(255, 235, 164, 1)' : 'rgba(238, 243, 252, 0.95)';
      ctx.font = `${zoomedFontSize}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(node.label, point.x, point.y + radius + 8);
      ctx.restore();
    }
  }

  const hoverTitleNode = view.hoverNodeId ? view.nodeById.get(view.hoverNodeId) || null : null;
  if (hoverTitleNode) drawFocusedNodeTitle(view, ctx, hoverTitleNode);
  if (view.clickFlashNodeId && nowMs >= view.clickFlashUntilMs) {
    view.clickFlashNodeId = null;
    view.clickFlashUntilMs = 0;
  }
}

module.exports = {
  stepFocusSmoothing,
  renderFrame,
  getHoverDimAlpha,
  hexToRgba,
  drawFocusedNodeTitle,
  getNodeRadius,
  getLabelZoomThreshold,
  getLabelFontSize,
  getGroupColorForNode,
  nodeMatchesParsedGroup,
  drawGrid,
  drawEdges,
  drawNodes,
};
