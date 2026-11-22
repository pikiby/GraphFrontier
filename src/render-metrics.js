// Screen metrics of the canvas: node and link sizes, arrows, crisp strokes and focus fading.

// Like Obsidian's graph, on-screen node size follows the square root of zoom.
function getNodeScreenRadius(baseRadius, zoom) {
  return Math.max(0.6, baseRadius * Math.sqrt(Math.max(zoom, 0.0001)));
}

// World-space radius matching getNodeScreenRadius, for hit testing.
function getNodeWorldRadius(baseRadius, zoom) {
  return baseRadius / Math.sqrt(Math.max(zoom, 0.0001));
}

function getLowDegreeAlpha(enabled, degree, highlighted) {
  return enabled && Number(degree || 0) <= 1 && !highlighted ? 0.65 : 1;
}

function getLinkHeads(x1, y1, x2, y2, r1, r2, reverse, reciprocal, width, shape = 0, scale = 1) {
  const length = Math.hypot(x2 - x1, y2 - y1);
  const size = Math.max(5, Math.min(12, 5 + width)) * scale;
  if (length < r1 + r2 + size * (reciprocal ? 2 : 1) + 4) return [];
  const dx = (x2 - x1) / length,
    dy = (y2 - y1) / length;
  const heads = [];
  const add = (x, y, r, sign) =>
    heads.push({
      x: x - dx * sign * (r + 2),
      y: y - dy * sign * (r + 2),
      dx: dx * sign,
      dy: dy * sign,
      size,
      shape,
      source: sign < 0,
    });
  if (!reverse || reciprocal) add(x2, y2, r2, 1);
  if (reverse || reciprocal) add(x1, y1, r1, -1);
  return heads;
}

// Edge widths are physical screen pixels, independent of zoom.
function getEdgeCssWidth(physicalWidth, devicePixelRatio) {
  return physicalWidth / Math.max(devicePixelRatio || 1, 0.0001);
}

// Lines thinner than one backing-store pixel break into dashes when antialiased.
// Draw exactly one backing pixel instead and convey the thinness through opacity.
function setCrispStroke(ctx, cssWidth, alpha, backingScale) {
  const scale = Math.max(backingScale || 1, 0.0001);
  const backingWidth = Math.max(0, cssWidth) * scale;
  if (backingWidth >= 1) {
    ctx.lineWidth = cssWidth;
    ctx.globalAlpha = alpha;
  } else {
    ctx.lineWidth = 1 / scale;
    ctx.globalAlpha = alpha * backingWidth;
  }
}

// Align an axis-parallel line to the backing-store pixel grid: odd widths centre on
// a pixel, even widths on a pixel boundary, so neither blurs across two pixels.
function getCrispCoordinate(value, backingScale, cssWidth) {
  const scale = Math.max(backingScale || 1, 0.0001);
  const backingWidth = Math.max(1, Math.round(Math.max(0, cssWidth) * scale));
  return (Math.round(value * scale) + (backingWidth % 2 ? 0.5 : 0)) / scale;
}

// Highlight animation progress in eighths: smooth to the eye, few edge buckets.
function quantizeFocusProgress(progress) {
  return Math.round(Math.max(0, Math.min(1, Number(progress) || 0)) * 8) / 8;
}

// Highlighted edges grow relative to their own width, in physical pixels: at least
// twice as thick and one pixel thicker, never above 12 or below the base.
function getFocusEdgeWidth(physicalWidth, progress) {
  const base = Math.max(0, Number(physicalWidth) || 0);
  const target = Math.max(base, Math.min(12, Math.max(base * 2, base + 1)));
  return base + (target - base) * quantizeFocusProgress(progress);
}

function parseColorChannels(value) {
  const text = String(value || '').trim();
  let match = /^#([0-9a-f]{3})$/i.exec(text);
  if (match) return match[1].split('').map((digit) => Number.parseInt(digit + digit, 16));
  match = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(text);
  if (match) return [0, 2, 4].map((at) => Number.parseInt(match[1].slice(at, at + 2), 16));
  match = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(text);
  if (match) return [1, 2, 3].map((at) => Math.max(0, Math.min(255, Number(match[at]))));
  return null;
}

function blendColorChannels(from, to, amount) {
  return (
    '#' +
    from
      .map((channel, index) =>
        Math.round(channel + (to[index] - channel) * amount)
          .toString(16)
          .padStart(2, '0')
      )
      .join('')
  );
}

const NODE_BORDER_COLOR_CACHE = new Map();

// Auto-contrast outline color for filled nodes: subtly lightens dark/saturated colors on dark
// themes and darkens light/medium colors on light themes so adjacent/low-contrast nodes stay crisp.
function getNodeBorderColor(fillColor, theme) {
  const isLight = theme?.colorScheme === 'light';
  const cacheKey = `${fillColor}|${isLight ? 'L' : 'D'}`;
  const cached = NODE_BORDER_COLOR_CACHE.get(cacheKey);
  if (cached) return cached;
  const channels = parseColorChannels(fillColor);
  if (!channels) return theme?.text || '#e6e8ed';
  const [r, g, b] = channels;
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  let result;
  if (isLight) {
    result =
      luminance > 0.22
        ? blendColorChannels(channels, [0, 0, 0], 0.36)
        : blendColorChannels(channels, [255, 255, 255], 0.36);
  } else {
    result =
      luminance < 0.78
        ? blendColorChannels(channels, [255, 255, 255], 0.4)
        : blendColorChannels(channels, parseColorChannels(theme?.background) || [17, 20, 24], 0.32);
  }
  if (NODE_BORDER_COLOR_CACHE.size > 512) NODE_BORDER_COLOR_CACHE.clear();
  NODE_BORDER_COLOR_CACHE.set(cacheKey, result);
  return result;
}

// Highlighted edges keep their own color and move it towards the contrast color
// (the theme text) by up to 45%, so emphasis follows edge_color without a jump.
// A custom hover color replaces that contrast blend and is reached fully.
function getFocusEdgeColor(color, contrastColor, progress, hoverColor) {
  const custom = /^#[0-9a-f]{6}$/i.test(String(hoverColor || '')) ? hoverColor : null;
  const amount = quantizeFocusProgress(progress) * (custom ? 1 : 0.45);
  const from = parseColorChannels(color);
  const to = parseColorChannels(custom || contrastColor);
  if (!from || !to || amount <= 0) return color;
  return blendColorChannels(from, to, amount);
}

// Highlighted edges lose their translucency: opacity rises with progress to fully opaque.
function getFocusEdgeAlpha(baseAlpha, progress) {
  const base = Math.max(0, Math.min(1, Number(baseAlpha) || 0));
  return base + (1 - base) * quantizeFocusProgress(progress);
}

export {
  getLowDegreeAlpha,
  getLinkHeads,
  quantizeFocusProgress,
  getFocusEdgeWidth,
  getFocusEdgeColor,
  getFocusEdgeAlpha,
  getNodeBorderColor,
  getNodeScreenRadius,
  getNodeWorldRadius,
  getEdgeCssWidth,
  setCrispStroke,
  getCrispCoordinate,
};
