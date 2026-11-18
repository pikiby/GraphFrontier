const { beginPositionAction, finishPositionAction } = require('./position-history');

// Graph effects change what happens on the graph. Each run is one undo step: the Undo button
// or Ctrl+Z returns every node to where it was before the effect started.

// Grow replays the graph being built: nodes are born in the order their notes were created
// and physics arranges them as they appear. Pinned, orbiting and gravity nodes keep their
// places; every other node starts its life again next to an already born neighbor. Nodes without a creation
// time (gravity nodes, subgraphs, missing files) are born first.
function startGrow(view) {
  if (view.growEffect) return;
  const seconds = view.plugin.clampNumber(view.plugin.getSettings().grow_duration, 1, 60, 8);
  const durationMs = seconds * 1000;
  const created = (node) => view.app.vault.getAbstractFileByPath(node.id)?.stat?.ctime ?? -Infinity;
  const order = [...view.nodes].sort((a, b) => created(a) - created(b));
  const step = order.length > 1 ? durationMs / (order.length - 1) : 0;
  view.growEffect = {
    startMs: Date.now(),
    durationMs,
    revealAtMs: new Map(order.map((node, index) => [node.id, index * step])),
    born: new Set(),
    revision: 0,
    visible: null,
    history: beginPositionAction(
      view,
      view.nodes.map((node) => node.id),
      true
    ),
  };
  stepGrow(view);
}

function isGrowActive(view) {
  return !!view.growEffect;
}

// A newborn node appears next to a born neighbor, or at the layout center if it has none yet.
function placeNewborn(view, node, born) {
  const neighbor = [...(view.neighborsById?.get(node.id) || [])]
    .map((id) => view.nodeById.get(id))
    .find((other) => other && born.has(other.id));
  const center = neighbor || view.layoutCenter || { x: 0, y: 0 };
  const angle = Math.random() * Math.PI * 2;
  node.x = center.x + Math.cos(angle) * 12;
  node.y = center.y + Math.sin(angle) * 12;
  node.vx = 0;
  node.vy = 0;
}

// Called every frame before physics: gives birth to the nodes whose time has come.
function stepGrow(view, nowMs = Date.now()) {
  const grow = view.growEffect;
  if (!grow) return;
  const elapsed = nowMs - grow.startMs;
  let born = false;
  for (const node of view.nodes) {
    if (grow.born.has(node.id)) continue;
    const at = grow.revealAtMs.get(node.id);
    if (at !== undefined && at > elapsed) continue;
    // Gravity nodes stand outside physics, so like pinned nodes they keep their place.
    const keepsPlace =
      node.meta?.darkEnergy ||
      view.plugin.isPinned(node.id) ||
      !!view.plugin.getOrbitPin?.(node.id);
    if (!keepsPlace) placeNewborn(view, node, grow.born);
    grow.born.add(node.id);
    born = true;
  }
  if (born) {
    grow.revision += 1;
    view.markNodeSpatialIndexDirty?.();
    view.kickLayoutSearch();
  }
  if (elapsed < grow.durationMs) return;
  view.growEffect = null;
  finishPositionAction(view, grow.history);
  view.kickLayoutSearch();
}

// Nodes not born yet are outside drawing and physics, like filtered nodes.
function growVisibleNodeIds(view, visible) {
  const grow = view.growEffect;
  if (!grow) return visible;
  if (grow.visible?.revision !== grow.revision || grow.visible.source !== visible)
    grow.visible = {
      revision: grow.revision,
      source: visible,
      ids: new Set(
        visible instanceof Set ? [...visible].filter((id) => grow.born.has(id)) : [...grow.born]
      ),
    };
  return grow.visible.ids;
}

// Wave spreads from one node: a light runs along each link to the next node, and every node it
// reaches sends out a ring, step by step up to the configured depth. It only draws over the
// graph: nodes and layout stay as they are.
// Wave speed 1–10 sets how long one link step takes; a ring fades over two steps.
const waveStepMs = (view) =>
  1400 / view.plugin.clampNumber(view.plugin.getSettings().wave_speed, 1, 10, 4);

function startWave(view, sourceIds) {
  const depth = view.plugin.clampNumber(view.plugin.getSettings().wave_depth, 1, 10, 3);
  const visible = view.getFilterVisibleNodeIds();
  const shown = (id) => view.nodeById.has(id) && (!(visible instanceof Set) || visible.has(id));
  let frontier = [...new Set(sourceIds)].filter(shown);
  if (!frontier.length) return false;
  const level = new Map(frontier.map((id) => [id, 0]));
  const links = [];
  for (let step = 1; step <= depth && frontier.length; step++) {
    const next = [];
    for (const id of frontier)
      for (const other of view.neighborsById?.get(id) || []) {
        if (!shown(other)) continue;
        if (!level.has(other)) {
          level.set(other, step);
          next.push(other);
        }
        if (level.get(other) === step) links.push({ from: id, to: other, step });
      }
    frontier = next;
  }
  const stepMs = waveStepMs(view);
  view.waveEffect = {
    startMs: Date.now(),
    stepMs,
    durationMs: (depth + 2) * stepMs,
    links,
    rings: [...level].map(([id, step]) => ({ id, step })),
  };
  view.requestFrame();
  return true;
}

