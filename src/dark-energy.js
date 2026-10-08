const PREFIX = 'graphfrontier:dark-energy:';
const matchCaches = new WeakMap();
const emptyTargets = new Map();

function normalizeDarkEnergy(items, parseQuery) {
  const ids = new Set();
  return (Array.isArray(items) ? items : []).flatMap((item) => {
    if (!item || typeof item.id !== 'string' || !item.id.startsWith(PREFIX) || ids.has(item.id))
      return [];
    const queries = (Array.isArray(item.queries) ? item.queries : []).filter(
      (query) => typeof query === 'string' && parseQuery(query)?.value
    );
    if (!queries.length) return [];
    ids.add(item.id);
    return [
      {
        id: item.id,
        name:
          String(item.name || 'Gravity node')
            .trim()
            .replace(/^Dark energy$/, 'Gravity node') || 'Gravity node',
        queries: [...new Set(queries.map((query) => query.trim()))],
        strength: Number.isFinite(item.strength) ? Math.max(0, Math.min(100, item.strength)) : 10,
        x: Number.isFinite(item.x) ? item.x : 0,
        y: Number.isFinite(item.y) ? item.y : 0,
      },
    ];
  });
}

function darkEnergyNodes(items = []) {
  return items.map((item) => ({
    id: item.id,
    label: item.name,
    meta: { darkEnergy: item, path: '', fileName: item.name, tags: [], properties: new Map() },
  }));
}

// Cache membership, not coordinates: dragging a center never reparses the rules.
function getDarkEnergyTargets(view) {
  const items = view.plugin.data?.dark_energy;
  if (!items?.length) return emptyTargets;
  const cached = matchCaches.get(view);
  if (
    cached?.items === items &&
    cached.nodes === view.nodes &&
    cached.version === view.visibilityGraphVersion
  )
    return cached.targets;
  const targets = new Map();
  for (const item of items) {
    const rules = item.queries.map((query) => view.plugin.parseGroupQuery(query)).filter(Boolean);
    for (const node of view.nodes) {
      if (node.meta?.darkEnergy) continue;
      if (!rules.some((rule) => view.nodeMatchesParsedGroup(node.meta || {}, rule, node))) continue;
      if (!targets.has(node.id)) targets.set(node.id, []);
      targets.get(node.id).push(item);
    }
  }
  matchCaches.set(view, {
    items,
    nodes: view.nodes,
    version: view.visibilityGraphVersion,
    targets,
  });
  return targets;
}

function applyDarkEnergyForce(view, node, accel, targets) {
  for (const item of targets.get(node.id) || []) {
    const center = view.nodeById.get(item.id);
    if (!center) continue;
    const dx = center.x - node.x;
    const dy = center.y - node.y;
    const distance = Math.hypot(dx, dy);
    if (!distance) continue;
    const force = Math.min(1.6, distance * item.strength * 0.00015) / 2;
    accel.ax += (dx / distance) * force;
    accel.ay += (dy / distance) * force;
  }
}

module.exports = {
  PREFIX,
  normalizeDarkEnergy,
  darkEnergyNodes,
  getDarkEnergyTargets,
  applyDarkEnergyForce,
};
