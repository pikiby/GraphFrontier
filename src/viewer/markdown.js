// The standalone page supports a small Markdown subset. Note contents are always text nodes.
function renderMarkdown(markdownText, target) {
  const doc = target.ownerDocument;
  const root = doc.createDocumentFragment();
  function add(parent, tag) {
    const el = doc.createElement(tag);
    parent.appendChild(el);
    return el;
  }
  function inline(parent, text) {
    text.split('`').forEach((chunk, i) => {
      const destination = i % 2 ? add(parent, 'code') : parent;
      destination.appendChild(doc.createTextNode(chunk));
    });
  }

  let code = null;
  let list = null;
  let paragraph = null;
  const lines = String(markdownText || '')
    .replace(/\r/g, '')
    .replace(/^---\n[\s\S]*?\n---(\n|$)/, '')
    .split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      paragraph = list = null;
      if (code) code = null;
      else {
        code = add(add(root, 'pre'), 'code');
        const lang = trimmed.slice(3).trim();
        if (lang) code.className = 'language-' + lang;
      }
      continue;
    }
    if (code) {
      code.appendChild(doc.createTextNode(line + '\n'));
      continue;
    }
    const item = /^([-*+] |\d+\. )(.*)$/.exec(trimmed);
    if (item) {
      paragraph = null;
      const type = /^\d/.test(item[1]) ? 'ol' : 'ul';
      if (list?.localName !== type) list = add(root, type);
      inline(add(list, 'li'), item[2]);
      continue;
    }
    list = null;
    const heading = /^(#{1,6}) (.*)$/.exec(trimmed);
    if (heading) inline(add(root, 'h' + heading[1].length), heading[2]);
    else if (trimmed.startsWith('>'))
      inline(add(add(root, 'blockquote'), 'p'), trimmed.replace(/^> ?/, ''));
    else if (/^([-*_])\1{2,}$/.test(trimmed)) add(root, 'hr');
    else if (trimmed) {
      if (paragraph) add(paragraph, 'br');
      else paragraph = add(root, 'p');
      inline(paragraph, line);
      continue;
    }
    paragraph = null;
  }
  target.replaceChildren(root);
}

export { renderMarkdown };
