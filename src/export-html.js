// The exported page's HTML: styles, the snapshot as JSON, and the page script. The plugin writes
// it at export; the page writes it again when it saves its layouts into the file.

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// '<' never appears raw inside the scripts or styles, so no text in them can close their tag.
function buildPageHtml({ title, styles, data, script }) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${String(styles).replace(/<\/(style)/gi, '<\\/$1')}
</style>
</head>
<body>
<div id="graphfrontier-root"></div>
<script id="graphfrontier-data" type="application/json">${json}</script>
<script>${String(script).replace(/<\/(script)/gi, '<\\/$1')}</script>
</body>
</html>
`;
}

export { buildPageHtml };
