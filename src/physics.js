const { TWO_PI, DEFAULT_DATA } = require('./constants');
const { getDarkEnergyTargets, applyDarkEnergyForce } = require('./dark-energy');

const layoutAutosaveStates = new WeakMap();
const layoutSleepStates = new WeakMap();
const layoutSleepSignatures = new WeakMap();

function normalizeLayoutSleep(value) {
  return Object.fromEntries(
    Object.entries(value && typeof value === 'object' ? value : {})
      .filter(
        ([, state]) =>
          state?.version === 1 && typeof state.signature === 'string' && Array.isArray(state.nodes)
      )
      .map(([scope, state]) => [
        scope,
        {
          version: 1,
          signature: state.signature,
          nodes: [...new Set(state.nodes.filter((id) => typeof id === 'string'))],
        },
      ])
  );
}

// Exact context, not just zero velocity: explicit saves also stop moving nodes.
function cachedNodeMultiplier(plugin, id, values, context) {
  if (!values.has(id)) values.set(id, plugin.getNodeMultiplier(id, context));
  return values.get(id);
}

// The default collator orders exactly like String#localeCompare without arguments, so
// saved signatures stay comparable; sort keys are built once per item.
const signatureCollator = new Intl.Collator();
function sortedByKey(items, key) {
  const keyed = items.map((item) => [key(item), item]);
  keyed.sort((a, b) => signatureCollator.compare(a[0], b[0]));
  return keyed.map((entry) => entry[1]);
}

// Hide-mode groups stay in physics while they are absent from drawing.
function getPhysicsVisibleNodeIds(view) {
  return typeof view.getPhysicsVisibleNodeIds === 'function'
    ? view.getPhysicsVisibleNodeIds()
    : view.getFilterVisibleNodeIds();
}

const physicsVisibilityStates = new WeakMap();

function physicsVisibilitySignature(visible) {
  if (!(visible instanceof Set)) return null;
  return [...visible].sort().join('\n');
}

// Record the current physics subset without waking, e.g. after restoring sleep.
function resetPhysicsVisibilityBaseline(view) {
  const visible = getPhysicsVisibleNodeIds(view);
  physicsVisibilityStates.set(view, {
    visible,
    signature: physicsVisibilitySignature(visible),
  });
}

// A changed physics subset (eye, solo, Hide/Exclude, rules, filters) must re-settle.
function wakeOnPhysicsVisibilityChange(view) {
  const visible = getPhysicsVisibleNodeIds(view);
  const state = physicsVisibilityStates.get(view);
  if (state && state.visible === visible) return false;
  const signature = physicsVisibilitySignature(visible);
  physicsVisibilityStates.set(view, { visible, signature });
  if (!state || state.signature === signature) return false;
  if (typeof view.kickLayoutSearch === 'function') view.kickLayoutSearch();
  else kickLayoutSearch(view);
  return true;
}

function layoutSleepSignature(view, multipliers = new Map(), multiplierContext = {}) {
  const settings = view.plugin.getSettings();
  const visible = getPhysicsVisibleNodeIds(view);
  const targets = getDarkEnergyTargets(view);
  return JSON.stringify([
    [
      'repel_strength',
      'repel_radius',
      'center_strength',
      'base_link_strength',
      'link_distance',
      'damping',
    ].map((key) => settings[key]),
    sortedByKey(
      view.nodes.map((node) => [
        node.id,
        node.x,
        node.y,
        view.plugin.getPin(node.id),
        view.plugin.getOrbitPin(node.id),
        cachedNodeMultiplier(view.plugin, node.id, multipliers, multiplierContext),
      ]),
      (entry) => entry[0]
    ),
    sortedByKey(
      view.edges.map((edge) => [edge.source, edge.target].sort()),
      (pair) => JSON.stringify(pair)
    ),
    visible instanceof Set ? [...visible].sort() : null,
    view.plugin.data?.dark_energy || [],
    sortedByKey(
      [...targets].map(([id, entries]) => [
        id,
        entries.map(({ item, matches }) => [item.id, matches]),
      ]),
      (entry) => entry[0]
    ),
  ]);
}

function captureLayoutSleep(view) {
  if (!view.layoutPaused) return null;
  const signature = layoutSleepSignature(view);
  if (signature !== layoutSleepSignatures.get(view)) return null;
  const states = layoutSleepStates.get(view);
  const nodes = view.nodes
    .filter(
      (node) =>
        states?.get(node) >= 8 &&
        node.vx === 0 &&
        node.vy === 0 &&
        node.id !== view.dragNodeId &&
        !view.dragSelectionOffsets?.has(node.id)
    )
    .map((node) => node.id)
    .sort();
  return nodes.length ? { version: 1, signature, nodes } : null;
}

function restoreLayoutSleep(view, state) {
  if (state?.version !== 1 || state.signature !== layoutSleepSignature(view)) return false;
  const states = new WeakMap();
  for (const id of state.nodes) {
    const node = view.nodeById.get(id);
    if (node && node.vx === 0 && node.vy === 0) states.set(node, 8);
  }
  layoutSleepStates.set(view, states);
  layoutSleepSignatures.set(view, state.signature);
  return true;
}

function copyLayoutSleepState(view, oldNode, node) {
  const states = layoutSleepStates.get(view);
  const frames = oldNode && states?.get(oldNode);
  if (frames !== undefined) states.set(node, frames);
}

// Pausing physics must not pause persistence or discard pending layout changes.
function stepLayoutAutosave(view, moving = false) {
  if (view.layoutAutosaveBatch) {
    view.layoutAutosaveBatch.moving ||= moving;
    return;
  }
  if (
    !view.layoutAutosaveDirty ||
    !view.plugin.getSettings().layout_autosave ||
    view.isSearchFilled() ||
    view.dragNodeId ||
    (view.dragSelectionOffsets instanceof Map && view.dragSelectionOffsets.size > 0)
  ) {
    view.layoutStillFrames = 0;
    return;
  }

  view.layoutStillFrames = moving ? 0 : Math.min(8, view.layoutStillFrames + 1);
  if (view.layoutStillFrames < 8) return;

  let state = layoutAutosaveStates.get(view);
  if (!state) {
    state = { inFlight: false, retryAtMs: 0 };
    layoutAutosaveStates.set(view, state);
  }
  if (state.inFlight || Date.now() < state.retryAtMs) return;

  state.inFlight = true;
  void (async () => {
    try {
      // The save owner acknowledges dirty only after successfully persisting unchanged state.
      await view.saveCurrentLayout({ silent: true });
    } catch {
      // Keep failed saves retryable without an unhandled rejection in the animation loop.
    } finally {
      state.inFlight = false;
      state.retryAtMs = Date.now() + 1000;
    }
  })();
}

