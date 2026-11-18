const test = require('node:test');
const assert = require('node:assert/strict');
const { captureIcon, drawIcon } = require('../src/export-icon');

const doc = {
  createElementNS(namespaceURI, localName) {
    return {
      namespaceURI,
      localName,
      attributes: [],
      children: [],
      setAttribute(name, value) {
        this.attributes.push({ name, value });
      },
      appendChild(el) {
        this.children.push(el);
      },
    };
  },
};
test('exported icons round-trip standard geometry but not unsupported elements, attributes or paint references', () => {
  const ns = 'http://www.w3.org/2000/svg',
    svg = doc.createElementNS(ns, 'svg'),
    path = doc.createElementNS(ns, 'path');
  svg.setAttribute('class', 'svg-icon lucide-x');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('stroke', 'currentColor');
  path.setAttribute('d', 'M3 3L21 21');
  path.setAttribute('data-private', 'extra');
  path.setAttribute('fill', 'url(#other)');
  svg.appendChild(path);
  svg.appendChild(doc.createElementNS(ns, 'foreignObject'));
  const icon = JSON.parse(JSON.stringify(captureIcon(svg)));
  const expected = {
    tag: 'svg',
    attrs: [
      ['class', 'svg-icon lucide-x'],
      ['viewBox', '0 0 24 24'],
      ['stroke', 'currentColor'],
    ],
    children: [{ tag: 'path', attrs: [['d', 'M3 3L21 21']], children: [] }],
  };
  assert.deepEqual(icon, expected);
  icon.attrs.push(['style', 'display: none']);
  icon.children.push({ tag: 'image', attrs: [], children: [] });
  assert.deepEqual(captureIcon(drawIcon(doc, icon)), expected);
  assert.equal(drawIcon(doc, '<svg/>'), null);
});
