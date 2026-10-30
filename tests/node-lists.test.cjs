const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, loadSource } = require('./helpers/obsidian.cjs');
const { NodeListStore } = require('../src/node-lists');
const { GraphFrontierApi } = loadSource('api.js');
const { getNodeVisualSetting, getNodeColor, getEdgeVisualSetting } = loadSource('node-visuals.js');
const render = loadSource('render.js');
const { LocalGraphFrontierView } = loadSource('local-view.js');

function setup(t) {
  const f = fixture(t);
  f.app.vault.getName = () => 'Test';
  f.adapter.rename = async (from, to) => {
    if (f.files.has(to)) throw new Error('Destination file already exists!');
    f.files.set(to, f.files.get(from));
    f.files.delete(from);
  };
  f.plugin.nodeListStore = new NodeListStore(f.adapter, 'node-lists.json', () =>
    f.plugin.nodeListsChanged()
  );
  f.view.nodes = ['alpha.md', 'beta.md'].map((id) => ({
    id,
    label: id,
    x: 1,
    y: 2,
    meta: { path: id, fileName: id, tags: ['DAG'] },
  }));
  f.view.nodeById = new Map(f.view.nodes.map((n) => [n.id, n]));
  f.view.nodeMetaById = new Map(f.view.nodes.map((n) => [n.id, n.meta]));
  f.api = new GraphFrontierApi(f.plugin);
  return f;
}

test('list membership is atomic, idempotent and retains unresolved paths', async (t) => {
  const { plugin, files, view } = setup(t);
  const nodes = structuredClone(view.nodes);
  view.kickLayoutSearch = () => assert.fail('No physics wake');
  await plugin.updateNodeList({
    action: 'create',
    listId: 'errors',
    name: 'Errors',
    nodeIds: ['alpha.md'],
  });
  await Promise.all([
    plugin.updateNodeList({ action: 'add', listId: 'errors', nodeIds: ['alpha.md', 'future.md'] }),
    plugin.updateNodeList({ action: 'add', listId: 'errors', nodeIds: ['beta.md'] }),
  ]);
  assert.deepEqual(plugin.getNodeLists()[0].nodeIds, ['alpha.md', 'future.md', 'beta.md']);
  await assert.rejects(
    plugin.updateNodeList({
      action: 'replace',
      listId: 'errors',
      nodeIds: ['safe.md', '../bad.md'],
    })
  );
  assert.equal(plugin.getNodeLists()[0].nodeIds.length, 3);
  await plugin.updateNodeList({
    action: 'remove',
    listId: 'errors',
    nodeIds: ['absent.md', 'beta.md'],
  });
  assert.deepEqual(plugin.getNodeLists()[0].nodeIds, ['alpha.md', 'future.md']);
  assert.equal(JSON.parse(files.get('node-lists.json')).lists[0].id, 'errors');
  assert.deepEqual(view.nodes, nodes);
});

test('list storage survives reload and layout replacement without becoming layout data', async (t) => {
  const { plugin, adapter } = setup(t);
  await plugin.updateNodeList({
    action: 'create',
    listId: 'errors',
    name: 'Errors',
    nodeIds: ['alpha.md'],
  });
  plugin.data = plugin.normalizeData({ groups: [] });
  assert.equal(plugin.getNodeLists()[0].nodeIds[0], 'alpha.md');
  assert.equal(plugin.data.node_lists, undefined);
  const store = new NodeListStore(adapter, 'node-lists.json', () => {});
  await store.load();
  assert.deepEqual(store.lists, plugin.getNodeLists());
});

test('failed list writes and malformed storage preserve state and prevent overwriting', async (t) => {
  const { plugin, files, adapter } = setup(t);
  await plugin.updateNodeList({ action: 'create', listId: 'errors', name: 'Errors' });
  const previous = structuredClone(plugin.getNodeLists());
  adapter.write = async () => {
    throw new Error('Disk failure');
  };
  await assert.rejects(
    plugin.updateNodeList({ action: 'replace', listId: 'errors', nodeIds: ['a.md'] }),
    /Disk failure/
  );
  assert.deepEqual(plugin.getNodeLists(), previous);
  files.set('broken.json', '{broken');
  const broken = new NodeListStore(adapter, 'broken.json', () => {});
  await assert.rejects(broken.load());
  await assert.rejects(broken.update({ action: 'create', name: 'Do not overwrite' }));
  assert.equal(files.get('broken.json'), '{broken');
});

test('rename updates exact files and folder descendants, not similar paths', async (t) => {
  const { plugin } = setup(t);
  await plugin.updateNodeList({
    action: 'create',
    listId: 'errors',
    name: 'Errors',
    nodeIds: ['dir/a.md', 'dir/b.md', 'directory/c.md'],
  });
  await plugin.nodeListStore.renamePath('dir', 'new');
  assert.deepEqual(plugin.getNodeLists()[0].nodeIds, ['new/a.md', 'new/b.md', 'directory/c.md']);
});