// Simulation restart marker used after manual layout-changing actions.
function kickLayoutSearch(view) {
  layoutSleepStates.delete(view);
  layoutSleepSignatures.delete(view);
  view.pendingLayoutSleepRestore = null;
  view.layoutKickAtMs = Date.now();
  view.layoutStillFrames = 0;
  view.layoutAutosaveDirty = true;
  view.layoutPaused = false;
}

// Per-node flags of one simulation step.
const FIXED = 1;
const ORBIT = 2;
const ORPHAN = 4;
const PINNED = 8;
const DRAGGED = 16;
const SLEEPER = 32;
const STATIC = 64;
// Pass roles: seeds start pair visits, receivers accumulate acceleration.
const SEED = 1;
const RECV = 2;

const MIN_REPEL_DISTANCE = 28;
const MAX_REPEL_FORCE = 16;
const MAX_SPRING_FORCE = 20;
const DEGREE_MASS_FACTOR = 0.25;
const ORPHAN_REPEL_SCALE = 1.2;
const ORPHAN_TO_MAIN_REPEL_SCALE = 5.2;
const REGULAR_BACK_REACTION_SCALE = 0.06;

const physicsCaches = new WeakMap();
let sleepForceProbe = null;

// Test hook: receives cached and freshly summed pair/link accelerations of sleeping nodes.
function setSleepForceProbe(probe) {
  sleepForceProbe = typeof probe === 'function' ? probe : null;
}

// Cells keep first-appearance order over `creators` and members keep node order, so pair
// visits match the original traversal; non-members only shape the cell order.
function buildGrid(xs, ys, creators, member, cellSize) {
  const safeCellSize = Math.max(1, Number(cellSize) || 1);
  const columns = new Map();
  const cellX = [];
  const cellY = [];
  const counts = [];
  const bucketOf = new Int32Array(xs.length);
  for (const index of creators) {
    const gx = Math.floor(xs[index] / safeCellSize);
    const gy = Math.floor(ys[index] / safeCellSize);
    let column = columns.get(gx);
    if (!column) columns.set(gx, (column = new Map()));
    let bucket = column.get(gy);
    if (bucket === undefined) {
      bucket = cellX.length;
      column.set(gy, bucket);
      cellX.push(gx);
      cellY.push(gy);
      counts.push(0);
    }
    bucketOf[index] = bucket;
    if (!member || member(index)) counts[bucket] += 1;
  }
  const bucketCount = cellX.length;
  const start = new Int32Array(bucketCount + 1);
  for (let bucket = 0; bucket < bucketCount; bucket++)
    start[bucket + 1] = start[bucket] + counts[bucket];
  const fill = start.slice(0, bucketCount);
  const list = new Int32Array(start[bucketCount]);
  for (const index of creators) {
    if (!member || member(index)) list[fill[bucketOf[index]]++] = index;
  }
  const neighStart = new Int32Array(bucketCount + 1);
  const neighbors = [];
  for (let bucket = 0; bucket < bucketCount; bucket++) {
    for (let offsetX = -1; offsetX <= 1; offsetX++) {
      const column = columns.get(cellX[bucket] + offsetX);
      if (!column) continue;
      for (let offsetY = -1; offsetY <= 1; offsetY++) {
        const other = column.get(cellY[bucket] + offsetY);
        if (other !== undefined && other >= bucket) neighbors.push(other);
      }
    }
    neighStart[bucket + 1] = neighbors.length;
  }
  return {
    columns,
    cellSize: safeCellSize,
    bucketCount,
    all: { start, list, count: list.length },
    neighStart,
    neighList: Int32Array.from(neighbors),
  };
}

// Ordered sub-list of a chain whose members have `bit` set (or clear) in `marks`.
function filterChain(source, bucketCount, marks, bit, set) {
  const start = new Int32Array(bucketCount + 1);
  const list = new Int32Array(source.count);
  let count = 0;
  for (let bucket = 0; bucket < bucketCount; bucket++) {
    start[bucket] = count;
    for (let p = source.start[bucket]; p < source.start[bucket + 1]; p++) {
      const index = source.list[p];
      if (((marks[index] & bit) !== 0) === set) list[count++] = index;
    }
  }
  start[bucketCount] = count;
  return { start, list, count };
}

// Chains for one grid and role: every member, non-fixed members, seeds, non-fixed seeds.
function gridChains(grid, flags, role) {
  const nonFixed = filterChain(grid.all, grid.bucketCount, flags, FIXED, false);
  const seed = filterChain(grid.all, grid.bucketCount, role, SEED, true);
  return {
    all: grid.all,
    nonFixed,
    seed,
    seedNonFixed: filterChain(seed, grid.bucketCount, flags, FIXED, false),
  };
}

// Pairs inside one grid. A pair is visited when it has a seed and is not fixed-fixed, in
// the same order as a full traversal, so every seed accumulates exactly the full sum.
function repelPairs(grid, chains, flags, role, xs, ys, ax, ay, radiusSq, strength) {
  const { all, nonFixed, seed, seedNonFixed } = chains;
  for (let bucket = 0; bucket < grid.bucketCount; bucket++) {
    const seeded = seed.start[bucket + 1] > seed.start[bucket];
    for (let k = grid.neighStart[bucket]; k < grid.neighStart[bucket + 1]; k++) {
      const other = grid.neighList[k];
      if (!seeded && seed.start[other + 1] === seed.start[other]) continue;
      const same = other === bucket;
      let nonFixedFrom = nonFixed.start[other];
      let seedFrom = seed.start[other];
      let seedNonFixedFrom = seedNonFixed.start[other];
      for (let p = all.start[bucket]; p < all.start[bucket + 1]; p++) {
        const a = all.list[p];
        const roleA = role[a];
        let list;
        let q;
        let end;
        if (roleA & SEED) {
          if (flags[a] & FIXED) {
            list = nonFixed.list;
            end = nonFixed.start[other + 1];
            if (same) while (nonFixedFrom < end && list[nonFixedFrom] <= a) nonFixedFrom++;
            q = same ? nonFixedFrom : nonFixed.start[other];
          } else {
            list = all.list;
            end = all.start[other + 1];
            q = same ? p + 1 : all.start[other];
          }
        } else if (flags[a] & FIXED) {
          list = seedNonFixed.list;
          end = seedNonFixed.start[other + 1];
          if (same)
            while (seedNonFixedFrom < end && list[seedNonFixedFrom] <= a) seedNonFixedFrom++;
          q = same ? seedNonFixedFrom : seedNonFixed.start[other];
        } else {
          list = seed.list;
          end = seed.start[other + 1];
          if (same) while (seedFrom < end && list[seedFrom] <= a) seedFrom++;
          q = same ? seedFrom : seed.start[other];
        }
        const xa = xs[a];
        const ya = ys[a];
        const receivesA = roleA & RECV;
        for (; q < end; q++) {
          const b = list[q];
          const dx = xs[b] - xa;
          const dy = ys[b] - ya;
          const distSq = dx * dx + dy * dy;
          if (distSq > radiusSq) continue;
          const dist = Math.sqrt(distSq) || 0.0001;
          const safeDist = Math.max(MIN_REPEL_DISTANCE, dist);
          const force = Math.min(MAX_REPEL_FORCE, strength / (safeDist * safeDist));
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          if (receivesA) {
            ax[a] -= fx;
            ay[a] -= fy;
          }
          if (role[b] & RECV) {
            ax[b] += fx;
            ay[b] += fy;
          }
        }
      }
    }
  }
}

