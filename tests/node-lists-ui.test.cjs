const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, loadSource } = require('./helpers/obsidian.cjs');
const { NodeListsPanel } = loadSource('node-lists-modal.js');
const all = (el) => [el, ...el.children.flatMap(all)];
const byText = (m, text) => all(m.contentEl).find((e) => e.text === text);
const byLabel = (m, label) => all(m.contentEl).find((e) => e.attributes['aria-label'] === label);
function setup(t, count = 2) {
  const f = fixture(t);
  let lists = [
    { id: 'ERROR', name: 'Errors', nodeIds: ['a.md', 'missing.md'] },
    { id: 'OK', name: 'Okay', nodeIds: [] },
  ];
  const paths = Array.from({ length: count }, (_, i) => (i === 0 ? 'a.md' : `b${i}.md`));
  f.app.vault.getFiles = () => paths.map((path) => ({ path }));
  f.app.vault.getAbstractFileByPath = (path) => (paths.includes(path) ? { path } : null);
  f.plugin.getNodeLists = () => lists;
  f.plugin.updateNodeList = async (request) => {
    if (request.action === 'create') {
      const l = { id: 'NEW', name: request.name, nodeIds: [] };
      lists.push(l);
      return l;
    }
    const l = lists.find((l) => l.id === request.listId);
    if (request.action === 'add') l.nodeIds = [...new Set([...l.nodeIds, ...request.nodeIds])];
    if (request.action === 'remove')
      l.nodeIds = l.nodeIds.filter((p) => !request.nodeIds.includes(p));
    if (request.action === 'delete') lists = lists.filter((l) => l.id !== request.listId);
    if (request.action === 'rename') l.name = request.name;
    return l;
  };
  const modal = new NodeListsPanel(
    f.view,
    new (require('./helpers/obsidian.cjs').obsidian.Modal)(f.app).contentEl
  );
  modal.onOpen();
  return { ...f, modal };
}
test('catalog searches every list and opens members with paths and missing-file status', (t) => {
  const { modal } = setup(t);
  const search = byLabel(modal, 'Search lists');
  search.value = 'Okay';
  search.events.input();
  assert(!byText(modal, 'Errors'));
  assert(byText(modal, 'Okay'));
  search.value = '';
  search.events.input();
  byText(modal, 'Errors').events; // label is inside its button
  const button = all(modal.contentEl).find(
    (e) => e.tag === 'button' && e.children.some((c) => c.text === 'Errors')
  );
  button.events.click();
  assert(byLabel(modal, 'List actions'));
  assert(!byText(modal, 'API ID: ERROR'));
  assert(byText(modal, 'missing.md'));
  assert(byText(modal, 'File not found'));
});
test('picker supports multiple additions and removal uses delta without replacing other members', async (t) => {
  const { modal, plugin } = setup(t, 4);
  modal.selectedId = 'ERROR';
  modal.render();
  byText(modal, 'Add files...').events.click();
  for (const path of ['b1.md', 'b2.md']) {
    const check = byLabel(modal, path);
    check.checked = true;
    check.events.change();
  }
  await byText(modal, 'Add selected').events.click();
  assert.deepEqual(plugin.getNodeLists()[0].nodeIds, ['a.md', 'missing.md', 'b1.md', 'b2.md']);
  byText(modal, 'Back to members').events.click();
  const remove = byLabel(modal, 'a.md');
  remove.checked = true;
  remove.events.change();
  await byText(modal, 'Remove selected').events.click();
  assert(plugin.getNodeLists()[0].nodeIds.includes('b2.md'));
  assert(!plugin.getNodeLists()[0].nodeIds.includes('a.md'));
});
test('large file pickers render bounded pages and keep selection between searches', (t) => {
  const { modal } = setup(t, 130);
  modal.selectedId = 'ERROR';
  modal.addMode = true;
  modal.render();
  assert(
    all(modal.contentEl).filter((e) => e.tag === 'input' && e.type === 'checkbox').length <= 50
  );
  const check = byLabel(modal, 'b1.md');
  check.checked = true;
  check.events.change();
  const search = byLabel(modal, 'Search vault files');
  search.value = 'b120';
  search.events.input();
  assert(byLabel(modal, 'b120.md'));
  assert(modal.selected.has('b1.md'));
});
test('failed update keeps selected files and successful create opens the new list', async (t) => {
  const { modal, plugin } = setup(t);
  modal.selected.add('a.md');
  const original = plugin.updateNodeList;
  plugin.updateNodeList = async () => {
    throw new Error('disk');
  };
  await modal.update({ action: 'remove', listId: 'ERROR', nodeIds: ['a.md'] });
  assert(modal.selected.has('a.md'));
  plugin.updateNodeList = original;
  await modal.update({ action: 'create', name: 'New' });
  assert.equal(modal.selectedId, 'NEW');
  assert(byText(modal, 'New (0)'));
});
