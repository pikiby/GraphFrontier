const SUBGRAPH_PREFIX = 'graphfrontier:subgraph:';
const LOCAL_COORDINATES = 'local-v1';

function normalizeSubgraphs(items) {
  const groups = [];
  const ids = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    if (
      !item ||
      typeof item.id !== 'string' ||
      !item.id.startsWith(SUBGRAPH_PREFIX) ||
      ids.has(item.id)
    )
      continue;
    ids.add(item.id);
    groups.push({
      id: item.id,
      name: String(item.name || 'Subgraph').trim() || 'Subgraph',
      members: [
        ...new Set(
          (Array.isArray(item.members) ? item.members : []).filter(
            (id) =>
              typeof id === 'string' &&
              id &&
              !['__proto__', 'constructor', 'prototype'].includes(id)
          )
        ),
      ],
      x: Number.isFinite(item.x) ? item.x : 0,
      y: Number.isFinite(item.y) ? item.y : 0,
    });
  }
  const parents = new Map();
  // Reject the cycle-closing edge, not the group or its note settings.
  for (const group of groups)
    group.members = group.members.filter((id) => {
      if (parents.has(id)) return false;
      for (let ancestor = group.id; ancestor; ancestor = parents.get(ancestor))
        if (ancestor === id) return false;
      parents.set(id, group.id);
      return true;
    });
  return groups;
}

function subgraphNodes(groups = []) {
  return groups.map((group) => ({
    id: group.id,
    label: group.name,
    meta: { subgraph: group, path: '', fileName: group.name, tags: [], properties: new Map() },
  }));
}

function hierarchy(groups = []) {
  return new Map(groups.flatMap((group) => group.members.map((id) => [id, group.id])));
}

function descendants(groups, id) {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const result = new Set();
  const visit = (key) => {
    for (const member of byId.get(key)?.members || []) {
      if (member === id || result.has(member)) continue;
      result.add(member);
      visit(member);
    }
  };
  visit(id);
  return result;
}

function projectNodeId(id, parents, scope = null) {
  if (id === scope) return null;
  let result = id;
  let parent = parents.get(id);
  while (parent && parent !== scope) {
    result = parent;
    parent = parents.get(parent);
  }
  return (parent || null) === scope ? result : null;
}

function projectSubgraphs(graph, groups = [], scope = null) {
  if (scope && !groups.some((group) => group.id === scope)) return { nodes: [], edges: [] };
  const parents = hierarchy(groups);
  const nodes = new Map([...graph.nodes, ...subgraphNodes(groups)].map((node) => [node.id, node]));
  const visible = [...nodes.values()].filter(
    (node) => projectNodeId(node.id, parents, scope) === node.id
  );
  const visibleIds = new Set(visible.map((node) => node.id));
  const pairs = new Set();
  const edges = [];
  for (const edge of graph.edges) {
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) continue;
    const source = projectNodeId(edge.source, parents, scope);
    const target = projectNodeId(edge.target, parents, scope);
    if (
      !source ||
      !target ||
      source === target ||
      !visibleIds.has(source) ||
      !visibleIds.has(target)
    )
      continue;
    const pair = JSON.stringify([source, target].sort());
    if (pairs.has(pair)) continue;
    pairs.add(pair);
    edges.push({ ...edge, source, target });
  }
  return { nodes: visible, edges };
}

// Translate immediate members only. A nested container's own interior is another space.
function translateMembers(data, members, dx, dy) {
  for (const id of members) {
    for (const key of ['saved_positions', 'pins', 'saved_layout_pins']) {
      const point = data[key]?.[id];
      if (point) data[key][id] = { ...point, x: point.x + dx, y: point.y + dy };
    }
    const group = data.subgraphs.find((item) => item.id === id);
    if (group) {
      group.x += dx;
      group.y += dy;
    }
    const gravity = data.dark_energy.find((item) => item.id === id);
    if (gravity) {
      gravity.x = data.saved_positions[id]?.x ?? gravity.x + dx;
      gravity.y = data.saved_positions[id]?.y ?? gravity.y + dy;
    }
  }
}

// Cross-space or deleted orbit anchors cannot constrain an independent simulation.
// Keep the node pinned at its converted position instead of making it unexpectedly free.
function reconcileOrbitSpaces(data, removedId = null) {
  const parents = hierarchy(data.subgraphs);
  for (const [key, pinKey] of [
    ['orbit_pins', 'pins'],
    ['saved_layout_orbit_pins', 'saved_layout_pins'],
  ]) {
    for (const [id, orbit] of Object.entries(data[key] || {})) {
      if (orbit.anchor_id !== removedId && parents.get(id) === parents.get(orbit.anchor_id))
        continue;
      const point = data[pinKey]?.[id] || data.saved_positions[id];
      if (!point) continue;
      data[pinKey][id] = { x: point.x, y: point.y, mode: 'exact' };
      delete data[key][id];
    }
  }
}

function normalizeSubgraphSpaces(data, previousFormat) {
  const parents = hierarchy(data.subgraphs);
  for (const gravity of data.dark_energy)
    if (parents.has(gravity.id) && !data.saved_positions[gravity.id])
      data.saved_positions[gravity.id] = { x: gravity.x, y: gravity.y };
  if (previousFormat !== LOCAL_COORDINATES) {
    // Legacy layouts stored every depth in global coordinates. Snapshot all origins
    // before converting nested containers so the migration is order-independent.
    const origins = new Map(
      data.subgraphs.map((group) => [
        group.id,
        data.pins[group.id] || data.saved_positions[group.id] || { x: group.x, y: group.y },
      ])
    );
    for (const group of data.subgraphs) {
      const origin = origins.get(group.id);
      translateMembers(data, group.members, -origin.x, -origin.y);
    }
    // Old scoped cameras were also global; they must be fitted in the new space.
    data.subgraph_cameras = {};
  }
  data.subgraph_coordinates = LOCAL_COORDINATES;
  reconcileOrbitSpaces(data);
  return data;
}

module.exports = {
  SUBGRAPH_PREFIX,
  LOCAL_COORDINATES,
  normalizeSubgraphs,
  subgraphNodes,
  hierarchy,
  descendants,
  projectNodeId,
  projectSubgraphs,
  translateMembers,
  reconcileOrbitSpaces,
  normalizeSubgraphSpaces,
};
