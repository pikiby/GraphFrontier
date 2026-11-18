// HTML export: one file that runs the plugin itself on a snapshot of the vault, so the page
// shows the graph exactly as the GraphFrontier view shows it in Obsidian. The snapshot is what
// the plugin reads from Obsidian: the vault's files, their metadata and links, note texts, the
// plugin's data and layouts with the current positions, the theme and the icons.
import { setIcon } from 'obsidian';
import viewerSource from './viewer-source.js';
import { buildPageHtml } from './export-html.js';
import { captureIcon } from './export-icon.js';

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
    result[source] = Object.fromEntries(Object.entries(targets).filter(([id]) => keep(id)));
  }
  return result;
}

// The page's icons: each candidate name that Obsidian draws as an icon, as SVG geometry.
function captureIcons(doc) {
  const icons = {};
  for (const name of viewerSource.iconCandidates) {
    const holder = doc.createElement('div');
    try {
      setIcon(holder, name);
    } catch {
      continue;
    }
    const icon = captureIcon(holder.firstElementChild);
    if (icon?.tag === 'svg') icons[name] = icon;
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
  // These rules have already removed their targets. Do not export private exclusion queries.
  result.blacklist = [];
  result.groups = layout.groups.filter((group) => !group.hidden);
  const orbits = (entries) =>
    Object.fromEntries(
      Object.entries(entries || {}).filter(([id, orbit]) => keep(id) && keep(orbit.anchor_id))
    );
  result.orbit_pins = orbits(layout.orbit_pins);
  result.saved_layout_orbit_pins = orbits(layout.saved_layout_orbit_pins);
  result.dark_energy = layout.dark_energy.filter((item) => keep(item.id));
  result.subgraphs = layout.subgraphs
    .filter((item) => keep(item.id))
    .map((item) => ({
      ...item,
      members: item.members.filter(keep),
      ...(item.origin && {
        origin: { ...item.origin, orbit_pins: orbits(item.origin.orbit_pins) },
      }),
    }));
  result.subgraph_cameras = Object.fromEntries(
    Object.entries(layout.subgraph_cameras).filter(([id]) => keep(id))
  );
  const pruneFilter = (state) => ({
    ...state,
    node_filter: state.node_filter?.filter(keep) ?? null,
  });
  result.subgraph_filters = Object.fromEntries(
    Object.entries(layout.subgraph_filters)
      .filter(([id]) => keep(id))
      .map(([id, state]) => [id, pruneFilter(state)])
  );
  result.view_state = pruneFilter(layout.view_state);
  // Sleep signatures describe the original topology, not the exported one.
  result.saved_layout_sleep = {};
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
  const explicit = Array.isArray(options.nodeIds);
  const wanted = view.exportVisibleIds();
  if (explicit) {
    const requested = new Set(options.nodeIds);
    for (const id of wanted) if (!requested.has(id)) wanted.delete(id);
  }
  // Keep the visible topology even when clipping removes a note's only neighbour,
  // or when an edge represents members of a collapsed container.
  const topology = (source, ids) => ({
    nodes: source.nodes
      .filter((n) => ids.has(n.id))
      .map((n) => ({
        id: n.id,
        label: n.label,
        linked:
          source.plugin.getSettings().hide_orphans ||
          n.degree > 0 ||
          !!source.topologyNeighborsById?.get(n.id)?.size,
        attachment: n.meta?.isAttachment === true,
      })),
    edges: source.edges
      .filter((e) => ids.has(e.source) && ids.has(e.target))
      .map(({ source, target, bidirectional }) => ({ source, target, bidirectional })),
  });
  const layoutGraphs = Object.create(null);
  layoutGraphs[layoutName] = topology(view, wanted);
  const includedIds = new Set(wanted);
  const snapshot = view.captureLayoutSnapshot(layoutName);
  const liveLayout = keepNodes(snapshot, (id) => wanted.has(id));
  const modules = normalizeModules(options.modules);
  const pluginFiles = {};
  for (const name of explicit || !modules.layouts ? [] : await plugin.listLayoutFileNames()) {
    if (name === layoutName) continue;
    const filePath = plugin.getLayoutFileRelativePath(name);
    const raw = JSON.parse(await adapter.read(filePath));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !raw.settings)
      throw new Error('Cannot determine visibility for saved layout: ' + name);
    const layout = plugin.normalizeData(raw);
    layout.active_layout_name = name;
    const preview = view.savedLayoutExportView(layout);
    const ids = preview.exportVisibleIds();
    layoutGraphs[name] = topology(preview, ids);
    pluginFiles[filePath] = JSON.stringify(keepNodes(layout, (id) => ids.has(id)));
    for (const id of ids) includedIds.add(id);
  }
  pluginFiles[plugin.getLayoutFileRelativePath(layoutName)] = JSON.stringify(liveLayout);
  const listsPath = plugin.nodeListStore?.path;
  if (listsPath && (await adapter.exists(listsPath))) {
    const { lists } = JSON.parse(await adapter.read(listsPath));
    pluginFiles[listsPath] = JSON.stringify({
      version: 1,
      lists: lists
        .map(({ id, name, nodeIds }) => ({
          id,
          name,
          nodeIds: nodeIds.filter((nodeId) => includedIds.has(nodeId)),
        }))
        .filter((list) => list.nodeIds.length),
    });
  }
  const files = vault.getFiles().filter((file) => includedIds.has(file.path));
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
  const keep = (id) => includedIds.has(id);
  const resolvedLinks = filterLinks(metadataCache.resolvedLinks, keep);
  const doc = view.contentEl.ownerDocument;
  return {
    exportOptions: modules,
    layoutGraphs,
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
    unresolvedLinks: filterLinks(metadataCache.unresolvedLinks, keep),
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

export { hasExportPage, captureExportSnapshot, buildExportHtml, normalizeModules };