test('group visuals inherit per field with individual overrides first and no materialized node settings', async (t) => {
  const { plugin, view } = setup(t);
  await plugin.updateNodeList({
    action: 'create',
    listId: 'errors',
    name: 'Errors',
    nodeIds: ['alpha.md'],
  });
  plugin.updateGroups([
    {
      id: 'top',
      query: 'list:errors',
      color: '#ff0000',
      settings: { aura_radius: 540, label_font_size: 18 },
    },
    {
      id: 'lower',
      query: 'tag:DAG',
      color: '#00ff00',
      settings: { aura_radius: 100, node_size_scale: 2, edge_width_scale: 0.4 },
    },
  ]);
  assert.equal(getNodeVisualSetting(plugin, 'alpha.md', 'aura_radius'), 540);
  assert.equal(getNodeVisualSetting(plugin, 'alpha.md', 'node_size_scale'), 2);
  assert.equal(getNodeVisualSetting(plugin, 'beta.md', 'aura_radius'), 100);
  assert.equal(render.getLabelFontSize(view, 'alpha.md'), 18 / 5);
  assert.equal(getEdgeVisualSetting(plugin, 'alpha.md', 'beta.md', 'edge_width_scale'), 0.4);
  assert.deepEqual(plugin.data.node_visual_settings, {});
  plugin.setNodeVisualSetting('alpha.md', 'aura_radius', 80);
  assert.equal(getNodeVisualSetting(plugin, 'alpha.md', 'aura_radius'), 80);
  plugin.setNodeVisualSetting('alpha.md', 'aura_radius', null);
  await plugin.updateNodeList({ action: 'replace', listId: 'errors', nodeIds: [] });
  assert.equal(getNodeVisualSetting(plugin, 'alpha.md', 'aura_radius'), 100);
  assert.equal(
    getNodeColor(plugin, view.nodes[0], view.getGroupColorForNode(view.nodes[0])),
    '#00ff00'
  );
  plugin.updateGroups([]);
  assert.equal(
    getNodeVisualSetting(plugin, 'alpha.md', 'aura_radius'),
    plugin.getSettings().aura_radius
  );
});

test('list matching works in shared query matcher and search API without changing membership', async (t) => {
  const { plugin, view, api } = setup(t);
  await plugin.updateNodeList({
    action: 'create',
    listId: 'errors',
    name: 'Human title',
    nodeIds: ['alpha.md'],
  });
  const parsed = plugin.parseGroupQuery('list:errors');
  assert.equal(plugin.composeGroupQuery('list', 'errors'), 'list:errors');
  assert.equal(view.nodeMatchesParsedGroup(view.nodes[0].meta, parsed, view.nodes[0]), true);
  assert.equal(view.nodeMatchesParsedGroup(view.nodes[1].meta, parsed, view.nodes[1]), false);
  const state = api.listViews().views[0];
  assert.deepEqual(
    api.searchNodes({ viewId: state.viewId, query: 'list:errors', visibleOnly: false }).nodeIds,
    ['alpha.md']
  );
  assert.deepEqual(plugin.getGroupValueSuggestions('list', 'Human'), ['errors']);
});

test('MCP list operations work without an open graph and validate inputs before mutation', async (t) => {
  const { plugin, api, app } = setup(t);
  app.workspace.getLeavesOfType = () => [];
  await api.nodeLists({ action: 'create', listId: 'errors', name: 'Errors' });
  await api.nodeLists({ action: 'replace', listId: 'errors', nodeIds: ['missing.md'] });
  assert.equal(api.listNodeLists({}).lists[0].nodeIds[0], 'missing.md');
  await assert.rejects(
    api.nodeLists({ action: 'replace', listId: 'errors', nodeIds: ['/etc/passwd'] })
  );
  assert.deepEqual(plugin.getNodeLists()[0].nodeIds, ['missing.md']);
  await api.nodeLists({ action: 'delete', listId: 'errors' });
  assert.deepEqual(plugin.getNodeLists(), []);
});

test('group settings normalize and persist without changing old color-only groups', (t) => {
  const { plugin } = setup(t);
  plugin.updateGroups([
    {
      id: 'g',
      query: 'tag:DAG',
      color: '#112233',
      settings: { aura_radius: 999999, label_font_size: 16, garbage: 1 },
    },
  ]);
  const saved = plugin.normalizeData(JSON.parse(JSON.stringify(plugin.data)));
  assert.deepEqual(saved.groups[0].settings, { aura_radius: 5000, label_font_size: 16 });
  const legacy = plugin.normalizeData({ groups: [{ query: 'tag:DAG', color: '#112233' }] });
  assert.deepEqual(legacy.groups[0].settings, {});
});