// Orphan-to-linked repulsion, orphan by orphan; linked nodes feel a weak back reaction.
function repelOrphansFromMain(
  orphans,
  grid,
  chains,
  flags,
  role,
  xs,
  ys,
  ax,
  ay,
  radiusSq,
  strength
) {
  const anySeed = chains.seed.count > 0;
  for (const orphan of orphans) {
    const roleO = role[orphan];
    if (!(roleO & SEED) && !anySeed) continue;
    const fixedO = flags[orphan] & FIXED;
    let chain;
    if (roleO & SEED) chain = fixedO ? chains.nonFixed : chains.all;
    else chain = fixedO ? chains.seedNonFixed : chains.seed;
    const xo = xs[orphan];
    const yo = ys[orphan];
    const gx = Math.floor(xo / grid.cellSize);
    const gy = Math.floor(yo / grid.cellSize);
    const receivesO = roleO & RECV;
    for (let offsetX = -1; offsetX <= 1; offsetX++) {
      const column = grid.columns.get(gx + offsetX);
      if (!column) continue;
      for (let offsetY = -1; offsetY <= 1; offsetY++) {
        const bucket = column.get(gy + offsetY);
        if (bucket === undefined) continue;
        for (let q = chain.start[bucket]; q < chain.start[bucket + 1]; q++) {
          const main = chain.list[q];
          const dx = xs[main] - xo;
          const dy = ys[main] - yo;
          const distSq = dx * dx + dy * dy;
          if (distSq > radiusSq) continue;
          const dist = Math.sqrt(distSq) || 0.0001;
          const safeDist = Math.max(MIN_REPEL_DISTANCE, dist);
          const force = Math.min(MAX_REPEL_FORCE, strength / (safeDist * safeDist));
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          if (receivesO) {
            ax[orphan] -= fx;
            ay[orphan] -= fy;
          }
          if (role[main] & RECV) {
            ax[main] += fx * REGULAR_BACK_REACTION_SCALE;
            ay[main] += fy * REGULAR_BACK_REACTION_SCALE;
          }
        }
      }
    }
  }
}

function linkPairs(step, role, ax, ay) {
  const { structure, flags, xs, ys, multipliers, baseLinkStrength, linkDistance } = step;
  const { edgeSource, edgeTarget } = structure;
  for (let e = 0; e < structure.edgeCount; e++) {
    const s = edgeSource[e];
    const t = edgeTarget[e];
    const sourceIsFixed = flags[s] & FIXED;
    const targetIsFixed = flags[t] & FIXED;
    if (sourceIsFixed && targetIsFixed) continue;
    if (!((role[s] | role[t]) & SEED)) continue;
    const dx = xs[t] - xs[s];
    const dy = ys[t] - ys[s];
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const edgeMultiplier = Math.max(multipliers[s], multipliers[t]);
    const stretch = dist - linkDistance;
    const springForceRaw = baseLinkStrength * edgeMultiplier * stretch;
    const springForce = Math.max(-MAX_SPRING_FORCE, Math.min(MAX_SPRING_FORCE, springForceRaw));
    const fx = (dx / dist) * springForce;
    const fy = (dy / dist) * springForce;
    if (!sourceIsFixed && role[s] & RECV) {
      ax[s] += fx;
      ay[s] += fy;
    }
    if (!targetIsFixed && role[t] & RECV) {
      ax[t] -= fx;
      ay[t] -= fy;
    }
  }
}

// Pair and link accelerations of every receiver with respect to the given role.
function accumulateForces(step, role, ax, ay) {
  if (step.hasRepel) {
    const { flags, xs, ys, grids, repelStrength } = step;
    repelPairs(
      grids.main,
      gridChains(grids.main, flags, role),
      flags,
      role,
      xs,
      ys,
      ax,
      ay,
      step.repelRadiusSq,
      repelStrength
    );
    const orphanRepelStrength = repelStrength * ORPHAN_REPEL_SCALE;
    if (orphanRepelStrength > 0 && step.structure.orphans.length > 1) {
      repelPairs(
        grids.orphan,
        gridChains(grids.orphan, flags, role),
        flags,
        role,
        xs,
        ys,
        ax,
        ay,
        step.orphanRepelRadiusSq,
        orphanRepelStrength
      );
    }
    const orphanToMainRepelStrength = repelStrength * ORPHAN_TO_MAIN_REPEL_SCALE;
    if (
      orphanToMainRepelStrength > 0 &&
      step.structure.orphans.length > 0 &&
      step.structure.mains.length > 0
    ) {
      repelOrphansFromMain(
        step.structure.orphans,
        grids.cross,
        gridChains(grids.cross, flags, role),
        flags,
        role,
        xs,
        ys,
        ax,
        ay,
        step.orphanToMainRepelRadiusSq,
        orphanToMainRepelStrength
      );
    }
  }
  if (step.hasLink) linkPairs(step, role, ax, ay);
}

