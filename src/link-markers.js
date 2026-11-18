// Coordinates run from the rear (x=0) to the tip (x=1). The picker and
// renderer share these outlines; 0 remains the legacy default chevron.
const triangle = [
  [0, -0.55],
  [1, 0],
  [0, 0.55],
];
const diamond = [
  [0, 0],
  [0.5, -0.5],
  [1, 0],
  [0.5, 0.5],
];
const markers = [
  { name: 'Chevron', points: [triangle[0], triangle[1], triangle[2]] },
  { name: 'Outline triangle', points: triangle, closed: true },
  { name: 'Filled triangle', points: triangle, closed: true, fill: true },
  {
    name: 'Half arrow',
    points: [
      [0, 0],
      [1, 0],
      [0, 0.65],
    ],
    closed: true,
    fill: true,
  },
  { name: 'Filled diamond', points: diamond, closed: true, fill: true },
  { name: 'Outline diamond', points: diamond, closed: true },
  { name: 'Filled circle', circle: true, fill: true },
  { name: 'Outline circle', circle: true },
  {
    name: 'Bar',
    preview: '<path d="M10 2V14" stroke="black" stroke-width="2"/>',
    points: [
      [1, -0.55],
      [1, 0.55],
    ],
  },
];
const markerOrder = [2, 1, 0, 3, 4, 5, 6, 7, 8];

function linkStylePicker(parent, spec, choose) {
  const strip = parent.createDiv({
    cls: 'graphfrontier-style-strip',
    attr: { role: 'group', 'aria-label': spec.label, 'data-style': spec.key },
  });
  const buttons = spec.values.map((value) => {
    const name = spec.names[value];
    const button = strip.createEl('button', {
      cls: 'graphfrontier-style-choice',
      attr: { type: 'button', title: name, 'aria-label': name },
    });
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      choose(value);
    });
    const icon = button.createSpan({ attr: { 'aria-hidden': 'true' } });
    let body;
    if (spec.key === 'edge_pattern')
      body = `<path d="M1 8H19" stroke="black" stroke-width="1.6" stroke-linecap="round" stroke-dasharray="${['none', '4 3', '0 3'][value]}"/>`;
    else {
      const m = markers[value];
      const geometry = m.circle
        ? '<circle cx="10" cy="8" r="5.5"'
        : '<path d="' +
          m.points
            .map(([x, y], i) => (i ? 'L' : 'M') + (4 + x * 12) + ' ' + (8 + y * 12))
            .join(' ') +
          (m.closed ? 'Z' : '') +
          '"';
      body =
        m.preview ??
        geometry +
          ` fill="${m.fill ? 'black' : 'none'}" stroke="black" stroke-width="1.3" stroke-linejoin="round"/>`;
    }
    icon.style.maskImage =
      'url("data:image/svg+xml,' +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 16">' + body + '</svg>'
      ) +
      '")';
    return [value, button];
  });
  return (current) => {
    for (const [value, b] of buttons) b.setAttribute('aria-pressed', String(current === value));
  };
}
export { markers, markerOrder, linkStylePicker };
