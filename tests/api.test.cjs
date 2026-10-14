const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, loadSource } = require('./helpers/obsidian.cjs');
const { GraphFrontierApi } = loadSource('api.js');

function setup(t) {
  const f = fixture(t);
  f.view.nodes = [
    { id: 'a.md', label: 'A', x: 10, y: 20, meta: { content: 'private content' } },
    { id: 'b.png', label: 'B', x: 200, y: 300, meta: { isAttachment: true } },
    { id: 'gravity', label: 'Gravity', x: 100, y: 200, meta: { darkEnergy: {} } },
  ];
  f.view.nodeById = new Map(f.view.nodes.map((node) => [node.id, node]));
  f.view.edges = [{ source: 'a.md', target: 'b.png', sourceNode: f.view.nodes[0] }];
  f.view.viewWidth = 1000;
  f.view.viewHeight = 800;
  f.view.getFilterVisibleNodeIds = () => null;
  const api = new GraphFrontierApi(f.plugin);
  const ref = api.listViews().views[0];
  return { ...f, api, ref };
}

test('API exports copies, bounded pages and no file content or live metadata', (t) => {
  const { api, ref, view } = setup(t);
  const result = api.getGraph({ ...ref, limit: 2 });
  assert.equal(result.items.length, 2);
  assert.equal(result.nextOffset, 2);
  assert.equal(result.items[1].type, 'attachment');
  assert.equal(JSON.stringify(result).includes('private content'), false);
  result.items[0].x = 999;
  result.camera.zoom = 99;
  assert.equal(view.nodes[0].x, 10);
  assert.notEqual(view.camera.zoom, 99);
  assert.equal(api.getGraph({ ...ref, offset: 2 }).items[0].type, 'gravity');
  assert.deepEqual(api.getGraph({ ...ref, kind: 'edges' }).items, [
    { source: 'a.md', target: 'b.png', visible: true },
  ]);
});

test('visibility is honored; explicit include-hidden metadata is possible, selection is rejected', (t) => {
  const { api, ref, view } = setup(t);
  view.getFilterVisibleNodeIds = () => new Set(['a.md']);
  assert.equal(api.getGraph(ref).items.length, 1);
  assert.equal(api.getGraph({ ...ref, kind: 'edges' }).items.length, 0);
  assert.equal(api.getGraph({ ...ref, visibleOnly: false }).items.length, 3);
  assert.throws(() => api.selectNodes({ ...ref, nodeIds: ['a.md', 'b.png'] }), {
    code: 'NODE_NOT_VISIBLE',
  });
  assert.equal(view.selectedNodeIds.size, 0);
});

test('selection is atomic, separate from search focus, and does not persist', (t) => {
  const { api, ref, view, writes, preferences } = setup(t);
  view.searchSelectedNodeId = 'b.png';
  view.focusNodeId = 'gravity';
  api.selectNodes({ ...ref, nodeIds: ['a.md', 'a.md', 'b.png'] });
  assert.deepEqual([...view.selectedNodeIds], ['a.md', 'b.png']);
  assert.throws(() => api.selectNodes({ ...ref, nodeIds: ['a.md', 'missing'] }), {
    code: 'NODE_NOT_FOUND',
  });
  assert.deepEqual([...view.selectedNodeIds], ['a.md', 'b.png']);
  const result = api.getSelection({ ...ref, limit: 1 });
  assert.equal(result.searchSelectedNodeId, 'b.png');
  assert.equal(result.focusNodeId, 'gravity');
  assert.equal(result.nextOffset, 1);
  api.selectNodes({ ...ref, nodeIds: [] });
  assert.equal(view.selectedNodeIds.size, 0);
  assert.deepEqual(writes, []);
  assert.deepEqual(preferences, []);
});

test('frames only specified nodes using existing camera routine, without moving or saving nodes', (t) => {
  const { api, ref, view, writes, preferences } = setup(t);
  const before = structuredClone(view.nodes);
  api.frameNodes({ ...ref, nodeIds: ['a.md'] });
  assert.equal(view.camera.x, 10);
  assert.equal(view.camera.y, 20);
  assert.deepEqual(view.nodes, before);
  assert.deepEqual(writes, []);
  assert.deepEqual(preferences, []);
});

test('rejects stale context for a layout reload or graph rebuild, including same layout name', (t) => {
  const { api, ref, view, plugin } = setup(t);
  plugin.data = plugin.normalizeData(plugin.data);
  assert.throws(() => api.selectNodes({ ...ref, nodeIds: ['a.md'] }), { code: 'STATE_CHANGED' });
  const newer = api.getState({ viewId: ref.viewId });
  view.visibilityGraphVersion++;
  assert.throws(() => api.getGraph(newer), { code: 'STATE_CHANGED' });
});

test('closed views are not reopened; unloaded API rejects all calls', (t) => {
  const { api, ref, view } = setup(t);
  view.isOpen = false;
  assert.equal(api.listViews().views.length, 0);
  assert.throws(() => api.getState(ref), { code: 'VIEW_NOT_FOUND' });
  api.close();
  assert.throws(() => api.listViews(), { code: 'API_CLOSED' });
});

test('validation applies to direct API calls as well as MCP', (t) => {
  const { api, ref } = setup(t);
  for (const args of [
    { limit: 501 },
    { offset: -1 },
    { limit: 1.5 },
    { kind: 'files' },
    { visibleOnly: 'false' },
  ]) {
    assert.throws(() => api.getGraph({ ...ref, ...args }), { code: 'INVALID_ARGUMENT' });
  }
  assert.throws(() => api.frameNodes({ ...ref, nodeIds: [] }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => api.selectNodes({ viewId: ref.viewId, nodeIds: [] }), {
    code: 'INVALID_ARGUMENT',
  });
});

test('filtered graph pages bound scanned nodes as well as returned nodes', (t) => {
  const { api, ref, view } = setup(t);
  view.nodes = Array.from({ length: 10001 }, (_, n) => ({ id: String(n), x: 0, y: 0 }));
  view.getFilterVisibleNodeIds = () => new Set(['10000']);
  const first = api.getGraph(ref);
  assert.equal(first.items.length, 0);
  assert.equal(first.nextOffset, 10000);
  assert.equal(api.getGraph({ ...ref, offset: first.nextOffset }).items[0].id, '10000');
});
