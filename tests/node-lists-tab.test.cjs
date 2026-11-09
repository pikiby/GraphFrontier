const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, loadSource, element, obsidian } = require('./helpers/obsidian.cjs');
const { NodeListsTab } = loadSource('node-lists-tab.js');
const all = (el) => [el, ...el.children.flatMap(all)];
const byLabel = (el, label) =>
  all(el).find((e) => (e.attr?.['aria-label'] ?? e.attributes['aria-label']) === label);

function setup(t) {
  const f = fixture(t);
  let lists = [
    { id: 'problems', name: 'Problems', nodeIds: ['alpha.md'] },
    { id: 'deploys', name: 'Deploys', nodeIds: [] },
  ];
  const requests = [];
  f.app.vault.getAbstractFileByPath = (path) => ({ path, extension: 'md' });
  f.plugin.getNodeLists = () => lists;
  f.plugin.updateNodeList = async (request) => {
    requests.push(request);
    if (request.action === 'create') {
      const list = { id: 'new', name: request.name, nodeIds: request.nodeIds };
      lists = [...lists, list];
      return list;
    }
    if (request.action === 'delete') lists = lists.filter((l) => l.id !== request.listId);
    return lists.find((l) => l.id === request.listId);
  };
  const el = element();
  const tab = new NodeListsTab(f.view, el);
  tab.render();
  return { ...f, el, tab, requests };
}

test('Lists reuse group rows and rename on Enter', async (t) => {
  const { el, requests } = setup(t);
  const input = byLabel(el, 'List Problems');
  assert.equal(input.value, 'Problems');
  assert.equal(input.cls, 'graphfrontier-group-query');
  const settings = byLabel(el, 'List actions');
  assert.equal(settings.icon, 'more-horizontal');
  input.value = 'Incidents';
  input.events.input();
  assert.equal(settings.style.display, 'none');
  await input.events.blur();
  assert.equal(settings.style.display, '');
  assert.deepEqual(requests.at(-1), { action: 'rename', listId: 'problems', name: 'Incidents' });
});

test('creating a list adds the current selection', async (t) => {
  const { el, view, requests } = setup(t);
  view.selectedNodeIds = new Set(['alpha.md']);
  const input = byLabel(el, 'New list name');
  input.value = ' Deploys ';
  input.blur = () => input.events.blur();
  await input.events.keydown({ key: 'Enter', preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests.at(-1), { action: 'create', name: 'Deploys', nodeIds: ['alpha.md'] });
});

function openListMenu(t, el) {
  let menu;
  obsidian.Menu.prototype.showAtMouseEvent = function () {
    menu = this;
  };
  t.after(() => delete obsidian.Menu.prototype.showAtMouseEvent);
  byLabel(el, 'List actions').events.click({ clientX: 0, clientY: 0 });
  return menu;
}

test('list menu offers Add selected notes only with a selection', async (t) => {
  const { el, view, requests } = setup(t);
  assert(!openListMenu(t, el).items.some((item) => /Add selected/.test(item.title || '')));
  view.selectedNodeIds = new Set(['alpha.md']);
  const add = openListMenu(t, el).items.find((item) => item.title === 'Add selected notes (1)');
  await add.callback();
  assert.deepEqual(requests.at(-1), { action: 'add', listId: 'problems', nodeIds: ['alpha.md'] });
});

test('Members submenu removes several notes in a row without closing', async (t) => {
  const { el, requests, plugin } = setup(t);
  plugin.getNodeLists()[0].nodeIds.push('beta.md');
  const members = openListMenu(t, el).items.find((item) => item.title === 'Members (2)');
  const [alpha, beta] = members.submenu.items;
  assert.equal(alpha.title, 'alpha');
  assert.equal(alpha.icon, 'x');
  let stopped = 0;
  const click = { stopImmediatePropagation: () => (stopped += 1) };
  alpha.dom.events.click(click);
  alpha.dom.events.click(click);
  beta.dom.events.click(click);
  assert.equal(stopped, 3, 'clicks never reach the menu item, so the menu stays open');
  assert.equal(alpha.dom.style.display, 'none');
  assert.equal(members.title, 'Members (0)');
  assert.deepEqual(requests, [
    { action: 'remove', listId: 'problems', nodeIds: ['alpha.md'] },
    { action: 'remove', listId: 'problems', nodeIds: ['beta.md'] },
  ]);
});

test('Delete list works like Delete group, without a confirmation dialog', async (t) => {
  const { el, requests } = setup(t);
  const remove = openListMenu(t, el).items.find((item) => item.title === 'Delete list');
  assert.equal(remove.icon, 'trash');
  await remove.callback();
  assert.deepEqual(requests.at(-1), { action: 'delete', listId: 'problems' });
});

test('dragging a list by its handle moves it into the target place', async (t) => {
  const { el, requests } = setup(t);
  const [problems, deploys, newRow] = el.children;
  assert.equal(problems.draggable, true);
  assert.equal(newRow.children[0].style.visibility, 'hidden');
  assert.equal(byLabel(el, 'New list name').placeholder, 'New list...');
  const event = { preventDefault() {} };
  deploys.events.dragstart(event);
  await problems.events.drop(event);
  assert.deepEqual(requests.at(-1), { action: 'move', listId: 'deploys', position: 0 });
});

test('leaving the new list field creates the list', async (t) => {
  const { el, requests } = setup(t);
  const input = byLabel(el, 'New list name');
  input.value = 'Later';
  await input.events.blur();
  assert.deepEqual(requests.at(-1), { action: 'create', name: 'Later', nodeIds: [] });
});

test('Create group adds one list group and the pane menu no longer offers Node lists', (t) => {
  const { el, view, plugin } = setup(t);
  const menu = openListMenu(t, el);
  const createGroup = menu.items.find((item) => item.title === 'Create group');
  createGroup.callback();
  createGroup.callback();
  assert.equal(plugin.data.groups.filter((g) => g.query === 'list:problems').length, 1);
  assert.equal(plugin.getSettingsTab(), 'groups');
  const paneMenu = new obsidian.Menu();
  view.onPaneMenu(paneMenu);
  assert(!paneMenu.items.some((item) => item.title === 'Node lists...'));
});
