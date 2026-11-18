// HTML export: one file that runs the plugin itself on a snapshot of the vault, so the page
// shows the graph exactly as the GraphFrontier view shows it in Obsidian. The snapshot is what
// the plugin reads from Obsidian: the vault's files, their metadata and links, note texts, the
// plugin's data and layouts with the current positions, the theme and the icons.
const { setIcon } = require('obsidian');
const viewerSource = require('./viewer-source');
const { buildPageHtml } = require('./export-html');

function hasExportPage() {
  return typeof viewerSource.viewerScript === 'string' && viewerSource.viewerScript.length > 0;
}

// Only what the plugin reads from a note's metadata: tags, properties and headings.
function noteCache(cache) {
  if (!cache) return null;
  const entry = {};
  if (Array.isArray(cache.tags)) entry.tags = cache.tags.map((tag) => ({ tag: tag.tag }));
  if (cache.frontmatter && typeof cache.frontmatter === 'object')
    entry.frontmatter = cache.frontmatter;
  if (Array.isArray(cache.headings))
    entry.headings = cache.headings.map((heading) => ({
      heading: heading.heading,
      level: heading.level,
    }));
  return entry;
}

function filterLinks(links, keep) {
  const result = {};
  for (const [source, targets] of Object.entries(links || {})) {
    if (!keep(source)) continue;
    result[source] = { ...targets };
  }
  return result;
}

// The page's icons: each candidate name that Obsidian draws as an icon, as SVG markup.
function captureIcons(doc) {
  const icons = {};
  for (const name of viewerSource.iconCandidates) {
    const holder = doc.createElement('div');
    try {
      setIcon(holder, name);
    } catch {
      continue;
    }
    if (holder.firstElementChild?.tagName?.toLowerCase() === 'svg') icons[name] = holder.innerHTML;
  }
  return icons;
}

// Theme values of the variables the page's styles use, as the graph shows them now: read on the
// view itself, so theme and CSS snippets that style the view are included.
function captureThemeVariables(el) {
  const styles = el.ownerDocument.defaultView.getComputedStyle(el);
  const values = {};
  for (const name of viewerSource.cssVariables) {
    const value = styles.getPropertyValue(name).trim();
    if (value) values[name] = value;
  }
  return values;
}

// Layout data kept per node; an export of chosen nodes keeps only theirs.
const PER_NODE_KEYS = [
  'saved_positions',
  'pins',
  'orbit_pins',
  'saved_layout_pins',
  'saved_layout_orbit_pins',
  'node_force_multipliers',
  'strong_pull_nodes',
  'painted_edge_colors',
  'node_label_sizes',
  'node_visual_settings',
];

function keepNodes(layout, keep) {
  const result = { ...layout };
  for (const key of PER_NODE_KEYS) {
    const value = layout[key];
    if (!value || typeof value !== 'object') continue;
    result[key] = Array.isArray(value)
      ? value.filter((id) => keep(id))
      : Object.fromEntries(Object.entries(value).filter(([id]) => keep(id)));
  }
  return result;
}

// What the page includes besides nodes and links; each part needs the one it belongs to.
function normalizeModules(modules = {}) {
  const settings = modules.settings === true;
  return {
    physics: modules.physics === true,
    settings,
    layouts: settings && modules.layouts === true,
    saves: settings && modules.saves === true,
  };
}

async function captureExportSnapshot(view, options = {}) {
  const { app, plugin } = view;
  const { vault, metadataCache } = app;
  const adapter = vault.adapter;
  const layoutName = plugin.getActiveLayoutFileName();
  const wanted = Array.isArray(options.nodeIds) ? new Set(options.nodeIds) : null;
  // The active layout as it is on screen now, with live positions and camera. An export of
  // chosen nodes keeps their data and that of gravity nodes and subgraphs, and no other layout.
  const snapshot = view.captureLayoutSnapshot(layoutName);
  const synthetic = new Set(
    [...(snapshot.dark_energy || []), ...(snapshot.subgraphs || [])].map((item) => item.id)
  );
  const liveLayout = wanted
    ? keepNodes(snapshot, (id) => wanted.has(id) || synthetic.has(id))
    : snapshot;
  const modules = normalizeModules(options.modules);
  const pluginFiles = {};
  for (const name of wanted || !modules.layouts ? [] : await plugin.listLayoutFileNames()) {
    const filePath = plugin.getLayoutFileRelativePath(name);
    try {
      pluginFiles[filePath] = await adapter.read(filePath);
    } catch {
      // An unreadable layout is simply not offered on the page.
    }
  }
  pluginFiles[plugin.getLayoutFileRelativePath(layoutName)] = JSON.stringify(liveLayout);
  const listsPath = plugin.nodeListStore?.path;
  if (listsPath && (await adapter.exists(listsPath)))
    pluginFiles[listsPath] = await adapter.read(listsPath);

  const files = vault.getFiles().filter((file) => !wanted || wanted.has(file.path));
  const included = new Set(files.map((file) => file.path));
  const caches = {};
  const texts = {};
  for (const file of files) {
    if (String(file.extension).toLowerCase() !== 'md') continue;
    const cache = noteCache(metadataCache.getFileCache(file));
    if (cache) caches[file.path] = cache;
    if (options.includeContents !== false) {
      try {
        texts[file.path] = await vault.cachedRead(file);
      } catch {
        // An unreadable note opens empty on the page.
      }
    }
  }
  const resolvedLinks = filterLinks(metadataCache.resolvedLinks, (path) => included.has(path));
  if (wanted)
    for (const targets of Object.values(resolvedLinks))
      for (const target of Object.keys(targets)) if (!included.has(target)) delete targets[target];
  const doc = view.contentEl.ownerDocument;
  return {
    exportOptions: modules,
    manifest: {
      id: plugin.manifest.id,
      version: plugin.manifest.version,
      name: plugin.manifest.name,
    },
    vaultName: vault.getName(),
    configDir: vault.configDir,
    pluginData: liveLayout,
    pluginFiles,
    files: files.map((file) => ({
      path: file.path,
      ctime: file.stat?.ctime || 0,
      mtime: file.stat?.mtime || 0,
      size: file.stat?.size || 0,
    })),
    caches,
    texts,
    resolvedLinks,
    unresolvedLinks: wanted
      ? {}
      : filterLinks(metadataCache.unresolvedLinks, (path) => included.has(path)),
    icons: captureIcons(doc),
    bodyClasses: ['theme-dark', 'theme-light'].filter((name) => doc.body.classList.contains(name)),
    themeVariables: captureThemeVariables(view.contentEl),
  };
}

function buildExportHtml(snapshot, title) {
  const { themeVariables, ...data } = snapshot;
  const variables = Object.entries(themeVariables || {})
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n');
  return buildPageHtml({
    title,
    styles: `:root {\n${variables}\n}\n${viewerSource.viewerStyles}`,
    data,
    script: viewerSource.viewerScript,
  });
}

module.exports = { hasExportPage, captureExportSnapshot, buildExportHtml, normalizeModules };
