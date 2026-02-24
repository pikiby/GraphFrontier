const { TWO_PI, DEFAULT_DATA } = require('./constants');

// Simulation restart marker used after manual layout-changing actions.
function kickLayoutSearch(view) {
  view.layoutKickAtMs = Date.now();
  view.layoutStillFrames = 0;
  view.layoutAutosaveDirty = true;
  view.layoutPaused = false;
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
    const isAttachment = !!node?.meta?.isAttachment;
    const degree =
      degreeById instanceof Map ? Number(degreeById.get(node.id) || 0) : Number(node.degree || 0);
    const isOrphan = degree === 0;
    if (isAttachment || isOrphan) continue;
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
  if (view.layoutPaused && !view.dragNodeId) return;
  if (view.nodes.length === 0) return;

  const filterVisibleNodeIds = view.getFilterVisibleNodeIds();
  const hasPhysicsFilter = filterVisibleNodeIds instanceof Set;
  if (hasPhysicsFilter) {
    for (const node of view.nodes) {
      if (filterVisibleNodeIds.has(node.id)) continue;
      node.vx = 0;
      node.vy = 0;
    }
  }
  const nodes = hasPhysicsFilter
    ? view.nodes.filter((node) => filterVisibleNodeIds.has(node.id))
    : view.nodes;
  const nodeCount = nodes.length;
  if (nodeCount === 0) return;
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
  const nowMs = Date.now();
  const layoutSearchMs = 3000;
  const elapsedSearchMs = nowMs - view.layoutKickAtMs;
  const layoutSearchFactor = 1;
  const settleProgress = view.dragNodeId
    ? 0
    : Math.max(0, Math.min(1, elapsedSearchMs / layoutSearchMs));
  // Gradual global slowdown during settle window to imitate increasing damping.
  const settleVelocityBrake = 1 - settleProgress * 0.7;

  const repelStrength = settings.repel_strength * 1 * layoutSearchFactor;
  const centerStrength = settings.center_strength * 0.000025 * layoutSearchFactor;
  const baseLinkStrength = settings.base_link_strength * 0.00015 * layoutSearchFactor;
  const linkDistance = view.plugin.clampNumber(
    settings.link_distance,
    1,
    50,
    DEFAULT_DATA.settings.link_distance
  );
  const attachmentLinkDistance = view.plugin.clampNumber(
    settings.attachment_link_distance_multiplier,
    1,
    100,
    DEFAULT_DATA.settings.attachment_link_distance_multiplier
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
    500,
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
  const noForces = !hasRepel && !hasCenter && !hasLink;
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
  const attachmentOnlyRepelScale = 0.85;
  const attachmentOnlyToMainRepelScale = 3.6;
  const regularBackReactionScale = 0.06;
  const attachmentOnlyBackReactionScale = 0.04;
  const orphanCenterScale = 1;
  const oneSecondRetention = Math.pow(0.01, 1 / 60);
  const dampingRetention = 1 - damping * 0.95;
  const velocityRetention = Math.max(0.05, Math.min(0.995, oneSecondRetention * dampingRetention));
  const settleVelocityEps = 0.02;
  const settleAccelEps = 0.02;

  const accelById = new Map();
  for (const node of nodes) accelById.set(node.id, { ax: 0, ay: 0 });
  const orbitPinsById = new Map();
  for (const node of nodes) {
    const orbitPin = view.plugin.getOrbitPin(node.id);
    if (!orbitPin) continue;
    const anchorNode = view.nodeById.get(orbitPin.anchor_id);
    if (!anchorNode) continue;
    orbitPinsById.set(node.id, orbitPin);
  }
  const orbitNodeIds = new Set(orbitPinsById.keys());
  const autoAttachmentOrbitById = buildAttachmentAutoOrbitMap(
    view,
    hasPhysicsFilter ? filterVisibleNodeIds : null
  );
  const autoAttachmentOrbitNodeIds = new Set(autoAttachmentOrbitById.keys());
  const freeOrphanNodes = [];
  const attachmentOnlyAnchorNodes = [];
  const attachmentOnlyAnchorIds = new Set();
  const mainNodesForOrphanRepel = [];
  for (const node of nodes) {
    const nodeDegree = getNodeDegree(node);
    if (autoAttachmentOrbitNodeIds.has(node.id)) continue;
    if (nodeDegree === 0) freeOrphanNodes.push(node);
    if (nodeDegree > 0 && !node?.meta?.isAttachment) {
      const neighborIds = view.neighborsById.get(node.id);
      if (!neighborIds || neighborIds.size === 0) {
        mainNodesForOrphanRepel.push(node);
        continue;
      }
      let hasRegularNeighbor = false;
      for (const neighborId of neighborIds) {
        if (hasPhysicsFilter && !filterVisibleNodeIds.has(neighborId)) continue;
        const neighborNode = view.nodeById.get(neighborId);
        if (!neighborNode) continue;
        if (!neighborNode.meta?.isAttachment) {
          hasRegularNeighbor = true;
          break;
        }
      }
      // Attachment-only anchors: regular nodes linked only to attachments.
      // They use orphan-like mechanics with reduced force to stay stable and smooth.
      if (!hasRegularNeighbor) {
        attachmentOnlyAnchorNodes.push(node);
        attachmentOnlyAnchorIds.add(node.id);
        continue;
      }
      mainNodesForOrphanRepel.push(node);
    }
  }
  let movingNodeCount = 0;

  if (hasRepel) {
    for (let indexA = 0; indexA < nodeCount; indexA += 1) {
      const nodeA = nodes[indexA];
      for (let indexB = indexA + 1; indexB < nodeCount; indexB += 1) {
        const nodeB = nodes[indexB];
        if (autoAttachmentOrbitNodeIds.has(nodeA.id) || autoAttachmentOrbitNodeIds.has(nodeB.id))
          continue;
        if (getNodeDegree(nodeA) === 0 || getNodeDegree(nodeB) === 0) continue;
        if (attachmentOnlyAnchorIds.has(nodeA.id) || attachmentOnlyAnchorIds.has(nodeB.id))
          continue;
        const nodeAIsOrbitPinned = orbitNodeIds.has(nodeA.id);
        const nodeBIsOrbitPinned = orbitNodeIds.has(nodeB.id);
        if (nodeAIsOrbitPinned && nodeBIsOrbitPinned) continue;
        const dx = nodeB.x - nodeA.x;
        const dy = nodeB.y - nodeA.y;
        const distSq = dx * dx + dy * dy;
        if (distSq > repelRadiusSq) continue;
        const dist = Math.sqrt(distSq) || 0.0001;
        const safeDist = Math.max(minRepelDistance, dist);

        const force = Math.min(maxRepelForce, repelStrength / (safeDist * safeDist));
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;

        const a = accelById.get(nodeA.id);
        const b = accelById.get(nodeB.id);
        if (!nodeAIsOrbitPinned) {
          a.ax -= fx;
          a.ay -= fy;
        }
        if (!nodeBIsOrbitPinned) {
          b.ax += fx;
          b.ay += fy;
        }
      }
    }

    const orphanRepelStrength = repelStrength * orphanRepelScale;
    if (orphanRepelStrength > 0 && freeOrphanNodes.length > 1) {
      for (let indexA = 0; indexA < freeOrphanNodes.length; indexA += 1) {
        const nodeA = freeOrphanNodes[indexA];
        for (let indexB = indexA + 1; indexB < freeOrphanNodes.length; indexB += 1) {
          const nodeB = freeOrphanNodes[indexB];
          const dx = nodeB.x - nodeA.x;
          const dy = nodeB.y - nodeA.y;
          const distSq = dx * dx + dy * dy;
          if (distSq > orphanRepelRadiusSq) continue;
          const dist = Math.sqrt(distSq) || 0.0001;
          const safeDist = Math.max(minRepelDistance, dist);
          const force = Math.min(maxRepelForce, orphanRepelStrength / (safeDist * safeDist));
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;

          const a = accelById.get(nodeA.id);
          const b = accelById.get(nodeB.id);
          a.ax -= fx;
          a.ay -= fy;
          b.ax += fx;
          b.ay += fy;
        }
      }
    }

    const attachmentOnlyRepelStrength = repelStrength * attachmentOnlyRepelScale;
    if (attachmentOnlyRepelStrength > 0 && attachmentOnlyAnchorNodes.length > 1) {
      for (let indexA = 0; indexA < attachmentOnlyAnchorNodes.length; indexA += 1) {
        const nodeA = attachmentOnlyAnchorNodes[indexA];
        for (let indexB = indexA + 1; indexB < attachmentOnlyAnchorNodes.length; indexB += 1) {
          const nodeB = attachmentOnlyAnchorNodes[indexB];
          const nodeAIsOrbitPinned = orbitNodeIds.has(nodeA.id);
          const nodeBIsOrbitPinned = orbitNodeIds.has(nodeB.id);
          if (nodeAIsOrbitPinned && nodeBIsOrbitPinned) continue;
          const dx = nodeB.x - nodeA.x;
          const dy = nodeB.y - nodeA.y;
          const distSq = dx * dx + dy * dy;
          if (distSq > orphanRepelRadiusSq) continue;
          const dist = Math.sqrt(distSq) || 0.0001;
          const safeDist = Math.max(minRepelDistance, dist);
          const force = Math.min(
            maxRepelForce,
            attachmentOnlyRepelStrength / (safeDist * safeDist)
          );
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;

          const a = accelById.get(nodeA.id);
          const b = accelById.get(nodeB.id);
          if (!nodeAIsOrbitPinned) {
            a.ax -= fx;
            a.ay -= fy;
          }
          if (!nodeBIsOrbitPinned) {
            b.ax += fx;
            b.ay += fy;
          }
        }
      }
    }

    const orphanToAttachmentOnlyRepelStrength =
      repelStrength * ((orphanRepelScale + attachmentOnlyRepelScale) / 2);
    if (
      orphanToAttachmentOnlyRepelStrength > 0 &&
      freeOrphanNodes.length > 0 &&
      attachmentOnlyAnchorNodes.length > 0
    ) {
      for (const orphanNode of freeOrphanNodes) {
        for (const attachmentOnlyNode of attachmentOnlyAnchorNodes) {
          const attachmentOnlyIsOrbitPinned = orbitNodeIds.has(attachmentOnlyNode.id);
          const dx = attachmentOnlyNode.x - orphanNode.x;
          const dy = attachmentOnlyNode.y - orphanNode.y;
          const distSq = dx * dx + dy * dy;
          if (distSq > orphanRepelRadiusSq) continue;
          const dist = Math.sqrt(distSq) || 0.0001;
          const safeDist = Math.max(minRepelDistance, dist);
          const force = Math.min(
            maxRepelForce,
            orphanToAttachmentOnlyRepelStrength / (safeDist * safeDist)
          );
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;

          const orphanAccel = accelById.get(orphanNode.id);
          const attachmentOnlyAccel = accelById.get(attachmentOnlyNode.id);
          orphanAccel.ax -= fx;
          orphanAccel.ay -= fy;
          if (!attachmentOnlyIsOrbitPinned) {
            attachmentOnlyAccel.ax += fx;
            attachmentOnlyAccel.ay += fy;
          }
        }
      }
    }

    const orphanToMainRepelStrength = repelStrength * orphanToMainRepelScale;
    if (
      orphanToMainRepelStrength > 0 &&
      freeOrphanNodes.length > 0 &&
      mainNodesForOrphanRepel.length > 0
    ) {
      for (const orphanNode of freeOrphanNodes) {
        for (const mainNode of mainNodesForOrphanRepel) {
          const dx = mainNode.x - orphanNode.x;
          const dy = mainNode.y - orphanNode.y;
          const distSq = dx * dx + dy * dy;
          if (distSq > orphanToMainRepelRadiusSq) continue;
          const dist = Math.sqrt(distSq) || 0.0001;
          const safeDist = Math.max(minRepelDistance, dist);
          const force = Math.min(maxRepelForce, orphanToMainRepelStrength / (safeDist * safeDist));
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;

          const orphanAccel = accelById.get(orphanNode.id);
          const regularAccel = accelById.get(mainNode.id);
          const mainIsOrbitPinned = orbitNodeIds.has(mainNode.id);
          orphanAccel.ax -= fx;
          orphanAccel.ay -= fy;
          if (!mainIsOrbitPinned) {
            regularAccel.ax += fx * regularBackReactionScale;
            regularAccel.ay += fy * regularBackReactionScale;
          }
        }
      }
    }

    const attachmentOnlyToMainRepelStrength = repelStrength * attachmentOnlyToMainRepelScale;
    if (
      attachmentOnlyToMainRepelStrength > 0 &&
      attachmentOnlyAnchorNodes.length > 0 &&
      mainNodesForOrphanRepel.length > 0
    ) {
      for (const attachmentOnlyNode of attachmentOnlyAnchorNodes) {
        const attachmentOnlyIsOrbitPinned = orbitNodeIds.has(attachmentOnlyNode.id);
        for (const mainNode of mainNodesForOrphanRepel) {
          const dx = mainNode.x - attachmentOnlyNode.x;
          const dy = mainNode.y - attachmentOnlyNode.y;
          const distSq = dx * dx + dy * dy;
          if (distSq > orphanToMainRepelRadiusSq) continue;
          const dist = Math.sqrt(distSq) || 0.0001;
          const safeDist = Math.max(minRepelDistance, dist);
          const force = Math.min(
            maxRepelForce,
            attachmentOnlyToMainRepelStrength / (safeDist * safeDist)
          );
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;

          const attachmentOnlyAccel = accelById.get(attachmentOnlyNode.id);
          const regularAccel = accelById.get(mainNode.id);
          const mainIsOrbitPinned = orbitNodeIds.has(mainNode.id);
          if (!attachmentOnlyIsOrbitPinned) {
            attachmentOnlyAccel.ax -= fx;
            attachmentOnlyAccel.ay -= fy;
          }
          if (!mainIsOrbitPinned) {
            regularAccel.ax += fx * attachmentOnlyBackReactionScale;
            regularAccel.ay += fy * attachmentOnlyBackReactionScale;
          }
        }
      }
    }
  }

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
      const sourceIsOrbitPinned = orbitNodeIds.has(sourceNode.id);
      const targetIsOrbitPinned = orbitNodeIds.has(targetNode.id);
      // Orbit-pinned nodes must remain fixed in place, but their links should still
      // attract/free connected nodes. Only skip fully fixed orbit-to-orbit edges.
      if (sourceIsOrbitPinned && targetIsOrbitPinned) continue;
      if (
        autoAttachmentOrbitNodeIds.has(sourceNode.id) ||
        autoAttachmentOrbitNodeIds.has(targetNode.id)
      )
        continue;

      const dx = targetNode.x - sourceNode.x;
      const dy = targetNode.y - sourceNode.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;

      const sourceMultiplier = view.plugin.getNodeMultiplier(sourceNode.id);
      const targetMultiplier = view.plugin.getNodeMultiplier(targetNode.id);
      const edgeMultiplier = Math.max(sourceMultiplier, targetMultiplier);
      const hasAttachmentInEdge = !!(
        sourceNode.meta?.isAttachment || targetNode.meta?.isAttachment
      );
      const edgeTargetDistance = hasAttachmentInEdge ? attachmentLinkDistance : linkDistance;
      const stretch = dist - edgeTargetDistance;
      // Temporary test mode: disable degree-based normalization for link force.
      const springForceRaw = baseLinkStrength * edgeMultiplier * stretch;
      const springForce = Math.max(-maxSpringForce, Math.min(maxSpringForce, springForceRaw));
      const fx = (dx / dist) * springForce;
      const fy = (dy / dist) * springForce;
      const sourceMass = 1 + Math.max(0, getNodeDegree(sourceNode) - 1) * degreeMassFactor;
      const targetMass = 1 + Math.max(0, getNodeDegree(targetNode) - 1) * degreeMassFactor;

      const sourceAccel = accelById.get(sourceNode.id);
      const targetAccel = accelById.get(targetNode.id);
      if (!sourceIsOrbitPinned) {
        sourceAccel.ax += fx / sourceMass;
        sourceAccel.ay += fy / sourceMass;
      }
      if (!targetIsOrbitPinned) {
        targetAccel.ax -= fx / targetMass;
        targetAccel.ay -= fy / targetMass;
      }
    }
  }

  for (const node of nodes) {
    const pin = view.plugin.getPin(node.id);
    const orbitPin = orbitPinsById.get(node.id) || null;
    const autoAttachmentOrbit = autoAttachmentOrbitById.get(node.id) || null;
    const accel = accelById.get(node.id) || { ax: 0, ay: 0 };

    if (hasCenter && !pin && !orbitPin && !autoAttachmentOrbit && node.id !== view.dragNodeId) {
      const nodeCenterScale = getNodeDegree(node) === 0 ? orphanCenterScale : 1;
      const centerFx = (0 - node.x) * centerStrength * nodeCenterScale;
      const centerFy = (0 - node.y) * centerStrength * nodeCenterScale;
      accel.ax += Math.max(-maxCenterForce, Math.min(maxCenterForce, centerFx));
      accel.ay += Math.max(-maxCenterForce, Math.min(maxCenterForce, centerFy));
    }

    if (node.id === view.dragNodeId) {
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

    if (autoAttachmentOrbit) {
      const anchorNode = view.nodeById.get(autoAttachmentOrbit.anchor_id);
      if (anchorNode) {
        node.x = anchorNode.x + Math.cos(autoAttachmentOrbit.angle) * autoAttachmentOrbit.radius;
        node.y = anchorNode.y + Math.sin(autoAttachmentOrbit.angle) * autoAttachmentOrbit.radius;
      }
      node.vx = 0;
      node.vy = 0;
      continue;
    }

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
    node.vx *= settleVelocityBrake;
    node.vy *= settleVelocityBrake;

    const accelMag = Math.sqrt(accel.ax * accel.ax + accel.ay * accel.ay);
    const speedNow = Math.sqrt(node.vx * node.vx + node.vy * node.vy);
    if (speedNow > maxSpeed) {
      const ratio = maxSpeed / speedNow;
      node.vx *= ratio;
      node.vy *= ratio;
    }
    if (speedNow < settleVelocityEps && accelMag < settleAccelEps) {
      node.vx = 0;
      node.vy = 0;
    } else {
      movingNodeCount += 1;
    }

    node.x += node.vx;
    node.y += node.vy;
  }

  const autosaveAllowed = settings.layout_autosave && !view.isSearchFilled();
  if (autosaveAllowed) {
    if (movingNodeCount > 0) {
      view.layoutStillFrames = 0;
      view.layoutAutosaveDirty = true;
      view.layoutPaused = false;
    } else {
      view.layoutStillFrames += 1;
    }

    if (view.layoutAutosaveDirty && view.layoutStillFrames >= 8) {
      view.saveCurrentLayout({ silent: true });
      view.layoutAutosaveDirty = false;
    }
  } else {
    view.layoutStillFrames = 0;
    if (view.isSearchFilled()) view.layoutAutosaveDirty = false;
  }

  if (!view.dragNodeId && elapsedSearchMs >= layoutSearchMs) {
    view.layoutPaused = true;
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

// Build virtual orbit constraints for free attachment nodes around their nearest anchor nodes.
function buildAttachmentAutoOrbitMap(view, activeNodeIds = null) {
  const autoOrbitMap = new Map();
  const settings = view.plugin.getSettings();
  const attachmentLinkDistance = view.plugin.clampNumber(
    settings.attachment_link_distance_multiplier,
    1,
    100,
    DEFAULT_DATA.settings.attachment_link_distance_multiplier
  );

  const attachmentNodeIdsByAnchor = new Map();
  for (const node of view.nodes) {
    if (activeNodeIds && !activeNodeIds.has(node.id)) continue;
    if (!node?.meta?.isAttachment) continue;
    if (view.plugin.isPinned(node.id) || view.plugin.isOrbitPinned(node.id)) continue;

    const neighborIds = view.neighborsById.get(node.id);
    if (!neighborIds || neighborIds.size === 0) continue;

    let anchorId = null;
    for (const candidateId of neighborIds) {
      if (activeNodeIds && !activeNodeIds.has(candidateId)) continue;
      const candidateNode = view.nodeById.get(candidateId);
      if (!candidateNode) continue;
      if (!candidateNode.meta?.isAttachment) {
        anchorId = candidateNode.id;
        break;
      }
    }
    if (!anchorId) {
      for (const candidateId of neighborIds) {
        if (activeNodeIds && !activeNodeIds.has(candidateId)) continue;
        if (view.nodeById.has(candidateId)) {
          anchorId = candidateId;
          break;
        }
      }
    }
    if (!anchorId || !view.nodeById.has(anchorId)) continue;

    if (!attachmentNodeIdsByAnchor.has(anchorId)) attachmentNodeIdsByAnchor.set(anchorId, []);
    attachmentNodeIdsByAnchor.get(anchorId).push(node.id);
  }

  for (const [anchorId, attachmentNodeIds] of attachmentNodeIdsByAnchor.entries()) {
    const sortedAttachmentNodeIds = attachmentNodeIds
      .slice()
      .sort((leftId, rightId) => leftId.localeCompare(rightId));
    const attachmentCount = Math.max(1, sortedAttachmentNodeIds.length);
    const attachmentOrbitRadius = getOrbitRadiusBySpacing(
      view.plugin,
      attachmentCount,
      attachmentLinkDistance
    );

    for (let index = 0; index < sortedAttachmentNodeIds.length; index++) {
      const nodeId = sortedAttachmentNodeIds[index];
      const angle = (Math.PI * 2 * index) / sortedAttachmentNodeIds.length;
      autoOrbitMap.set(nodeId, {
        anchor_id: anchorId,
        radius: attachmentOrbitRadius,
        angle,
      });
    }
  }

  return autoOrbitMap;
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
  kickLayoutSearch,
  updateLayoutCenter,
  stepCameraSmoothing,
  stepSimulation,
  getOrbitRadiusBySpacing,
  getOrbitRadiusForAnchor,
  buildAttachmentAutoOrbitMap,
  recomputeOrbitRadii,
};
