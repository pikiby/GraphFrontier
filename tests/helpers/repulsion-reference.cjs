const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');

// Pre-optimization string-cell traversal, independent of the numeric index.
function indexNodes(nodes, radius) {
  const buckets = new Map();
  const list = [];
  for (const node of nodes) {
    const gx = Math.floor(node.x / radius);
    const gy = Math.floor(node.y / radius);
    const key = `${gx}:${gy}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { gx, gy, index: list.length, nodes: [] };
      buckets.set(key, bucket);
      list.push(bucket);
    }
    bucket.nodes.push(node);
  }
  return { buckets, list, radius };
}

function pairs(index, callback) {
  for (const a of index.list) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const b = index.buckets.get(`${a.gx + dx}:${a.gy + dy}`);
        if (!b || b.index < a.index) continue;
        if (a === b) {
          for (let i = 0; i < a.nodes.length; i++)
            for (let j = i + 1; j < a.nodes.length; j++) callback(a.nodes[i], a.nodes[j]);
        } else {
          for (const first of a.nodes) for (const second of b.nodes) callback(first, second);
        }
      }
    }
  }
}

function applyReferenceRepulsion({
  nodes,
  accelById,
  getNodeDegree,
  fixedNodeIds,
  orbitNodeIds,
  repelRadius,
  repelStrength,
}) {
  const orphans = nodes.filter((node) => getNodeDegree(node) === 0);
  const main = nodes.filter((node) => getNodeDegree(node) !== 0);
  const pair = (a, b, strength, radius, mode) => {
    if (fixedNodeIds.has(a.id) && fixedNodeIds.has(b.id)) return;
    if (mode === 'main' && (getNodeDegree(a) === 0 || getNodeDegree(b) === 0)) return;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const squared = dx * dx + dy * dy;
    if (squared > radius * radius) return;
    const distance = Math.sqrt(squared) || 0.0001;
    const safe = Math.max(28, distance);
    const force = Math.min(16, strength / (safe * safe));
    const fx = (dx / distance) * force;
    const fy = (dy / distance) * force;
    const first = accelById.get(a.id);
    const second = accelById.get(b.id);
    if (mode !== 'main' || !orbitNodeIds.has(a.id)) {
      first.ax -= fx;
      first.ay -= fy;
    }
    if (mode === 'orphan' || !orbitNodeIds.has(b.id)) {
      second.ax += mode === 'cross' ? fx * 0.06 : fx;
      second.ay += mode === 'cross' ? fy * 0.06 : fy;
    }
  };
  pairs(indexNodes(nodes, repelRadius), (a, b) => pair(a, b, repelStrength, repelRadius, 'main'));
  const radius = repelRadius * 1.25;
  if (orphans.length > 1)
    pairs(indexNodes(orphans, radius), (a, b) => pair(a, b, repelStrength * 1.2, radius, 'orphan'));
  const index = indexNodes(main, radius);
  for (const orphan of orphans) {
    const gx = Math.floor(orphan.x / radius);
    const gy = Math.floor(orphan.y / radius);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const target of index.buckets.get(`${gx + dx}:${gy + dy}`)?.nodes || [])
          pair(orphan, target, repelStrength * 5.2, radius, 'cross');
      }
    }
  }
}

function loadReferencePhysics() {
  const filename = path.resolve(__dirname, 'physics-baseline.cjs');
  let source = fs.readFileSync(filename, 'utf8');
  const from = source.indexOf('  if (hasRepel) {', source.indexOf('function stepSimulation(view)'));
  const to = source.indexOf('\n  const multipliers = new Map();', from);
  assert(
    from >= 0 && to > from,
    'repulsion reference boundaries must be reviewed after refactoring'
  );
  source =
    source.slice(0, from) +
    `
  if (hasRepel) applyReferenceRepulsion({nodes, accelById, getNodeDegree, fixedNodeIds, orbitNodeIds, repelRadius, repelStrength});
` +
    source.slice(to);
  const cacheStart = source.indexOf('function cachedNodeMultiplier(');
  const cacheEnd = source.indexOf('\nfunction layoutSleepSignature(', cacheStart);
  assert(cacheStart >= 0 && cacheEnd > cacheStart);
  source =
    source.slice(0, cacheStart) +
    'function cachedNodeMultiplier(plugin, id) { return plugin.getNodeMultiplier(id); }\n' +
    source.slice(cacheEnd);
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(
    `const {applyReferenceRepulsion} = require(${JSON.stringify(__filename)});\n` + source,
    filename
  );
  return loaded.exports;
}

module.exports = { applyReferenceRepulsion, loadReferencePhysics };
