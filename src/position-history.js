const { GRAPHFRONTIER_VIEW_TYPE } = require('./constants');
const histories = new WeakMap();
const clone = (value) => (value == null ? null : JSON.parse(JSON.stringify(value)));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const scope = (view) => view.subgraphScope?.id || '';

function historyFor(view) {
  const data = view.plugin.data;
  if (!histories.has(data)) histories.set(data, new Map());
  const scopes = histories.get(data);
  if (!scopes.has(scope(view))) scopes.set(scope(view), { undo: [], redo: [], active: null });
  return scopes.get(scope(view));
}

function invalidatePositionHistory(data) {
  const scopes = histories.get(data);
  if (scopes)
    for (const history of scopes.values()) {
      history.undo.length = 0;
      history.redo.length = 0;
      history.active = null;
    }
}

function readState(view, id) {
  const node = view.nodeById.get(id);
  if (!node) return null;
  return {
    x: node.x,
    y: node.y,
    pin: clone(view.plugin.data.pins[id]),
    orbit: clone(view.plugin.data.orbit_pins[id]),
  };
}

function beginPositionAction(view, ids, move = false) {
  const history = historyFor(view);
  if (history.active) return null;
  const token = {
    data: view.plugin.data,
    scope: scope(view),
    history,
    move,
    structure: JSON.stringify(view.plugin.data.subgraphs || []),
    before: new Map(
      [...new Set(ids)].map((id) => [id, readState(view, id)]).filter(([, state]) => state)
    ),
  };
  history.active = token;
  return token;
}

function finishPositionAction(view, token, cancel = false) {
  if (!token || token.history.active !== token) return;
  token.history.active = null;
  if (cancel || token.data !== view.plugin.data || token.scope !== scope(view)) return;
  const changes = [];
  for (const [id, before] of token.before) {
    const after = readState(view, id);
    if (!after) continue;
    const pinsChanged = !equal(before.pin, after.pin) || !equal(before.orbit, after.orbit);
    if (pinsChanged || (token.move && (before.x !== after.x || before.y !== after.y)))
      changes.push({ id, before, after });
  }
  if (!changes.length) return;
  token.history.undo.push({ changes, structure: token.structure });
  if (token.history.undo.length > 100) token.history.undo.shift();
  token.history.redo.length = 0;
}

function runPositionAction(view, ids, action, move = false) {
  const token = beginPositionAction(view, ids, move);
  try {
    const result = action();
    if (result?.then) return result.finally(() => finishPositionAction(view, token));
    finishPositionAction(view, token);
    return result;
  } catch (error) {
    finishPositionAction(view, token);
    throw error;
  }
}

function replayPositionAction(view, redo = false) {
  const history = historyFor(view);
  if (history.active || view.dragNodeId) return 'busy';
  const from = redo ? history.redo : history.undo;
  const to = redo ? history.undo : history.redo;
  const entry = from.at(-1);
  if (!entry) return 'empty';
  // Physics owns live coordinates; only user-owned pin state is compared.
  if (
    entry.structure !== JSON.stringify(view.plugin.data.subgraphs || []) ||
    entry.changes.some(({ id, before, after }) => {
      const current = readState(view, id);
      const expected = redo ? before : after;
      return !current || !equal(current.pin, expected.pin) || !equal(current.orbit, expected.orbit);
    })
  ) {
    invalidatePositionHistory(view.plugin.data);
    return 'conflict';
  }
  const views = view.plugin.isLocalGraphFrontier
    ? [view]
    : view.app.workspace
        .getLeavesOfType(GRAPHFRONTIER_VIEW_TYPE)
        .map((leaf) => leaf.view)
        .filter((other) => other?.plugin.data === view.plugin.data && scope(other) === scope(view));
  if (!views.includes(view)) views.push(view);
  for (const { id, before, after } of entry.changes) {
    const target = redo ? after : before;
    for (const [key, value] of [
      ['pins', target.pin],
      ['orbit_pins', target.orbit],
    ]) {
      if (value === null) delete view.plugin.data[key][id];
      else view.plugin.data[key][id] = clone(value);
    }
    view.plugin.data.saved_positions[id] = { x: target.x, y: target.y };
    for (const other of views) {
      const node = other.nodeById.get(id);
      if (node) Object.assign(node, { x: target.x, y: target.y, vx: 0, vy: 0 });
    }
  }
  from.pop();
  to.push(entry);
  for (const other of views) {
    other.layoutEditVersion = (other.layoutEditVersion || 0) + 1;
    other.layoutAutosaveDirty = true;
    other.markNodeSpatialIndexDirty();
    other.kickLayoutSearch();
    other.render();
  }
  view.plugin.schedulePersist();
  return 'applied';
}

module.exports = {
  historyFor,
  beginPositionAction,
  finishPositionAction,
  runPositionAction,
  replayPositionAction,
  invalidatePositionHistory,
};