function isWaveActive(view, nowMs = Date.now()) {
  if (!view.waveEffect) return false;
  if (nowMs - view.waveEffect.startMs < view.waveEffect.durationMs) return true;
  view.waveEffect = null;
  return false;
}

// Where the light is on a link (0..1), or null before it starts and after it arrives.
function waveLinkState(view, link, nowMs) {
  const { startMs, stepMs } = view.waveEffect;
  const elapsed = nowMs - startMs - (link.step - 1) * stepMs;
  if (elapsed <= 0 || elapsed >= stepMs) return null;
  return { progress: elapsed / stepMs };
}

// A node's ring once the light reaches it: how far it has spread (0..1) and its brightness.
function waveRingState(view, ring, nowMs) {
  const { startMs, stepMs } = view.waveEffect;
  const elapsed = nowMs - startMs - ring.step * stepMs;
  if (elapsed < 0 || elapsed >= 2 * stepMs) return null;
  const spread = elapsed / (2 * stepMs);
  return { spread, alpha: 1 - spread };
}

// Pulse: while on, a tap or click on empty space sends out a shockwave from that point. Its
// front pushes the nodes it passes outwards (or pulls them inwards), and physics settles them
// again. Pinned, orbiting and gravity nodes stay put. One session, from on to off, is one undo
// step.
function togglePulse(view) {
  if (view.pulseEffect) {
    finishPositionAction(view, view.pulseEffect.history);
    view.pulseEffect = null;
    return false;
  }
  view.pulseEffect = {
    history: beginPositionAction(
      view,
      view.nodes.map((node) => node.id),
      true
    ),
    waves: [],
  };
  return true;
}

// Shape of every wave sent now: how far it travels, how wide and soft its front is, how long it
// lasts, its push and its direction. Radius and width are in screen pixels, turned into world
// units at the moment of the tap.
function pulseSettings(view) {
  const settings = view.plugin.getSettings();
  const softness = view.plugin.clampNumber(settings.pulse_softness, 1, 10, 5);
  const zoom = Math.max(view.camera.zoom, 0.0001);
  return {
    radius: view.plugin.clampNumber(settings.pulse_radius, 100, 1000, 400) / zoom,
    width: (10 + softness * 8) / zoom,
    durationMs: 500 + softness * 80,
    strength: view.plugin.clampNumber(settings.pulse_strength, 1, 10, 5) * 0.4,
    direction: settings.pulse_inward ? -1 : 1,
  };
}

function firePulse(view, screenX, screenY) {
  if (!view.pulseEffect) return;
  view.pulseEffect.waves.push({
    ...view.screenToWorld(screenX, screenY),
    ...pulseSettings(view),
    startMs: Date.now(),
  });
  view.layoutPaused = false;
  view.requestFrame();
}

// Waves still travelling; finished ones are dropped.
function activePulseWaves(view, nowMs = Date.now()) {
  if (!view.pulseEffect) return [];
  view.pulseEffect.waves = view.pulseEffect.waves.filter(
    (wave) => nowMs - wave.startMs < wave.durationMs
  );
  return view.pulseEffect.waves;
}

// Where a wave's front is (world radius) and how strong it still is (0..1, fading as it spreads).
function pulseFront(wave, nowMs) {
  const progress = Math.min(1, Math.max(0, (nowMs - wave.startMs) / wave.durationMs));
  return { radius: wave.radius * progress, fade: 1 - progress };
}

// Push on one node from all travelling fronts: a soft bump around each front line.
function pulseForce(view, node, nowMs = Date.now()) {
  let ax = 0;
  let ay = 0;
  for (const wave of activePulseWaves(view, nowMs)) {
    const dx = node.x - wave.x;
    const dy = node.y - wave.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 0.001 || distance > wave.radius) continue;
    const front = pulseFront(wave, nowMs);
    const offset = (distance - front.radius) / wave.width;
    const push = wave.strength * wave.direction * front.fade * Math.exp(-offset * offset);
    ax += (dx / distance) * push;
    ay += (dy / distance) * push;
  }
  return ax || ay ? [ax, ay] : null;
}

module.exports = {
  togglePulse,
  firePulse,
  activePulseWaves,
  pulseFront,
  pulseForce,
  startGrow,
  stepGrow,
  isGrowActive,
  growVisibleNodeIds,
  startWave,
  isWaveActive,
  waveLinkState,
  waveRingState,
};
