const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture, element } = require('./helpers/obsidian.cjs');
const render = require('../src/render');

test('Find selects only matches; hover highlights neighbors and links in both modes', (t) => {
  const { view, plugin } = fixture(t, {
    blacklist: [{ id: 'completed', query: 'tag:complited', enabled: true }],
  });
  view.searchMode = 'find';
  view.viewWidth = 600;
  view.viewHeight = 400;
  view.camera = { x: 0, y: 0, zoom: 1 };
  view.nodes = [
    'Grafana',
    'GraphFrontier',
    'NATS',
    'Graph archived',
    'Metrics',
    'Notes',
    'Other',
  ].map((label, index) => ({
    id: `${label}.md`,
    label,
    x: index * 20,
    y: 0,
    degree: 0,
    meta: { path: `${label}.md`, name: label, tags: index === 3 ? ['#complited'] : [] },
  }));
  view.nodeById = new Map(view.nodes.map((node) => [node.id, node]));
  view.nodeMetaById = new Map(view.nodes.map((node) => [node.id, node.meta]));
  view.neighborsById = new Map([
    ['Grafana.md', new Set(['Metrics.md', 'Graph archived.md'])],
    ['GraphFrontier.md', new Set(['Notes.md'])],
    ['Graph archived.md', new Set(['NATS.md'])],
  ]);
  view.edges = [
    { source: 'Grafana.md', target: 'Metrics.md' },
    { source: 'Notes.md', target: 'GraphFrontier.md' },
    { source: 'Metrics.md', target: 'Other.md' },
    { source: 'Grafana.md', target: 'Graph archived.md' },
  ];
  view.searchInputEl = { value: 'name:gra' };
  view.syncSearchMatchesLive();
  const alphas = [];
  const links = [];
  const ctx = new Proxy(
    {
      globalAlpha: 1,
      fill() {
        alphas.push(this.globalAlpha);
      },
      stroke() {
        links.push({ alpha: this.globalAlpha, width: this.lineWidth });
      },
      measureText() {
        return { width: 0 };
      },
    },
    {
      get(target, key) {
        return key in target ? target[key] : () => {};
      },
    }
  );
  render.drawNodes(view, ctx);
  assert.equal(view.getFilterVisibleNodeIds().has('Graph archived.md'), false);
  assert.equal(alphas.length, 6);
  assert.equal(alphas[0], 1);
  assert.equal(alphas[1], 1);
  assert(alphas[2] < 1);
  assert(alphas[3] < 1);
  assert(alphas[4] < 1);
  assert(alphas[5] < 1);
  assert.equal(links.length, 2, 'only found files have selection outlines');
  links.length = 0;
  render.drawEdges(view, ctx);
  assert(
    links.every((link) => link.alpha < 1),
    'search alone does not highlight links'
  );
  plugin.data.settings.show_search_connections = true;
  alphas.length = 0;
  links.length = 0;
  render.drawNodes(view, ctx);
  assert.equal(alphas[3], 1, 'toggle highlights first match neighbor');
  assert.equal(alphas[4], 1, 'toggle highlights second match neighbor');
  assert(alphas[2] < 1, 'hidden match does not highlight its neighbor');
  assert(alphas[5] < 1, 'connections do not extend beyond direct neighbors');
  assert.equal(links.length, 2, 'only matching files retain selection outlines');
  links.length = 0;
  render.drawEdges(view, ctx);
  assert.equal(links[0].alpha, 1);
  assert.equal(links[1].alpha, 1);
  assert(links[2].alpha < 1);
  plugin.data.settings.show_search_connections = false;
  alphas.length = 0;
  render.drawNodes(view, ctx);
  assert(alphas[3] < 1, 'disabling toggle restores matches-only highlighting');
  for (const mode of ['find', 'filter']) {
    view.searchMode = mode;
    view.searchInputEl.value = mode === 'find' ? 'name:gra' : 'file:';
    view.syncSearchMatchesLive();
    view.hoverNodeId = 'Grafana.md';
    for (let frame = 0; frame < 40; frame++) render.stepFocusSmoothing(view);
    alphas.length = 0;
    render.drawNodes(view, ctx);
    assert.equal(alphas[0], 1, `${mode}: hovered node`);
    assert.equal(alphas[3], 1, `${mode}: hovered node's neighbor`);
    assert(alphas[4] < 1, `${mode}: other match's neighbor stays dim`);
    assert(alphas[5] < 1, `${mode}: unrelated node stays dim`);
    links.length = 0;
    render.drawEdges(view, ctx);
    assert.equal(links[0].alpha, 1, `${mode}: hovered node's link`);
    assert.equal(links[0].width, 2);
    assert(links.slice(1).every((link) => link.alpha < 1));
  }
});

test('Show connections control defaults off and updates the saved setting', (t) => {
  const { view, plugin } = fixture(t);
  view.buildFindSection(element());
  const control = view.searchConnectionsToggleEl;
  assert.equal(plugin.getSettings().show_search_connections, false);
  control.events.click();
  assert.equal(plugin.getSettings().show_search_connections, true);
  view.buildFindSection(element());
  assert.equal(plugin.getSettings().show_search_connections, true);
  view.searchConnectionsToggleEl.events.click();
  assert.equal(plugin.getSettings().show_search_connections, false);
});

test('Find keeps every name match and preserves the query when committed', (t) => {
  const { view } = fixture(t);
  view.searchMode = 'find';
  view.nodes = ['Grafana', 'GraphFrontier', 'Photograph', 'NATS'].map((label) => ({
    id: label,
    label,
  }));
  view.searchInputEl = { value: 'name:Gra' };
  view.syncSearchMatchesLive();
  assert.deepEqual(
    [...view.getSearchHighlightNodeIds()],
    ['Grafana', 'GraphFrontier', 'Photograph']
  );
  view.commitSearchSelectionFromInput('name:Gra');
  assert.deepEqual(
    [...view.getSearchHighlightNodeIds()],
    ['Grafana', 'GraphFrontier', 'Photograph']
  );
  assert.equal(view.searchInputEl.value, 'name:Gra');
  assert.equal(view.searchSelectedNodeId, null);
  view.searchInputEl.value = 'name:absent';
  view.syncSearchMatchesLive();
  assert.equal(view.getSearchHighlightNodeIds(), null);
});

test('Filter retains single-name focus', (t) => {
  const { view } = fixture(t);
  view.searchMode = 'filter';
  view.nodes = [
    { id: 'graph', label: 'Graph' },
    { id: 'grafana', label: 'Grafana' },
  ];
  view.searchInputEl = { value: 'name:Gra' };
  view.kickLayoutSearch = () => {};
  view.commitSearchSelectionFromInput('name:Gra');
  assert.equal(view.searchSelectedNodeId, 'grafana');
  assert.equal(view.getSearchHighlightNodeIds(), null);
  view.nodeById = new Map(view.nodes.map((node) => [node.id, node]));
  view.hoverNodeId = 'grafana';
  for (let frame = 0; frame < 40; frame++) render.stepFocusSmoothing(view);
  assert.equal(view.hoverFocusNodeId, 'grafana');
  assert.equal(view.hoverFocusProgress, 1);
});