test('membership updates refresh active list search without changing selection or physics', async (t) => {
  const { plugin, view } = setup(t);
  await plugin.updateNodeList({
    action: 'create',
    listId: 'errors',
    name: 'Errors',
    nodeIds: ['alpha.md'],
  });
  view.searchMode = 'filter';
  view.searchInputValue = 'list:errors';
  view.syncSearchMatchesLive();
  view.selectedNodeIds = new Set(['alpha.md']);
  view.kickLayoutSearch = () => assert.fail('No physics wake');
  assert.deepEqual([...view.searchMatchedNodeIds], ['alpha.md']);
  await plugin.updateNodeList({ action: 'replace', listId: 'errors', nodeIds: ['beta.md'] });
  assert.deepEqual([...view.searchMatchedNodeIds], ['beta.md']);
  assert.deepEqual([...view.selectedNodeIds], ['alpha.md']);
  await plugin.updateNodeList({ action: 'delete', listId: 'errors' });
  assert.equal(view.searchMatchedNodeIds.size, 0);
});

test('local graph shares list membership while keeping its own group settings', async (t) => {
  const { plugin, view, app } = setup(t);
  plugin.updateGroups([
    { id: 'g', query: 'list:errors', color: '#ff0000', settings: { aura_radius: 300 } },
  ]);
  const leaf = { app, getViewState: () => ({ state: {} }) };
  const local = new LocalGraphFrontierView(leaf, plugin);
  leaf.view = local;
  local.isOpen = true;
  local.nodes = view.nodes;
  local.nodeById = view.nodeById;
  local.nodeMetaById = view.nodeMetaById;
  local.render = () => {};
  app.workspace.getLeavesOfType = (type) =>
    type === 'graphfrontier-local-view' ? [leaf] : [{ view }];
  await plugin.updateNodeList({
    action: 'create',
    listId: 'errors',
    name: 'Errors',
    nodeIds: ['alpha.md'],
  });
  assert.equal(getNodeVisualSetting(local.plugin, 'alpha.md', 'aura_radius'), 300);
  local.plugin.updateGroups([
    { id: 'g', query: 'list:errors', color: '#ff0000', settings: { aura_radius: 400 } },
  ]);
  assert.equal(getNodeVisualSetting(local.plugin, 'alpha.md', 'aura_radius'), 400);
  assert.equal(getNodeVisualSetting(plugin, 'alpha.md', 'aura_radius'), 300);
  await plugin.updateNodeList({ action: 'replace', listId: 'errors', nodeIds: [] });
  assert.equal(
    getNodeVisualSetting(local.plugin, 'alpha.md', 'aura_radius'),
    local.plugin.getSettings().aura_radius
  );
});

test('group edge color and strong pull follow membership without individual overrides', async (t) => {
  const { plugin, view } = setup(t);
  let wakes = 0;
  view.kickLayoutSearch = () => wakes++;
  await plugin.updateNodeList({
    action: 'create',
    listId: 'live',
    name: 'Live',
    nodeIds: ['alpha.md'],
  });
  plugin.updateGroups([
    {
      id: 'g',
      query: 'list:live',
      color: '#123456',
      settings: { edge_color: '#FF0000', strong_pull: true },
    },
  ]);
  assert.equal(plugin.getPaintedEdgeColor('alpha.md'), '#ff0000');
  assert.equal(plugin.isStrongPullNode('alpha.md'), true);
  assert.equal(
    plugin.getNodeMultiplier('alpha.md'),
    plugin.clampStrongPullMultiplier(plugin.getSettings().strong_pull_multiplier)
  );
  assert.equal(plugin.getPaintedEdgeColor('beta.md'), null);
  assert.deepEqual(plugin.data.node_force_multipliers, {});
  assert.deepEqual(plugin.data.strong_pull_nodes, {});
  assert.deepEqual(plugin.data.painted_edge_colors, {});
  const count = wakes;
  await plugin.updateNodeList({ action: 'replace', listId: 'live', nodeIds: ['beta.md'] });
  assert(wakes > count);
  assert.equal(plugin.getPaintedEdgeColor('alpha.md'), null);
  assert.equal(plugin.getNodeMultiplier('alpha.md'), 1);
  assert.equal(plugin.getPaintedEdgeColor('beta.md'), '#ff0000');
  assert.equal(plugin.isStrongPullNode('beta.md'), true);
  plugin.setPaintedEdgeColor('beta.md', '#00ff00');
  plugin.setNodeMultiplier('beta.md', 2, { mode: 'manual' });
  assert.equal(plugin.getPaintedEdgeColor('beta.md'), '#00ff00');
  assert.equal(plugin.getNodeMultiplier('beta.md'), 2);
  assert.equal(plugin.isStrongPullNode('beta.md'), false);
  plugin.updateGroups([]);
  assert.equal(plugin.getNodeMultiplier('beta.md'), 2);
  assert.equal(plugin.getPaintedEdgeColor('beta.md'), '#00ff00');
});
