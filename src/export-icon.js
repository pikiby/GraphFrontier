// Store only the SVG geometry used by Obsidian's interface icons.
const svgNS = 'http://www.w3.org/2000/svg';
const tags = new Set([
  'svg',
  'g',
  'path',
  'circle',
  'ellipse',
  'rect',
  'line',
  'polyline',
  'polygon',
]);
const geometry = new Set(
  'viewBox width height d points x y x1 x2 y1 y2 cx cy r rx ry transform stroke-width stroke-linecap stroke-linejoin fill-rule clip-rule opacity fill-opacity stroke-opacity'.split(
    ' '
  )
);

function allowed(name, value) {
  if (typeof value !== 'string') return false;
  if (geometry.has(name)) return true;
  if (name === 'class') return /^(?:(?:svg-icon|lucide(?:-[\w-]+)?)(?:\s+|$))+$/u.test(value);
  return (
    (name === 'stroke' || name === 'fill') &&
    /^(?:none|currentColor|transparent|black|white|#[\da-f]{3,8})$/iu.test(value)
  );
}

function captureIcon(el) {
  if (el?.namespaceURI !== svgNS || !tags.has(el.localName)) return null;
  return {
    tag: el.localName,
    attrs: Array.from(el.attributes)
      .filter((a) => !a.namespaceURI && allowed(a.name, a.value))
      .map((a) => [a.name, a.value]),
    children: Array.from(el.children, captureIcon).filter(Boolean),
  };
}

function drawIcon(doc, data) {
  if (!data || !tags.has(data.tag) || !Array.isArray(data.attrs) || !Array.isArray(data.children))
    return null;
  const el = doc.createElementNS(svgNS, data.tag);
  for (const pair of data.attrs) {
    if (Array.isArray(pair) && allowed(pair[0], pair[1])) el.setAttribute(pair[0], pair[1]);
  }
  for (const child of data.children) {
    const node = drawIcon(doc, child);
    if (node) el.appendChild(node);
  }
  return el;
}

export { captureIcon, drawIcon };