// Repulsion vector pushing `to` away from `from`, or null outside the radius.
function repelVector(xs, ys, from, to, radiusSq, strength) {
  const dx = xs[to] - xs[from];
  const dy = ys[to] - ys[from];
  const distSq = dx * dx + dy * dy;
  if (distSq > radiusSq) return null;
  const dist = Math.sqrt(distSq) || 0.0001;
  const safeDist = Math.max(MIN_REPEL_DISTANCE, dist);
  const force = Math.min(MAX_REPEL_FORCE, strength / (safeDist * safeDist));
  return [(dx / dist) * force, (dy / dist) * force];
}

// Adds (sign = 1) or removes (sign = -1) the forces between `u` and the other cached
// sources. Sleeping nodes keep Σ of forces from every other cached source; pinned nodes
// only exert forces, so nothing is enumerated for them until a sleeper exists.
function updateStaticSource(step, u, sign) {
  const { statics, flags, xs, ys } = step;
  const { inStat, staticAx, staticAy } = statics;
  const uSleeps = sign > 0 ? (flags[u] & SLEEPER) !== 0 : inStat[u] === 2;
  if (sign < 0) {
    inStat[u] = 0;
    staticAx[u] = 0;
    staticAy[u] = 0;
    if (uSleeps) statics.sleepers -= 1;
  }
  const uReceives = sign > 0 && uSleeps;
  if (statics.sleepers > 0 || uReceives) {
    const add = (partner, vx, vy, partnerScale, selfScale) => {
      if (inStat[partner] === 2) {
        staticAx[partner] += sign * vx * partnerScale;
        staticAy[partner] += sign * vy * partnerScale;
      }
      if (uReceives) {
        staticAx[u] -= vx * selfScale;
        staticAy[u] -= vy * selfScale;
      }
    };
    const visit = (grid, radiusSq, strength, partnerScale, selfScale) => {
      if (!grid) return;
      const gx = Math.floor(xs[u] / grid.cellSize);
      const gy = Math.floor(ys[u] / grid.cellSize);
      for (let offsetX = -1; offsetX <= 1; offsetX++) {
        const column = grid.columns.get(gx + offsetX);
        if (!column) continue;
        for (let offsetY = -1; offsetY <= 1; offsetY++) {
          const bucket = column.get(gy + offsetY);
          if (bucket === undefined) continue;
          for (let q = grid.all.start[bucket]; q < grid.all.start[bucket + 1]; q++) {
            const p = grid.all.list[q];
            if (p === u || !inStat[p]) continue;
            if (inStat[p] !== 2 && !uReceives) continue;
            const vector = repelVector(xs, ys, u, p, radiusSq, strength);
            if (vector) add(p, vector[0], vector[1], partnerScale, selfScale);
          }
        }
      }
    };
    if (step.hasRepel) {
      const { grids, repelStrength } = step;
      const cross = repelStrength * ORPHAN_TO_MAIN_REPEL_SCALE;
      if (flags[u] & ORPHAN) {
        visit(grids.orphan, step.orphanRepelRadiusSq, repelStrength * ORPHAN_REPEL_SCALE, 1, 1);
        visit(grids.cross, step.orphanToMainRepelRadiusSq, cross, REGULAR_BACK_REACTION_SCALE, 1);
      } else {
        visit(grids.cross, step.repelRadiusSq, repelStrength, 1, 1);
        visit(grids.orphan, step.orphanToMainRepelRadiusSq, cross, 1, REGULAR_BACK_REACTION_SCALE);
      }
    }
    if (step.hasLink) {
      const { structure, multipliers, baseLinkStrength, linkDistance } = step;
      const { edgeSource, edgeTarget, incidentStart, incidentEdges } = structure;
      for (let k = incidentStart[u]; k < incidentStart[u + 1]; k++) {
        const e = incidentEdges[k];
        const s = edgeSource[e];
        const t = edgeTarget[e];
        const partner = s === u ? t : s;
        if (partner === u || !inStat[partner]) continue;
        if (flags[s] & FIXED && flags[t] & FIXED) continue;
        const dx = xs[t] - xs[s];
        const dy = ys[t] - ys[s];
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const stretch = dist - linkDistance;
        const springForceRaw =
          baseLinkStrength * Math.max(multipliers[s], multipliers[t]) * stretch;
        const springForce = Math.max(-MAX_SPRING_FORCE, Math.min(MAX_SPRING_FORCE, springForceRaw));
        const fx = (dx / dist) * springForce;
        const fy = (dy / dist) * springForce;
        // Raw forces: source gains +f, target -f; mass applies to the final sum.
        for (const [node, sx, sy] of [
          [s, fx, fy],
          [t, -fx, -fy],
        ]) {
          if (node === partner && inStat[partner] === 2) {
            staticAx[partner] += sign * sx;
            staticAy[partner] += sign * sy;
          } else if (node === u && uReceives) {
            staticAx[u] += sx;
            staticAy[u] += sy;
          }
        }
      }
    }
  }
  if (sign > 0) {
    inStat[u] = uSleeps ? 2 : 1;
    statics.x[u] = xs[u];
    statics.y[u] = ys[u];
    if (uSleeps) statics.sleepers += 1;
  }
}

