// Screen metrics shared by the live canvas and static HTML exports.
// Every function is self-contained: exports embed them verbatim through toString().

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

// Open arrowheads share the link's stroke bucket, opacity and screen-space width.
function getLinkArrowSegments(x1, y1, x2, y2, radius1, radius2, reverse, reciprocal, width) {
  const length = Math.hypot(x2 - x1, y2 - y1);
  const size = Math.max(5, Math.min(12, 5 + width));
  if (length < radius1 + radius2 + size + 4) return [];
  const ux = (x2 - x1) / length,
    uy = (y2 - y1) / length;
  const points = [];
  const head = (x, y, radius, sign) => {
    const tx = x - ux * sign * (radius + 2),
      ty = y - uy * sign * (radius + 2);
    const bx = tx - ux * sign * size,
      by = ty - uy * sign * size;
    points.push(
      bx - uy * size * 0.5,
      by + ux * size * 0.5,
      tx,
      ty,
      tx,
      ty,
      bx + uy * size * 0.5,
      by - ux * size * 0.5
    );
  };
  if (!reverse || reciprocal) head(x2, y2, radius2, 1);
  if (reverse || reciprocal) head(x1, y1, radius1, -1);
  return points;
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

// Highlighted edges keep their own color and move it towards the contrast color
// (the theme text) by up to 45%, so emphasis follows edge_color without a jump.
// A custom hover color replaces that contrast blend and is reached fully.
function getFocusEdgeColor(color, contrastColor, progress, hoverColor) {
  const parse = (value) => {
    const text = String(value || '').trim();
    let match = /^#([0-9a-f]{3})$/i.exec(text);
    if (match) return match[1].split('').map((digit) => Number.parseInt(digit + digit, 16));
    match = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(text);
    if (match) return [0, 2, 4].map((at) => Number.parseInt(match[1].slice(at, at + 2), 16));
    match = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(text);
    if (match) return [1, 2, 3].map((at) => Math.max(0, Math.min(255, Number(match[at]))));
    return null;
  };
  const custom = /^#[0-9a-f]{6}$/i.test(String(hoverColor || '')) ? hoverColor : null;
  const amount = quantizeFocusProgress(progress) * (custom ? 1 : 0.45);
  const from = parse(color);
  const to = parse(custom || contrastColor);
  if (!from || !to || amount <= 0) return color;
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

// Highlighted edges lose their translucency: opacity rises with progress to fully opaque.
function getFocusEdgeAlpha(baseAlpha, progress) {
  const base = Math.max(0, Math.min(1, Number(baseAlpha) || 0));
  return base + (1 - base) * quantizeFocusProgress(progress);
}

module.exports = {
  getLowDegreeAlpha,
  getLinkArrowSegments,
  quantizeFocusProgress,
  getFocusEdgeWidth,
  getFocusEdgeColor,
  getFocusEdgeAlpha,
  getNodeScreenRadius,
  getNodeWorldRadius,
  getEdgeCssWidth,
  setCrispStroke,
  getCrispCoordinate,
};
