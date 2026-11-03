// Frozen pre-cache physics (before sleeping-source caching), used only as a test oracle.
// Do not update it together with src/physics.js optimizations: equality against it is the
// point. Only intentional force-model changes (such as mass for all forces) go into both.
const { TWO_PI, DEFAULT_DATA } = require('../../src/constants');
const { getDarkEnergyTargets, applyDarkEnergyForce } = require('../../src/dark-energy');

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

function layoutSleepSignature(view, multipliers = new Map(), multiplierContext = {}) {
  const settings = view.plugin.getSettings();
  const visible = view.getFilterVisibleNodeIds();
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
    view.nodes
      .map((node) => [
        node.id,
        node.x,
        node.y,
        view.plugin.getPin(node.id),
        view.plugin.getOrbitPin(node.id),
        cachedNodeMultiplier(view.plugin, node.id, multipliers, multiplierContext),
      ])
      .sort((a, b) => a[0].localeCompare(b[0])),
    view.edges
      .map((edge) => [edge.source, edge.target].sort())
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    visible instanceof Set ? [...visible].sort() : null,
    view.plugin.data?.dark_energy || [],
    [...targets]
      .map(([id, entries]) => [id, entries.map(({ item, matches }) => [item.id, matches])])
      .sort((a, b) => a[0].localeCompare(b[0])),
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

function buildSpatialIndex(xs, ys, indices, cellSize) {
  const safeCellSize = Math.max(1, Number(cellSize) || 1);
  const columns = new Map();
  const bucketList = [];
  const next = new Int32Array(xs.length).fill(-1);

  // Sparse numeric cells retain insertion order, including the original pair order.
  for (const index of indices) {
    const gx = Math.floor(xs[index] / safeCellSize);
    const gy = Math.floor(ys[index] / safeCellSize);
    let column = columns.get(gx);
    if (!column) columns.set(gx, (column = new Map()));
    let bucket = column.get(gy);
    if (!bucket) {
      bucket = { gx, gy, index: bucketList.length, head: index, tail: index };
      column.set(gy, bucket);
      bucketList.push(bucket);
    } else {
      next[bucket.tail] = index;
      bucket.tail = index;
    }
  }

  return { columns, bucketList, next, xs, ys, cellSize: safeCellSize };
}

function forEachNearbyNodePair(spatialIndex, radius, callback) {
  if (!spatialIndex || !spatialIndex.bucketList || spatialIndex.bucketList.length === 0) return;
  const searchRadius = Math.max(1, Number(radius) || 1);
  const bucketRange = Math.max(1, Math.ceil(searchRadius / spatialIndex.cellSize));

  for (const bucketA of spatialIndex.bucketList) {
    for (let offsetX = -bucketRange; offsetX <= bucketRange; offsetX += 1) {
      const column = spatialIndex.columns.get(bucketA.gx + offsetX);
      if (!column) continue;
      for (let offsetY = -bucketRange; offsetY <= bucketRange; offsetY += 1) {
        const bucketB = column.get(bucketA.gy + offsetY);
        if (!bucketB || bucketB.index < bucketA.index) continue;

        for (let a = bucketA.head; a !== -1; a = spatialIndex.next[a]) {
          for (
            let b = bucketA === bucketB ? spatialIndex.next[a] : bucketB.head;
            b !== -1;
            b = spatialIndex.next[b]
          ) {
            callback(a, b);
          }
        }
      }
    }
  }
}

function forEachNearbyNodeFromIndex(spatialIndex, sourceIndex, radius, callback) {
  if (!spatialIndex) return;
  const searchRadius = Math.max(1, Number(radius) || 1);
  const bucketRange = Math.max(1, Math.ceil(searchRadius / spatialIndex.cellSize));
  const sourceGX = Math.floor(spatialIndex.xs[sourceIndex] / spatialIndex.cellSize);
  const sourceGY = Math.floor(spatialIndex.ys[sourceIndex] / spatialIndex.cellSize);

  for (let offsetX = -bucketRange; offsetX <= bucketRange; offsetX += 1) {
    const column = spatialIndex.columns.get(sourceGX + offsetX);
    if (!column) continue;
    for (let offsetY = -bucketRange; offsetY <= bucketRange; offsetY += 1) {
      const bucket = column.get(sourceGY + offsetY);
      if (!bucket) continue;
      for (let target = bucket.head; target !== -1; target = spatialIndex.next[target])
        callback(target);
    }
  }
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
function stepSimulation(view) {
  if (view.nodes.length === 0) {
    stepLayoutAutosave(view);
    return;
  }
  if (view.layoutPaused && !view.dragNodeId) {
    stepLayoutAutosave(view);
    return;
  }

  const filterVisibleNodeIds = view.getFilterVisibleNodeIds();
  const hasPhysicsFilter = filterVisibleNodeIds instanceof Set;
  if (hasPhysicsFilter) {
    for (const node of view.nodes) {
      if (filterVisibleNodeIds.has(node.id)) continue;
      node.vx = 0;
      node.vy = 0;
    }
  }
  let nodes = hasPhysicsFilter
    ? view.nodes.filter((node) => filterVisibleNodeIds.has(node.id))
    : view.nodes;
  if (view.plugin.data?.dark_energy?.length) nodes = nodes.filter((node) => !node.meta?.darkEnergy);
  const nodeCount = nodes.length;
  if (nodeCount === 0) {
    stepLayoutAutosave(view);
    return;
  }
  const localDegreeById = hasPhysicsFilter ? new Map(nodes.map((node) => [node.id, 0])) : null;
  if (localDegreeById) {
    for (const edge of view.edges) {
      if (!localDegreeById.has(edge.source) || !localDegreeById.has(edge.target)) continue;
      localDegreeById.set(edge.source, Number(localDegreeById.get(edge.source) || 0) + 1);
      localDegreeById.set(edge.target, Number(localDegreeById.get(edge.target) || 0) + 1);
    }
  }
  const getNodeDegree = (node) =>
    localDegreeById instanceof Map
      ? Number(localDegreeById.get(node.id) || 0)
      : Number(node.degree || 0);
  updateLayoutCenter(view, nodes, localDegreeById);

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
  const repelRadiusSq = repelRadius * repelRadius;
  const orphanRepelRadiusSq = orphanRepelRadius * orphanRepelRadius;
  const orphanToMainRepelRadiusSq = orphanToMainRepelRadius * orphanToMainRepelRadius;
  const hasRepel = repelStrength > 0;
  const hasCenter = centerStrength > 0;
  let hasLink = baseLinkStrength > 0 && view.edges.length > 0;
  if (hasLink && hasPhysicsFilter) {
    hasLink = view.edges.some(
      (edge) => filterVisibleNodeIds.has(edge.source) && filterVisibleNodeIds.has(edge.target)
    );
  }
  const hasDarkEnergy = view.plugin.data?.dark_energy?.some(
    (item) => view.nodeById.has(item.id) && (item.strength > 0 || item.repulsion > 0)
  );
  const noForces = !hasRepel && !hasCenter && !hasLink && !hasDarkEnergy;
  const minRepelDistance = 28;
  const maxRepelForce = 16;
  const maxSpringForce = 20;
  const maxCenterForce = 1.6;
  const maxAccel = 6;
  const maxSpeed = 26;
  const impulseGain = 7;
  const degreeMassFactor = 0.25;
  const orphanRepelScale = 1.2;
  const orphanToMainRepelScale = 5.2;
  const regularBackReactionScale = 0.06;
  const orphanCenterScale = 1;
  const oneSecondRetention = Math.pow(0.01, 1 / 60);
  const dampingRetention = 1 - damping * 0.95;
  const velocityRetention = Math.max(0.05, Math.min(0.995, oneSecondRetention * dampingRetention));
  const settleVelocityEps = 0.02;
  const settleAccelEps = 0.02;

  const accelById = new Map();
  for (const node of nodes) accelById.set(node.id, { ax: 0, ay: 0 });
  const pinsById = new Map();
  for (const node of nodes) {
    const pin = view.plugin.getPin(node.id);
    if (pin) pinsById.set(node.id, pin);
  }
  const orbitPinsById = new Map();
  for (const node of nodes) {
    const orbitPin = view.plugin.getOrbitPin(node.id);
    if (!orbitPin) continue;
    const anchorNode = view.nodeById.get(orbitPin.anchor_id);
    if (!anchorNode) continue;
    orbitPinsById.set(node.id, orbitPin);
  }
  const orbitNodeIds = new Set(orbitPinsById.keys());
  const fixedNodeIds = new Set([...pinsById.keys(), ...orbitNodeIds]);
  const activelyDraggedNodeIds = new Set();
  if (view.dragNodeId) activelyDraggedNodeIds.add(view.dragNodeId);
  if (view.dragSelectionOffsets instanceof Map) {
    for (const nodeId of view.dragSelectionOffsets.keys()) {
      if (!nodeId) continue;
      activelyDraggedNodeIds.add(nodeId);
    }
  }
  const hasMovableNodes = nodes.some(
    (node) => !fixedNodeIds.has(node.id) && !activelyDraggedNodeIds.has(node.id)
  );
  if (!view.dragNodeId && !hasMovableNodes) {
    view.layoutPaused = true;
    stepLayoutAutosave(view);
    return;
  }
  let movingNodeCount = 0;
  let awakeNodeCount = 0;

  if (hasRepel) {
    const xs = new Float64Array(nodeCount);
    const ys = new Float64Array(nodeCount);
    const ax = new Float64Array(nodeCount);
    const ay = new Float64Array(nodeCount);
    const flags = new Uint8Array(nodeCount);
    const indices = new Int32Array(nodeCount);
    const orphanIndices = [];
    const mainIndices = [];
    // All nodes still exert forces, including fixed and sleeping ones. Only the
    // representation changes; Float64 and insertion order preserve accumulation.
    for (let i = 0; i < nodeCount; i++) {
      const node = nodes[i];
      indices[i] = i;
      xs[i] = node.x;
      ys[i] = node.y;
      flags[i] =
        (fixedNodeIds.has(node.id) ? 1 : 0) |
        (orbitNodeIds.has(node.id) ? 2 : 0) |
        (getNodeDegree(node) === 0 ? 4 : 0);
      if (flags[i] & 4) orphanIndices.push(i);
      else mainIndices.push(i);
    }
    const nodeSpatialIndex = buildSpatialIndex(xs, ys, indices, repelRadius);
    forEachNearbyNodePair(nodeSpatialIndex, repelRadius, (a, b) => {
      if (flags[a] & 1 && flags[b] & 1) return;
      if ((flags[a] | flags[b]) & 4) return;
      const dx = xs[b] - xs[a];
      const dy = ys[b] - ys[a];
      const distSq = dx * dx + dy * dy;
      if (distSq > repelRadiusSq) return;
      const dist = Math.sqrt(distSq) || 0.0001;
      const safeDist = Math.max(minRepelDistance, dist);

      const force = Math.min(maxRepelForce, repelStrength / (safeDist * safeDist));
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;

      if (!(flags[a] & 2)) {
        ax[a] -= fx;
        ay[a] -= fy;
      }
      if (!(flags[b] & 2)) {
        ax[b] += fx;
        ay[b] += fy;
      }
    });

    const orphanRepelStrength = repelStrength * orphanRepelScale;
    if (orphanRepelStrength > 0 && orphanIndices.length > 1) {
      const orphanSpatialIndex = buildSpatialIndex(xs, ys, orphanIndices, orphanRepelRadius);
      forEachNearbyNodePair(orphanSpatialIndex, orphanRepelRadius, (a, b) => {
        if (flags[a] & 1 && flags[b] & 1) return;
        const dx = xs[b] - xs[a];
        const dy = ys[b] - ys[a];
        const distSq = dx * dx + dy * dy;
        if (distSq > orphanRepelRadiusSq) return;
        const dist = Math.sqrt(distSq) || 0.0001;
        const safeDist = Math.max(minRepelDistance, dist);
        const force = Math.min(maxRepelForce, orphanRepelStrength / (safeDist * safeDist));
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;

        ax[a] -= fx;
        ay[a] -= fy;
        ax[b] += fx;
        ay[b] += fy;
      });
    }

    const orphanToMainRepelStrength = repelStrength * orphanToMainRepelScale;
    if (orphanToMainRepelStrength > 0 && orphanIndices.length > 0 && mainIndices.length > 0) {
      const mainSpatialIndex = buildSpatialIndex(xs, ys, mainIndices, orphanToMainRepelRadius);
      for (const orphan of orphanIndices) {
        forEachNearbyNodeFromIndex(mainSpatialIndex, orphan, orphanToMainRepelRadius, (main) => {
          if (flags[orphan] & 1 && flags[main] & 1) return;
          const dx = xs[main] - xs[orphan];
          const dy = ys[main] - ys[orphan];
          const distSq = dx * dx + dy * dy;
          if (distSq > orphanToMainRepelRadiusSq) return;
          const dist = Math.sqrt(distSq) || 0.0001;
          const safeDist = Math.max(minRepelDistance, dist);
          const force = Math.min(maxRepelForce, orphanToMainRepelStrength / (safeDist * safeDist));
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;

          ax[orphan] -= fx;
          ay[orphan] -= fy;
          if (!(flags[main] & 2)) {
            ax[main] += fx * regularBackReactionScale;
            ay[main] += fy * regularBackReactionScale;
          }
        });
      }
    }
    for (let i = 0; i < nodeCount; i++) {
      const accel = accelById.get(nodes[i].id);
      accel.ax = ax[i];
      accel.ay = ay[i];
    }
  }

  const multipliers = new Map();
  const multiplierContext = {};
  if (hasLink) {
    for (const edge of view.edges) {
      if (
        hasPhysicsFilter &&
        (!filterVisibleNodeIds.has(edge.source) || !filterVisibleNodeIds.has(edge.target))
      ) {
        continue;
      }
      const sourceNode = view.nodeById.get(edge.source);
      const targetNode = view.nodeById.get(edge.target);
      if (!sourceNode || !targetNode) continue;
      const sourceIsFixed = fixedNodeIds.has(sourceNode.id);
      const targetIsFixed = fixedNodeIds.has(targetNode.id);
      if (sourceIsFixed && targetIsFixed) continue;
      const dx = targetNode.x - sourceNode.x;
      const dy = targetNode.y - sourceNode.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;

      const sourceMultiplier = cachedNodeMultiplier(
        view.plugin,
        sourceNode.id,
        multipliers,
        multiplierContext
      );
      const targetMultiplier = cachedNodeMultiplier(
        view.plugin,
        targetNode.id,
        multipliers,
        multiplierContext
      );
      const edgeMultiplier = Math.max(sourceMultiplier, targetMultiplier);
      const stretch = dist - linkDistance;
      // Temporary test mode: disable degree-based normalization for link force.
      const springForceRaw = baseLinkStrength * edgeMultiplier * stretch;
      const springForce = Math.max(-maxSpringForce, Math.min(maxSpringForce, springForceRaw));
      const fx = (dx / dist) * springForce;
      const fy = (dy / dist) * springForce;
      const sourceAccel = accelById.get(sourceNode.id);
      const targetAccel = accelById.get(targetNode.id);
      if (!sourceIsFixed) {
        sourceAccel.ax += fx;
        sourceAccel.ay += fy;
      }
      if (!targetIsFixed) {
        targetAccel.ax -= fx;
        targetAccel.ay -= fy;
      }
    }
  }

  const darkEnergyTargets = getDarkEnergyTargets(view);
  for (const node of nodes) {
    const pin = pinsById.get(node.id) || null;
    const orbitPin = orbitPinsById.get(node.id) || null;
    const accel = accelById.get(node.id) || { ax: 0, ay: 0 };

    if (!pin && !orbitPin && !activelyDraggedNodeIds.has(node.id)) {
      applyDarkEnergyForce(view, node, accel, darkEnergyTargets);
    }
    if (hasCenter && !pin && !orbitPin && node.id !== view.dragNodeId) {
      const nodeCenterScale = getNodeDegree(node) === 0 ? orphanCenterScale : 1;
      const centerFx = (0 - node.x) * centerStrength * nodeCenterScale;
      const centerFy = (0 - node.y) * centerStrength * nodeCenterScale;
      accel.ax += Math.max(-maxCenterForce, Math.min(maxCenterForce, centerFx));
      accel.ay += Math.max(-maxCenterForce, Math.min(maxCenterForce, centerFy));
    }

    if (activelyDraggedNodeIds.has(node.id)) {
      node.vx = 0;
      node.vy = 0;
      continue;
    }

    if (pin) {
      node.x = pin.x;
      node.y = pin.y;
      node.vx = 0;
      node.vy = 0;
      continue;
    }

    if (orbitPin) {
      const anchorNode = view.nodeById.get(orbitPin.anchor_id);
      if (anchorNode) {
        node.x = anchorNode.x + Math.cos(orbitPin.angle) * orbitPin.radius;
        node.y = anchorNode.y + Math.sin(orbitPin.angle) * orbitPin.radius;
      }
      node.vx = 0;
      node.vy = 0;
      continue;
    }

    // The summed force is divided by one degree-based mass (same model as src/physics.js).
    const nodeMass = 1 + Math.max(0, getNodeDegree(node) - 1) * degreeMassFactor;
    accel.ax /= nodeMass;
    accel.ay /= nodeMass;
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
    layoutSleepSignatures.set(view, layoutSleepSignature(view, multipliers, multiplierContext));
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
