const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, loadSource, element, obsidian } = require('./helpers/obsidian.cjs');
const { LayoutList } = loadSource('layout-list.js');

function setup(t) {
  const f = fixture(t);
  if (!f.files.has(f.layoutPath())) f.putLayout(f.plugin.data);
  f.putLayout({ groups: [] }, 'next.json');
  const folder = f.plugin.getLayoutsFolderRelativePath();
  f.adapter.list = async () => ({
    files: [...f.files.keys()].filter((name) => name.startsWith(`${folder}/`)),
  });
  f.adapter.rename = async (from, to) => {
    f.files.set(to, f.files.get(from));
    f.files.delete(from);
  };
  f.adapter.remove = async (name) => f.files.delete(name);
  const el = element();
  const list = new LayoutList(f.view, el);
  const rows = () => el.children.map((row) => row.children[1].children[0]);
  return { ...f, el, list, rows };
}

test('every layout is a row; clicking another one makes it active', async (t) => {
  const { list, rows, view } = setup(t);
  await list.render();
  assert.deepEqual(
    rows().map((input) => [input.value, input.readOnly, input.attributes.title]),
    [
      ['data', true, 'Active layout'],
      ['next', true, 'Click to make this layout active'],
      ['', undefined, 'Save the current graph as a new layout and make it active'],
    ]
  );
  const select = t.mock.method(view, 'selectActiveLayoutFileByName', async () => true);
  rows()[0].events.click();
  assert.equal(select.mock.callCount(), 0, 'the active layout is not reloaded');
  rows()[1].events.click();
  assert.deepEqual(select.mock.calls[0].arguments, ['next.json']);
});

test('New layout saves the current graph under a free name and keeps the name on failure', async (t) => {
  const { list, rows, plugin, adapter, files, layoutPath } = setup(t);
  await list.render();
  const input = rows().at(-1);
  input.value = 'next';
  await input.events.blur();
  assert.equal(input.value, 'next', 'an existing layout is never overwritten');
  assert.equal(plugin.getActiveLayoutFileName(), 'data.json');
  const write = t.mock.method(adapter, 'write', async () => {
    throw new Error('Disk full');
  });
  input.value = 'new layout';
  await input.events.blur();
  assert.equal(input.value, 'new layout');
  assert.equal(plugin.getActiveLayoutFileName(), 'data.json');
  write.mock.restore();
  await input.events.blur();
  assert.equal(plugin.getActiveLayoutFileName(), 'new layout.json');
  assert.equal(files.has(layoutPath('new layout.json')), true);
  assert.deepEqual(
    rows().map((row) => row.value),
    ['data', 'new layout', 'next', '']
  );
});

test('the row menu renames in place and deletes like Delete group', async (t) => {
  const { list, rows, el, plugin, files, layoutPath } = setup(t);
  await list.render();
  let menu;
  obsidian.Menu.prototype.showAtMouseEvent = function () {
    menu = this;
  };
  t.after(() => delete obsidian.Menu.prototype.showAtMouseEvent);
  const openMenu = (index) => {
    el.children[index].children.at(-1).events.click({ clientX: 0, clientY: 0 });
    return menu;
  };
  assert.deepEqual(
    openMenu(0).items.map((item) => item.title || '-'),
    ['Rename', '-', 'Delete layout']
  );
  menu.items[0].callback();
  const input = rows()[0];
  assert.equal(input.readOnly, false);
  input.value = 'main';
  await input.events.blur();
  assert.equal(plugin.getActiveLayoutFileName(), 'main.json', 'active layout keeps active');
  assert.equal(files.has(layoutPath('data.json')), false);
  assert.equal(files.has(layoutPath('main.json')), true);
  assert.deepEqual(
    rows().map((row) => row.value),
    ['main', 'next', '']
  );
  await openMenu(1).items.at(-1).callback();
  assert.equal(files.has(layoutPath('next.json')), false);
  assert.deepEqual(
    rows().map((row) => row.value),
    ['main', '']
  );
});

test('rows from the last listing render at once, so a panel rebuild keeps its height', async (t) => {
  const { list, rows, view } = setup(t);
  view.layoutNamesCache = ['data.json', 'next.json'];
  const rendering = list.render();
  assert.deepEqual(
    rows().map((input) => input.value),
    ['data', 'next', '']
  );
  await rendering;
  assert.deepEqual(view.layoutNamesCache, ['data.json', 'next.json']);
});