// Graph-shaped arrays of the simulated subset, rebuilt only when graph, visibility or
// degrees change.
function ensureStructure(view, cache, filter, excludeDarkEnergy) {
  const previous = cache.structure;
  if (
    previous &&
    previous.viewNodes === view.nodes &&
    previous.viewEdges === view.edges &&
    previous.viewEdgeCount === view.edges.length &&
    previous.nodeById === view.nodeById &&
    previous.filter === filter &&
    previous.excludeDarkEnergy === excludeDarkEnergy
  ) {
    let index = 0;
    let same = true;
    for (const node of view.nodes) {
      if (filter && !filter.has(node.id)) continue;
      if (excludeDarkEnergy && node.meta?.darkEnergy) continue;
      if (
        previous.nodes[index] !== node ||
        (!filter && previous.degree[index] !== Number(node.degree || 0))
      ) {
        same = false;
        break;
      }
      index += 1;
    }
    if (same && index === previous.count) return previous;
  }

  const nodes = [];
  for (const node of view.nodes) {
    if (filter && !filter.has(node.id)) continue;
    if (excludeDarkEnergy && node.meta?.darkEnergy) continue;
    nodes.push(node);
  }
  const count = nodes.length;
  const indexById = new Map(nodes.map((node, index) => [node.id, index]));
  const degree = new Float64Array(count);
  if (filter) {
    for (const edge of view.edges) {
      const source = indexById.get(edge.source);
      const target = indexById.get(edge.target);
      if (source === undefined || target === undefined) continue;
      degree[source] += 1;
      degree[target] += 1;
    }
  } else {
    for (let index = 0; index < count; index++) degree[index] = Number(nodes[index].degree || 0);
  }
  const sources = [];
  const targets = [];
  for (const edge of view.edges) {
    if (filter && (!filter.has(edge.source) || !filter.has(edge.target))) continue;
    const sourceNode = view.nodeById.get(edge.source);
    const targetNode = view.nodeById.get(edge.target);
    if (!sourceNode || !targetNode) continue;
    const source = indexById.get(sourceNode.id);
    const target = indexById.get(targetNode.id);
    if (source === undefined || target === undefined) continue;
    sources.push(source);
    targets.push(target);
  }
  const edgeCount = sources.length;
  const incidentStart = new Int32Array(count + 1);
  for (let e = 0; e < edgeCount; e++) {
    incidentStart[sources[e] + 1] += 1;
    incidentStart[targets[e] + 1] += 1;
  }
  for (let index = 0; index < count; index++) incidentStart[index + 1] += incidentStart[index];
  const incidentFill = incidentStart.slice(0, count);
  const incidentEdges = new Int32Array(edgeCount * 2);
  for (let e = 0; e < edgeCount; e++) {
    incidentEdges[incidentFill[sources[e]]++] = e;
    incidentEdges[incidentFill[targets[e]]++] = e;
  }
  const mass = new Float64Array(count);
  const orphans = [];
  const mains = [];
  for (let index = 0; index < count; index++) {
    mass[index] = 1 + Math.max(0, degree[index] - 1) * DEGREE_MASS_FACTOR;
    if (degree[index] === 0) orphans.push(index);
    else mains.push(index);
  }
  const structure = {
    viewNodes: view.nodes,
    viewEdges: view.edges,
    viewEdgeCount: view.edges.length,
    nodeById: view.nodeById,
    filter,
    excludeDarkEnergy,
    nodes,
    count,
    indexById,
    degree,
    mass,
    orphans,
    mains,
    allIndices: Int32Array.from(nodes, (_, index) => index),
    edgeCount,
    edgeSource: Int32Array.from(sources),
    edgeTarget: Int32Array.from(targets),
    incidentStart,
    incidentEdges,
  };
  cache.structure = structure;
  return structure;
}

// Same arithmetic as updateLayoutCenter for the simulated subset and its degrees.
function updateLayoutCenterFromDegrees(view, nodes, degree) {
  let sumMainX = 0;
  let sumMainY = 0;
  let mainCount = 0;
  for (let index = 0; index < nodes.length; index++) {
    if (degree[index] === 0) continue;
    sumMainX += nodes[index].x;
    sumMainY += nodes[index].y;
    mainCount += 1;
  }
  if (mainCount > 0) {
    view.layoutCenter.x = sumMainX / mainCount;
    view.layoutCenter.y = sumMainY / mainCount;
    return;
  }
  let sumAllX = 0;
  let sumAllY = 0;
  for (const node of nodes) {
    sumAllX += node.x;
    sumAllY += node.y;
  }
  view.layoutCenter.x = sumAllX / nodes.length;
  view.layoutCenter.y = sumAllY / nodes.length;
}

// Compute current layout center from core nodes, falling back to all nodes when needed.
function updateLayoutCenter(view, nodesForCenter = view.nodes, degreeById = null) {
  const sourceNodes = Array.isArray(nodesForCenter) ? nodesForCenter : view.nodes;
  if (sourceNodes.length === 0) {
    view.layoutCenter.x = 0;
    view.layoutCenter.y = 0;
    return;
  }

  let sumMainX = 0;
  let sumMainY = 0;
  let mainCount = 0;
  for (const node of sourceNodes) {
    const degree =
      degreeById instanceof Map ? Number(degreeById.get(node.id) || 0) : Number(node.degree || 0);
    const isOrphan = degree === 0;
    if (isOrphan) continue;
    sumMainX += node.x;
    sumMainY += node.y;
    mainCount += 1;
  }

  if (mainCount > 0) {
    view.layoutCenter.x = sumMainX / mainCount;
    view.layoutCenter.y = sumMainY / mainCount;
    return;
  }

  let sumAllX = 0;
  let sumAllY = 0;
  for (const node of sourceNodes) {
    sumAllX += node.x;
    sumAllY += node.y;
  }
  view.layoutCenter.x = sumAllX / sourceNodes.length;
  view.layoutCenter.y = sumAllY / sourceNodes.length;
}

// Camera smoothing per frame to avoid jumpy panning and zooming.
function stepCameraSmoothing(view) {
  const smooth = 0.22;
  view.camera.x += (view.cameraTarget.x - view.camera.x) * smooth;
  view.camera.y += (view.cameraTarget.y - view.camera.y) * smooth;
  view.camera.zoom += (view.cameraTarget.zoom - view.camera.zoom) * smooth;
}

