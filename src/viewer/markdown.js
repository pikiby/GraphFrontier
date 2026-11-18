// Markdown for notes opened on the exported page: headings, paragraphs, lists, quotes, code and
// rules. Obsidian renders notes itself; a page outside Obsidian uses this renderer instead.

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderInline(text) {
  const chunks = escapeHtml(text).split('`');
  return chunks.map((chunk, index) => (index % 2 ? `<code>${chunk}</code>` : chunk)).join('');
}

// Note properties (the leading YAML block) are metadata, not note text.
function renderMarkdown(markdownText) {
  const lines = String(markdownText || '')
    .replace(/\r/g, '')
    .replace(/^---\n[\s\S]*?\n---(\n|$)/, '')
    .split('\n');
  const out = [];
  let inCode = false;
  let list = null;
  let paragraph = [];
  const flushParagraph = () => {
    if (paragraph.length) out.push(`<p>${paragraph.map(renderInline).join('<br>')}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  const openList = (tag) => {
    if (list === tag) return;
    closeList();
    out.push(`<${tag}>`);
    list = tag;
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      flushParagraph();
      closeList();
      const lang = trimmed.slice(3).trim();
      out.push(
        inCode
          ? '</code></pre>'
          : `<pre><code${lang ? ` class="language-${escapeHtml(lang)}"` : ''}>`
      );
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(`${escapeHtml(line)}\n`);
      continue;
    }
    if (!trimmed) {
      flushParagraph();
      closeList();
      continue;
    }
    const heading = /^(#{1,6}) (.*)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      closeList();
      out.push(`<h${heading[1].length}>${renderInline(heading[2])}</h${heading[1].length}>`);
      continue;
    }
    if (trimmed.startsWith('>')) {
      flushParagraph();
      closeList();
      out.push(`<blockquote><p>${renderInline(trimmed.replace(/^> ?/, ''))}</p></blockquote>`);
      continue;
    }
    const bullet = /^[-*+] (.*)$/.exec(trimmed);
    const ordered = /^\d+\. (.*)$/.exec(trimmed);
    if (bullet || ordered) {
      flushParagraph();
      openList(bullet ? 'ul' : 'ol');
      out.push(`<li>${renderInline((bullet || ordered)[1])}</li>`);
      continue;
    }
    if (/^([-*_])\1{2,}$/.test(trimmed)) {
      flushParagraph();
      closeList();
      out.push('<hr>');
      continue;
    }
    closeList();
    paragraph.push(line);
  }
  flushParagraph();
  closeList();
  if (inCode) out.push('</code></pre>');
  return out.join('');
}

module.exports = { renderMarkdown, escapeHtml };
