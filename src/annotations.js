import { DARK_THEME } from './theme.js';

const ANNOTATION_PREFIX = 'text:';
const DEFAULT_ANNOTATION = Object.freeze({
  text: 'New label',
  size: 24,
  color: null,
  border: false,
  width: null,
  height: null,
});

function clampFinite(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

function normalizeAnnotationColor(raw) {
  const text = String(raw ?? '').trim();
  return /^#[0-9a-f]{6}$/i.test(text) ? text.toLowerCase() : null;
}

function normalizeAnnotations(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const result = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : '';
    const text = typeof item.text === 'string' ? item.text.trim().slice(0, 2000) : '';
    if (!id || !text || seen.has(id)) continue;
    seen.add(id);
    result.push({
      id,
      text,
      x: clampFinite(item.x, -1e7, 1e7, 0),
      y: clampFinite(item.y, -1e7, 1e7, 0),
      size: clampFinite(item.size, 10, 120, DEFAULT_ANNOTATION.size),
      color: normalizeAnnotationColor(item.color),
      border: false,
      width: null,
      height: null,
    });
  }
  return result;
}

function getAnnotationMetrics(item, ctx = null) {
  const lines = String(item.text || '')
    .split(/\r?\n/u)
    .map((line) => line.trimEnd());
  const size = clampFinite(item.size, 10, 120, DEFAULT_ANNOTATION.size);
  const lineHeight = size * 1.22;
  let textWidth = 0;
  if (ctx && typeof ctx.measureText === 'function') {
    ctx.save?.();
    ctx.font = `600 ${size}px ui-sans-serif, -apple-system, BlinkMacSystemFont, sans-serif`;
    for (const line of lines) {
      textWidth = Math.max(textWidth, Number(ctx.measureText(line).width) || 0);
    }
    ctx.restore?.();
  }
  if (!(textWidth > 0)) {
    const maxChars = lines.reduce((best, line) => Math.max(best, line.length), 1);
    textWidth = maxChars * size * 0.6;
  }
  const textHeight = Math.max(lineHeight, lines.length * lineHeight);
  const width = textWidth;
  const height = textHeight;
  const left = item.x - width / 2;
  const top = item.y - height / 2;
  const textTop = top;
  return {
    lines,
    size,
    lineHeight,
    textWidth,
    textHeight,
    textLeft: item.x - textWidth / 2,
    textTop,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
  };
}

// Hit-test text label bounds only (frames temporarily disabled).
function hitTestAnnotation(annotations, worldX, worldY, zoom = 1, ctx = null) {
  const list = Array.isArray(annotations) ? annotations : [];
  const scale = Math.max(0.05, Number(zoom) || 1);
  const pad = Math.max(4, 6 / scale);
  for (let i = list.length - 1; i >= 0; i--) {
    const item = list[i];
    const m = getAnnotationMetrics(item, ctx);
    if (
      worldX >= m.textLeft - pad &&
      worldX <= m.textLeft + m.textWidth + pad &&
      worldY >= m.textTop - pad &&
      worldY <= m.textTop + m.textHeight + pad
    ) {
      return { item, part: 'move', metrics: m };
    }
  }
  return null;
}

function drawAnnotationFrames() {}

function drawAnnotationLabels(view, ctx) {
  const items = view.plugin?.data?.annotations;
  if (!Array.isArray(items) || !items.length) return;
  const zoom = Math.max(view.camera.zoom, 0.0001);
  const cx = view.viewWidth / 2;
  const cy = view.viewHeight / 2;
  const theme = view.canvasTheme || DARK_THEME;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const item of items) {
    if (view.editingAnnotationId && view.editingAnnotationId === item.id) continue;
    const m = getAnnotationMetrics(item, ctx);
    const fontPx = m.size * zoom;
    if (fontPx < 4) continue;
    const sx = (item.x - view.camera.x) * zoom + cx;
    const sy = (m.textTop - view.camera.y) * zoom + cy;
    const sw = m.textWidth * zoom;
    const sh = m.textHeight * zoom;
    if (
      sx + sw / 2 < -20 ||
      sy + sh < -20 ||
      sx - sw / 2 > view.viewWidth + 20 ||
      sy > view.viewHeight + 20
    ) {
      continue;
    }
    const hovered = view.hoverAnnotationId === item.id;
    ctx.font = `600 ${fontPx}px ui-sans-serif, -apple-system, BlinkMacSystemFont, sans-serif`;
    ctx.fillStyle = item.color || theme.text;
    ctx.globalAlpha = hovered ? 1 : 0.9;
    const stepY = m.lineHeight * zoom;
    for (let i = 0; i < m.lines.length; i++) {
      ctx.fillText(m.lines[i], sx, sy + i * stepY);
    }
  }
  ctx.restore();
}

export {
  ANNOTATION_PREFIX,
  DEFAULT_ANNOTATION,
  normalizeAnnotationColor,
  normalizeAnnotations,
  getAnnotationMetrics,
  hitTestAnnotation,
  drawAnnotationFrames,
  drawAnnotationLabels,
};