// Main force simulation step: repel/link/center forces, pin constraints, and autosave settling.
// Pinned and sleeping nodes do not move, so forces between them are kept in a per-sleeper
// cache. Pair visits start only from moving sources; awake and waking nodes still receive
// their full sums in the original order, sleepers use cache + moving contributions.
function stepSimulation(view) {
  if (view.nodes.length === 0) {
    stepLayoutAutosave(view);
    return;
  }
  if (view.layoutPaused && !view.dragNodeId) {
    stepLayoutAutosave(view);
    return;
  }

  const filterVisibleNodeIds = getPhysicsVisibleNodeIds(view);
  const hasPhysicsFilter = filterVisibleNodeIds instanceof Set;
  if (hasPhysicsFilter) {
    for (const node of view.nodes) {
      if (filterVisibleNodeIds.has(node.id)) continue;
      node.vx = 0;
      node.vy = 0;
    }
  }
  let cache = physicsCaches.get(view);
  if (!cache) physicsCaches.set(view, (cache = { structure: null, statics: null }));
  const structure = ensureStructure(
    view,
    cache,
    hasPhysicsFilter ? filterVisibleNodeIds : null,
    !!view.plugin.data?.dark_energy?.length
  );
  const nodes = structure.nodes;
  const nodeCount = structure.count;
  if (nodeCount === 0) {
    stepLayoutAutosave(view);
    return;
  }
  updateLayoutCenterFromDegrees(view, nodes, structure.degree);

  const settings = view.plugin.getSettings();
  const layoutSearchFactor = 1;
  let sleepStates = layoutSleepStates.get(view);
  if (!sleepStates) {
    sleepStates = new WeakMap();
    layoutSleepStates.set(view, sleepStates);
  }

  const repelStrength = settings.repel_strength * 1 * layoutSearchFactor;
  const centerStrength = settings.center_strength * 0.000025 * layoutSearchFactor;
  const baseLinkStrength = settings.base_link_strength * 0.00015 * layoutSearchFactor;
  const linkDistance = view.plugin.clampNumber(
    settings.link_distance,
    1,
    50,
    DEFAULT_DATA.settings.link_distance
  );
  const damping = view.plugin.clampNumber(
    settings.damping,
    0.01,
    0.9,
    DEFAULT_DATA.settings.damping
  );
  const repelRadius = view.plugin.clampNumber(
    settings.repel_radius,
    20,
    1000,
    DEFAULT_DATA.settings.repel_radius
  );
  const orphanRepelRadius = repelRadius * 1.25;
  const orphanToMainRepelRadius = repelRadius * 1.25;
  const hasRepel = repelStrength > 0;
  const hasCenter = centerStrength > 0;
  const hasLink =
    baseLinkStrength > 0 && (hasPhysicsFilter ? structure.edgeCount > 0 : view.edges.length > 0);
  const hasDarkEnergy = view.plugin.data?.dark_energy?.some(
    (item) => view.nodeById.has(item.id) && (item.strength > 0 || item.repulsion > 0)
  );
  const noForces = !hasRepel && !hasCenter && !hasLink && !hasDarkEnergy;
  const maxCenterForce = 1.6;
  const maxAccel = 6;
  const maxSpeed = 26;
  const impulseGain = 7;
  const orphanCenterScale = 1;
  const oneSecondRetention = Math.pow(0.01, 1 / 60);
  const dampingRetention = 1 - damping * 0.95;
  const velocityRetention = Math.max(0.05, Math.min(0.995, oneSecondRetention * dampingRetention));
  const settleVelocityEps = 0.02;
  const settleAccelEps = 0.02;

  const flags = new Uint8Array(nodeCount);
  const pinX = new Array(nodeCount);
  const pinY = new Array(nodeCount);
  const orbitAnchors = new Array(nodeCount);
  const orbitRadius = new Array(nodeCount);
  const orbitAngle = new Array(nodeCount);
  const xs = new Float64Array(nodeCount);
  const ys = new Float64Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) {
    const node = nodes[i];
    xs[i] = node.x;
    ys[i] = node.y;
    if (structure.degree[i] === 0) flags[i] |= ORPHAN;
    const pin = view.plugin.getPin(node.id);
    if (pin) {
      flags[i] |= PINNED | FIXED;
      pinX[i] = pin.x;
      pinY[i] = pin.y;
    }
    const orbitPin = view.plugin.getOrbitPin(node.id);
    if (!orbitPin) continue;
    const anchorNode = view.nodeById.get(orbitPin.anchor_id);
    if (!anchorNode) continue;
    flags[i] |= ORBIT | FIXED;
    orbitAnchors[i] = anchorNode;
    orbitRadius[i] = orbitPin.radius;
    orbitAngle[i] = orbitPin.angle;
  }
  const activelyDraggedNodeIds = new Set();
  if (view.dragNodeId) activelyDraggedNodeIds.add(view.dragNodeId);
  if (view.dragSelectionOffsets instanceof Map) {
    for (const nodeId of view.dragSelectionOffsets.keys()) {
      if (!nodeId) continue;
      activelyDraggedNodeIds.add(nodeId);
    }
  }
  for (const nodeId of activelyDraggedNodeIds) {
    const index = structure.indexById.get(nodeId);
    if (index !== undefined) flags[index] |= DRAGGED;
  }
  let hasMovableNodes = false;
  for (let i = 0; i < nodeCount && !hasMovableNodes; i++) {
    hasMovableNodes = !(flags[i] & (FIXED | DRAGGED));
  }
  if (!view.dragNodeId && !hasMovableNodes) {
    view.layoutPaused = true;
    stepLayoutAutosave(view);
    return;
  }

  // Dragged and orbit nodes move as sources only; pinned nodes and sleepers are cached.
  const role = new Uint8Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) {
    if (flags[i] & DRAGGED) role[i] = SEED;
    else if (flags[i] & PINNED) flags[i] |= STATIC;
    else if (flags[i] & ORBIT) role[i] = SEED;
    else if ((sleepStates.get(nodes[i]) || 0) >= 8) {
      flags[i] |= SLEEPER | STATIC;
      role[i] = RECV;
    } else role[i] = SEED | RECV;
  }

  const multipliers = new Float64Array(nodeCount);
  const multiplierRead = new Uint8Array(nodeCount);
  const multiplierContext = {};
  if (hasLink) {
    for (let e = 0; e < structure.edgeCount; e++) {
      const s = structure.edgeSource[e];
      const t = structure.edgeTarget[e];
      if (flags[s] & FIXED && flags[t] & FIXED) continue;
      if (!multiplierRead[s]) {
        multipliers[s] = view.plugin.getNodeMultiplier(nodes[s].id, multiplierContext);
        multiplierRead[s] = 1;
      }
      if (!multiplierRead[t]) {
        multipliers[t] = view.plugin.getNodeMultiplier(nodes[t].id, multiplierContext);
        multiplierRead[t] = 1;
      }
    }
  }

  const step = {
    structure,
    flags,
    xs,
    ys,
    multipliers,
    hasRepel,
    hasLink,
    repelStrength,
    baseLinkStrength,
    linkDistance,
    repelRadiusSq: repelRadius * repelRadius,
    orphanRepelRadiusSq: orphanRepelRadius * orphanRepelRadius,
    orphanToMainRepelRadiusSq: orphanToMainRepelRadius * orphanToMainRepelRadius,
    grids: null,
    statics: null,
  };
  if (hasRepel) {
    step.grids = {
      main: buildGrid(
        xs,
        ys,
        structure.allIndices,
        (index) => !(flags[index] & ORPHAN),
        repelRadius
      ),
      orphan: buildGrid(xs, ys, structure.orphans, null, orphanRepelRadius),
      cross: buildGrid(xs, ys, structure.mains, null, orphanToMainRepelRadius),
    };
  }

  // Any doubt about the cached sources rebuilds the cache from the current state.
  let statics = cache.statics;
  let rebuild =
    !statics ||
    statics.structure !== structure ||
    statics.sleepStates !== sleepStates ||
    statics.hasRepel !== hasRepel ||
    statics.hasLink !== hasLink ||
    statics.repelStrength !== repelStrength ||
    statics.repelRadius !== repelRadius ||
    statics.baseLinkStrength !== baseLinkStrength ||
    statics.linkDistance !== linkDistance;
  const constraintBits = FIXED | ORBIT | PINNED | DRAGGED;
  for (let i = 0; i < nodeCount && !rebuild; i++) {
    if ((flags[i] & constraintBits) !== (statics.flags[i] & constraintBits)) rebuild = true;
    else if (flags[i] & PINNED && (pinX[i] !== statics.pinX[i] || pinY[i] !== statics.pinY[i]))
      rebuild = true;
    else if (
      multiplierRead[i] !== statics.multiplierRead[i] ||
      multipliers[i] !== statics.multipliers[i]
    )
      rebuild = true;
    else if (statics.inStat[i] && (xs[i] !== statics.x[i] || ys[i] !== statics.y[i]))
      rebuild = true;
  }
  if (rebuild) {
    statics = {
      structure,
      sleepStates,
      hasRepel,
      hasLink,
      repelStrength,
      repelRadius,
      baseLinkStrength,
      linkDistance,
      inStat: new Uint8Array(nodeCount),
      staticAx: new Float64Array(nodeCount),
      staticAy: new Float64Array(nodeCount),
      x: new Float64Array(nodeCount),
      y: new Float64Array(nodeCount),
      sleepers: 0,
    };
    cache.statics = statics;
  }
  statics.flags = flags;
  statics.pinX = pinX;
  statics.pinY = pinY;
  statics.multipliers = multipliers;
  statics.multiplierRead = multiplierRead;
  step.statics = statics;
  const { inStat, staticAx, staticAy } = statics;
  if (rebuild) {
    for (let i = 0; i < nodeCount; i++) {
      if (flags[i] & STATIC && !(flags[i] & SLEEPER)) updateStaticSource(step, i, 1);
    }
  } else {
    for (let i = 0; i < nodeCount; i++) {
      if (inStat[i] && !(flags[i] & STATIC)) updateStaticSource(step, i, -1);
    }
  }
  for (let i = 0; i < nodeCount; i++) {
    if (flags[i] & SLEEPER && !inStat[i]) updateStaticSource(step, i, 1);
  }

  const ax = new Float64Array(nodeCount);
  const ay = new Float64Array(nodeCount);
  accumulateForces(step, role, ax, ay);

  const darkEnergyTargets = getDarkEnergyTargets(view);
  const accel = { ax: 0, ay: 0 };
  const addSelfForces = (node, index) => {
    applyDarkEnergyForce(view, node, accel, darkEnergyTargets);
    if (hasCenter && node.id !== view.dragNodeId) {
      const nodeCenterScale = structure.degree[index] === 0 ? orphanCenterScale : 1;
      const centerFx = (0 - node.x) * centerStrength * nodeCenterScale;
      const centerFy = (0 - node.y) * centerStrength * nodeCenterScale;
      accel.ax += Math.max(-maxCenterForce, Math.min(maxCenterForce, centerFx));
      accel.ay += Math.max(-maxCenterForce, Math.min(maxCenterForce, centerFy));
    }
  };

  // Sleepers decide with cached + moving contributions; a waking node is recomputed exactly.
  const waking = new Uint8Array(nodeCount);
  const wakers = [];
  if (statics.sleepers > 0) {
    if (sleepForceProbe) {
      const probeRole = new Uint8Array(nodeCount);
      for (let i = 0; i < nodeCount; i++) if (flags[i] & SLEEPER) probeRole[i] = SEED | RECV;
      const fullAx = new Float64Array(nodeCount);
      const fullAy = new Float64Array(nodeCount);
      accumulateForces(step, probeRole, fullAx, fullAy);
      const sleepers = [];
      for (let i = 0; i < nodeCount; i++) {
        if (!(flags[i] & SLEEPER)) continue;
        sleepers.push({
          id: nodes[i].id,
          cached: [staticAx[i] + ax[i], staticAy[i] + ay[i]],
          full: [fullAx[i], fullAy[i]],
        });
      }
      sleepForceProbe({ view, sleepers });
    }
    for (let i = 0; i < nodeCount; i++) {
      if (!(flags[i] & SLEEPER)) continue;
      const node = nodes[i];
      accel.ax = staticAx[i] + ax[i];
      accel.ay = staticAy[i] + ay[i];
      addSelfForces(node, i);
      accel.ax /= structure.mass[i];
      accel.ay /= structure.mass[i];
      if (
        Math.hypot(accel.ax, accel.ay) < settleAccelEps * 2 &&
        Math.hypot(node.vx, node.vy) < settleVelocityEps * 2
      )
        continue;
      waking[i] = SEED | RECV;
      wakers.push(i);
    }
    for (const index of wakers) updateStaticSource(step, index, -1);
  }
  const wakeAx = wakers.length ? new Float64Array(nodeCount) : ax;
  const wakeAy = wakers.length ? new Float64Array(nodeCount) : ay;
  if (wakers.length) accumulateForces(step, waking, wakeAx, wakeAy);

  let movingNodeCount = 0;
  let awakeNodeCount = 0;
  for (let i = 0; i < nodeCount; i++) {
    const node = nodes[i];
    const nodeFlags = flags[i];

    if (nodeFlags & DRAGGED) {
      node.vx = 0;
      node.vy = 0;
      continue;
    }

    if (nodeFlags & PINNED) {
      node.x = pinX[i];
      node.y = pinY[i];
      node.vx = 0;
      node.vy = 0;
      continue;
    }

    if (nodeFlags & ORBIT) {
      const anchorNode = orbitAnchors[i];
      node.x = anchorNode.x + Math.cos(orbitAngle[i]) * orbitRadius[i];
      node.y = anchorNode.y + Math.sin(orbitAngle[i]) * orbitRadius[i];
      node.vx = 0;
      node.vy = 0;
      continue;
    }

    if (nodeFlags & SLEEPER && !waking[i]) {
      node.vx = 0;
      node.vy = 0;
      continue;
    }
    accel.ax = waking[i] ? wakeAx[i] : ax[i];
    accel.ay = waking[i] ? wakeAy[i] : ay[i];
    addSelfForces(node, i);
    // One degree-based mass for the summed force keeps every pair force momentum-conserving;
    // dividing only link forces let asymmetric clusters propel and spin themselves.
    accel.ax /= structure.mass[i];
    accel.ay /= structure.mass[i];

    const accelMag = Math.hypot(accel.ax, accel.ay);
    let stillFrames = sleepStates.get(node) || 0;
    // A higher wake threshold prevents tiny force fluctuations from causing jitter.
    if (
      stillFrames >= 8 &&
      accelMag < settleAccelEps * 2 &&
      Math.hypot(node.vx, node.vy) < settleVelocityEps * 2
    ) {
      node.vx = 0;
      node.vy = 0;
      continue;
    }
    if (stillFrames >= 8) stillFrames = 0;

    if (noForces) {
      const calmFactor = layoutSearchFactor <= 0 ? 0.3 : 0.5;
      node.vx *= calmFactor;
      node.vy *= calmFactor;
    } else {
      let accelX = accel.ax;
      let accelY = accel.ay;
      const accelMagRaw = Math.sqrt(accelX * accelX + accelY * accelY);
      if (accelMagRaw > maxAccel) {
        const accelScale = maxAccel / accelMagRaw;
        accelX *= accelScale;
        accelY *= accelScale;
      }
      node.vx += accelX * impulseGain;
      node.vy += accelY * impulseGain;
      node.vx *= velocityRetention;
      node.vy *= velocityRetention;
    }
    const speedNow = Math.sqrt(node.vx * node.vx + node.vy * node.vy);
    if (speedNow > maxSpeed) {
      const ratio = maxSpeed / speedNow;
      node.vx *= ratio;
      node.vy *= ratio;
    }
    if (speedNow < settleVelocityEps && accelMag < settleAccelEps) {
      node.vx = 0;
      node.vy = 0;
      stillFrames += 1;
    } else {
      stillFrames = 0;
      movingNodeCount += 1;
    }

    sleepStates.set(node, stillFrames);
    if (stillFrames < 8) awakeNodeCount += 1;

    node.x += node.vx;
    node.y += node.vy;
  }

  if (movingNodeCount > 0 && typeof view.markNodeSpatialIndexDirty === 'function') {
    view.markNodeSpatialIndexDirty();
  }

  if (settings.layout_autosave && !view.isSearchFilled() && movingNodeCount > 0) {
    view.layoutAutosaveDirty = true;
    view.layoutPaused = false;
  }
  stepLayoutAutosave(view, movingNodeCount > 0);

  if (!view.dragNodeId && !activelyDraggedNodeIds.size && awakeNodeCount === 0) {
    view.layoutPaused = true;
    const readMultipliers = new Map();
    for (let i = 0; i < nodeCount; i++) {
      if (multiplierRead[i]) readMultipliers.set(nodes[i].id, multipliers[i]);
    }
    layoutSleepSignatures.set(view, layoutSleepSignature(view, readMultipliers, multiplierContext));
  }
}

// Orbit radius helper: keep node spacing readable while respecting a minimum radius.
function getOrbitRadiusBySpacing(plugin, orbitNodeCount, minRadius) {
  const orbitDistance = plugin.clampNumber(
    plugin.getSettings().orbit_distance,
    1,
    100,
    DEFAULT_DATA.settings.orbit_distance
  );
  const safeMinRadius = plugin.clampNumber(minRadius, 1, 100, 1);
  const safeOrbitNodeCount = Math.max(1, Number(orbitNodeCount) || 1);
  const radiusBySpacing = (safeOrbitNodeCount * orbitDistance) / TWO_PI;
  return Math.max(safeMinRadius, radiusBySpacing);
}

// Anchor orbit radius helper: never smaller than base link distance.
function getOrbitRadiusForAnchor(plugin, orbitNodeCount) {
  const linkDistance = plugin.clampNumber(
    plugin.getSettings().link_distance,
    1,
    50,
    DEFAULT_DATA.settings.link_distance
  );
  return getOrbitRadiusBySpacing(plugin, orbitNodeCount, linkDistance);
}

// Recompute persisted orbit radii and reposition orbit-pinned nodes after settings changes.
function recomputeOrbitRadii(view) {
  const orbitPins = view.plugin.data.orbit_pins || {};
  const orbitNodeIdsByAnchor = new Map();

  for (const [orbitNodeId, orbitMeta] of Object.entries(orbitPins)) {
    const anchorId = String(orbitMeta?.anchor_id || '').trim();
    if (!anchorId) continue;
    if (!view.nodeById.has(orbitNodeId)) continue;
    if (!view.nodeById.has(anchorId)) continue;
    if (!orbitNodeIdsByAnchor.has(anchorId)) orbitNodeIdsByAnchor.set(anchorId, []);
    orbitNodeIdsByAnchor.get(anchorId).push(orbitNodeId);
  }

  let changed = false;
  for (const [anchorId, orbitNodeIds] of orbitNodeIdsByAnchor.entries()) {
    const orbitRadius = getOrbitRadiusForAnchor(view.plugin, orbitNodeIds.length);
    const anchorNode = view.nodeById.get(anchorId);
    if (!anchorNode) continue;

    for (const orbitNodeId of orbitNodeIds) {
      const orbitMeta = orbitPins[orbitNodeId];
      if (!orbitMeta) continue;
      if (Number(orbitMeta.radius) !== orbitRadius) {
        orbitMeta.radius = orbitRadius;
        changed = true;
      }

      const orbitNode = view.nodeById.get(orbitNodeId);
      if (!orbitNode) continue;
      const angle = Number(orbitMeta.angle) || 0;
      orbitNode.x = anchorNode.x + Math.cos(angle) * orbitRadius;
      orbitNode.y = anchorNode.y + Math.sin(angle) * orbitRadius;
      orbitNode.vx = 0;
      orbitNode.vy = 0;
    }
  }

  if (changed) view.plugin.schedulePersist();
  kickLayoutSearch(view);
  view.plugin.renderAllViews();
}

module.exports = {
  setSleepForceProbe,
  wakeOnPhysicsVisibilityChange,
  resetPhysicsVisibilityBaseline,
  normalizeLayoutSleep,
  captureLayoutSleep,
  restoreLayoutSleep,
  copyLayoutSleepState,
  kickLayoutSearch,
  updateLayoutCenter,
  stepCameraSmoothing,
  stepSimulation,
  stepLayoutAutosave,
  getOrbitRadiusBySpacing,
  getOrbitRadiusForAnchor,
  recomputeOrbitRadii,
};
