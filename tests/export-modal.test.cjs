const assert = require('node:assert/strict');
const test = require('node:test');
const {
  loadSource,
  fixture,
  deferred,
  element,
  obsidian,
  notices,
} = require('./helpers/obsidian.cjs');
const { mobileVault } = require('./helpers/mobile-vault.cjs');
const { ExportModal } = loadSource('export-modal.js');
const { writeVaultExport } = loadSource('vault-export.js');

const descendants = (el) => [el, ...el.children.flatMap(descendants)];
const textOf = (el) =>
  descendants(el)
    .map((child) => child.text || '')
    .join('\n');

function setup(t, exportHtml) {
  const storage = mobileVault(t);
  const requests = [];
  const modal = new ExportModal({ vault: storage.vault }, async (options) => {
    requests.push(options);
    if (exportHtml) return exportHtml(options, storage);
    await writeVaultExport(storage.vault, options.exportPath, 'HTML', options);
    return { path: options.exportPath, nodeCount: 1, edgeCount: 0 };
  });
  modal.open();
  return { ...storage, modal, requests };
}

function edit(input, value) {
  input.value = value;
  input.events.input();
}

test('modal names the current vault, defaults to root, labels inputs and cancels without writes', (t) => {
  const { modal, calls, requests } = setup(t);
  assert.equal(modal.title, 'Export graph');
  assert.match(textOf(modal.contentEl), /Save inside vault/);
  assert.match(textOf(modal.contentEl), /Test vault/);
  assert.equal(modal.filenameInput.value, 'graphfrontier-static.html');
  assert.equal(modal.filenameInput.selectionEnd, 'graphfrontier-static'.length);
  assert.equal(modal.folderInput.value, '');
  assert.equal(modal.destinationPath, 'graphfrontier-static.html');
  assert.equal(modal.submitButton.text, 'Export');
  assert.equal(modal.replacePath, null);
  assert.equal(descendants(modal.contentEl).filter((el) => el.tag === 'p').length, 1);
  assert.equal(
    descendants(modal.contentEl).some((el) => el.type === 'checkbox'),
    false
  );
  assert.equal(modal.openButton.hidden, true);
  assert.equal(modal.filenameInput.attributes['aria-label'], 'Export filename');
  assert.equal(modal.folderInput.attributes['aria-label'], 'Folder inside vault (optional)');
  assert.equal(modal.errorEl.attributes.role, 'alert');
  assert.equal(modal.successEl.attributes.role, 'status');
  modal.cancelButton.events.click();
  assert.equal(modal.opened, false);
  assert.equal(modal.closed, true);
  assert.deepEqual(calls, []);
  assert.deepEqual(requests, []);
});

test('fields show Folder before Filename without a destination preview and retain filename focus', (t) => {
  const { modal } = setup(t);
  assert.deepEqual(
    modal.form.children.map((el) => el.text),
    ['Folder', 'Filename']
  );
  assert.equal(modal.form.children[0].children[0], modal.folderInput);
  assert.equal(modal.form.children[1].children[0], modal.filenameInput);
  assert.equal(
    descendants(modal.form).some((el) => el.tag === 'code'),
    false
  );
  assert.equal(
    descendants(modal.contentEl).some((el) => el.cls === 'graphfrontier-export-destination'),
    false
  );
  assert.equal(modal.previewEl, undefined);
  assert.equal(modal.filenameInput.focused, true);
});

test('destination normalizes folders and extensions; success remains open with vault and full path', async (t) => {
  const { modal, contents, requests } = setup(t);
  edit(modal.filenameInput, '  My graph.md  ');
  edit(modal.folderInput, ' Exports\\Nested// ');
  assert.equal(modal.destinationPath, 'Exports/Nested/My graph.html');
  await modal.submitButton.events.click();
  assert.equal(contents.get('Exports/Nested/My graph.html'), 'HTML');
  assert.equal(requests[0].exportPath, 'Exports/Nested/My graph.html');
  assert.equal(requests[0].overwrite, false);
  assert.equal(modal.opened, true);
  assert.equal(modal.completed, true);
  assert.equal(modal.form.hidden, true);
  assert.equal(modal.submitButton.hidden, true);
  assert.equal(modal.successEl.hidden, false);
  assert.equal(modal.cancelButton.text, 'Close');
  assert.equal(modal.cancelButton.focused, true);
  assert.match(textOf(modal.successEl), /Saved/);
  assert.match(textOf(modal.successEl), /Exports\/Nested\/My graph.html/);
  assert.equal(modal.successEl.children.length, 2);
  assert.equal(modal.openButton.hidden, false);
  await modal.submit();
  assert.equal(requests.length, 1);
  modal.cancelButton.events.click();
  assert.equal(modal.opened, false);
});

test('invalid filenames and folders show inline errors and never call the writer', async (t) => {
  const { modal, requests, calls } = setup(t);
  for (const [filename, folder] of [
    ['', ''],
    ['../graph', ''],
    ['folder/graph', ''],
    ['folder\\graph', ''],
    ['.hidden', ''],
    ['CON', ''],
    ['COM1.txt', ''],
    ['graph?', ''],
    ['graph.', ''],
    ['https://host/graph', ''],
    ['C:\\graph', ''],
    ['/graph', ''],
    ['graph', '/tmp'],
    ['graph', '\\\\host\\share'],
    ['graph', '~/Downloads'],
    ['graph', 'Exports/../Other'],
    ['graph', 'Exports/.hidden'],
    ['graph', '.obsidian'],
    ['graph', 'file:///tmp'],
    ['graph', 'https://host'],
    ['graph', 'Exports/NUL'],
    ['graph', 'Exports/\x00'],
  ]) {
    edit(modal.filenameInput, filename);
    edit(modal.folderInput, folder);
    assert.equal(modal.submitButton.disabled, true, `${filename} in ${folder}`);
    assert.equal(modal.errorEl.hidden, false);
    assert.ok(modal.errorEl.text);
    await modal.submit();
    assert.equal(modal.filenameInput.value, filename);
    assert.equal(modal.folderInput.value, folder);
    assert.equal(modal.completed, false);
  }
  assert.deepEqual(requests, []);
  assert.deepEqual(calls, []);
  edit(modal.filenameInput, 'valid');
  edit(modal.folderInput, 'Exports');
  assert.equal(modal.submitButton.disabled, false);
  assert.equal(modal.errorEl.hidden, true);
});

test('existing targets need confirmation bound to the destination, never silent replacement', async (t) => {
  const { modal, file, folder, contents, requests } = setup(t);
  folder('Other');
  file('first.html', 'keep first');
  file('Other/second.html', 'keep second');
  edit(modal.filenameInput, 'first');
  assert.equal(modal.submitButton.text, 'Replace file');
  await modal.submit();
  assert.match(modal.errorEl.text, /Confirm replacement/);
  assert.equal(requests.length, 0);
  assert.equal(contents.get('first.html'), 'keep first');
  edit(modal.filenameInput, 'second');
  edit(modal.folderInput, 'Other');
  assert.equal(modal.replacePath, 'Other/second.html');
  await modal.submit('first.html');
  assert.equal(requests.length, 0, 'old-path consent cannot replace a different destination');
  await modal.submit();
  assert.equal(contents.get('Other/second.html'), 'keep second');
  await modal.submitButton.events.click();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].overwrite, true);
  assert.equal(contents.get('Other/second.html'), 'HTML');
  assert.equal(contents.get('first.html'), 'keep first');
});

test('a target appearing just before submission requires confirmation before any write', async (t) => {
  const { modal, file, contents, requests } = setup(t);
  file('graphfrontier-static.html', 'raced');
  await modal.submitButton.events.click();
  assert.equal(requests.length, 0);
  assert.equal(modal.submitButton.text, 'Replace file');
  assert.match(modal.errorEl.text, /Confirm replacement/);
  assert.equal(contents.get('graphfrontier-static.html'), 'raced');
});

test('queued writer races fail inline, then allow explicitly confirmed replacement', async (t) => {
  const gate = deferred();
  const { modal, vault, contents, requests } = setup(t);
  const first = writeVaultExport(vault, 'graphfrontier-static.html', 'raced', {
    overwrite: false,
  });
  const create = vault.create;
  vault.create = async (...args) => {
    await gate.promise;
    return create(...args);
  };
  const pending = modal.submit();
  assert.equal(requests[0].overwrite, false);
  gate.resolve();
  await first;
  await pending;
  assert.equal(contents.get('graphfrontier-static.html'), 'raced');
  assert.equal(modal.completed, false);
  assert.equal(modal.opened, true);
  assert.equal(modal.submitButton.text, 'Replace file');
  assert.match(modal.errorEl.text, /already exists/);
  await modal.submitButton.events.click();
  assert.equal(contents.get('graphfrontier-static.html'), 'HTML');
  assert.equal(modal.completed, true);
});

test('folder target and file parent failures remain inline without clearing the form', async (t) => {
  const { modal, folder, file, requests } = setup(t);
  folder('graphfrontier-static.html');
  modal.refreshDestination();
  await modal.submit();
  assert.equal(requests.length, 0);
  assert.match(modal.errorEl.text, /points to a folder/);
  edit(modal.filenameInput, 'graph');
  file('Blocked', 'keep');
  edit(modal.folderInput, 'Blocked');
  await modal.submit();
  assert.match(modal.errorEl.text, /Not a folder/);
  assert.equal(modal.filenameInput.value, 'graph');
  assert.equal(modal.folderInput.value, 'Blocked');
  assert.equal(modal.busy, false);
  assert.equal(modal.submitButton.disabled, false);
  assert.equal(modal.completed, false);
});

test('storage errors preserve values and allow retry; no undefined result becomes success', async (t) => {
  const { modal, vault, contents } = setup(t);
  const create = vault.create;
  vault.create = async () => {
    throw new Error('Read-only vault');
  };
  edit(modal.filenameInput, 'My graph');
  await modal.submit();
  assert.equal(modal.opened, true);
  assert.equal(modal.completed, false);
  assert.equal(modal.successEl.hidden, true);
  assert.equal(modal.filenameInput.value, 'My graph');
  assert.match(modal.errorEl.text, /Read-only vault/);
  assert.equal(modal.submitButton.disabled, false);
  vault.create = create;
  await modal.submit();
  assert.equal(contents.get('My graph.html'), 'HTML');
  assert.equal(modal.completed, true);
  const failure = setup(t, async () => undefined).modal;
  await failure.submit();
  assert.equal(failure.completed, false);
  assert.equal(failure.successEl.hidden, true);
  assert.match(failure.errorEl.text, /did not complete/);
  const mismatch = setup(t, async () => ({ path: 'unexpected.html' })).modal;
  await mismatch.submit();
  assert.equal(mismatch.completed, false);
  assert.match(mismatch.errorEl.text, /did not complete/);
});

test('busy state blocks duplicate clicks/Enter/cancel and locks inputs until completion', async (t) => {
  const gate = deferred();
  const { modal, requests, contents } = setup(t, async (options, { vault }) => {
    await gate.promise;
    await writeVaultExport(vault, options.exportPath, 'HTML', options);
    return { path: options.exportPath };
  });
  const pending = modal.submitButton.events.click();
  assert.equal(modal.busy, true);
  for (const control of [
    modal.filenameInput,
    modal.folderInput,
    modal.submitButton,
    modal.cancelButton,
  ])
    assert.equal(control.disabled, true);
  assert.equal(modal.contentEl.attributes['aria-busy'], 'true');
  await modal.submitButton.events.click();
  modal.filenameInput.events.keydown({ key: 'Enter', preventDefault() {} });
  modal.cancelButton.events.click();
  assert.equal(modal.opened, true);
  assert.equal(requests.length, 1);
  gate.resolve();
  await pending;
  assert.equal(contents.size, 1);
  assert.equal(modal.busy, false);
  assert.equal(modal.cancelButton.disabled, false);
  assert.equal(modal.contentEl.attributes['aria-busy'], 'false');
});

test('native dismissal during preparation cancels queued writing and shows no success', async (t) => {
  const gate = deferred();
  const { modal, calls, contents } = setup(t, async (options, { vault }) => {
    await gate.promise;
    await writeVaultExport(vault, options.exportPath, 'HTML', options);
    return { path: options.exportPath };
  });
  const pending = modal.submit();
  modal.close();
  gate.resolve();
  await pending;
  assert.deepEqual(calls, []);
  assert.equal(contents.size, 0);
  assert.equal(modal.opened, false);
  assert.equal(modal.completed, false);
  assert.equal(modal.busy, false);
  assert.equal(modal.contentEl.children.length, 0);
});

test('native dismissal cancels an export already waiting in the vault write queue', async (t) => {
  const gate = deferred();
  const started = deferred();
  const { modal, vault, contents, calls } = setup(t);
  const create = vault.create;
  vault.create = async (...args) => {
    started.resolve();
    await gate.promise;
    return create(...args);
  };
  const first = writeVaultExport(vault, 'other.html', 'other export', { overwrite: false });
  await started.promise;
  const pending = modal.submit();
  assert.equal(modal.busy, true);
  modal.close();
  gate.resolve();
  await first;
  await pending;
  assert.deepEqual(calls, [['create', 'other.html']]);
  assert.equal(contents.has('graphfrontier-static.html'), false);
  assert.equal(modal.completed, false);
});

test('filename Enter submits, ignores IME composition and prevents form reload', async (t) => {
  const gate = deferred();
  const { modal, requests } = setup(t, async ({ exportPath }) => {
    await gate.promise;
    return { path: exportPath };
  });
  modal.filenameInput.events.keydown({ key: 'Enter', isComposing: true });
  assert.equal(requests.length, 0);
  let prevented = false;
  modal.filenameInput.events.keydown({ key: 'Enter', preventDefault: () => (prevented = true) });
  assert.equal(prevented, true);
  assert.equal(requests.length, 1);
  let preventedSubmit = false;
  modal.form.events.submit({ preventDefault: () => (preventedSubmit = true) });
  assert.equal(preventedSubmit, true);
  assert.equal(requests.length, 1);
  gate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(modal.completed, true);
});

test('native folder suggestions list real visible folders and select root or nested paths without exporting', (t) => {
  const { modal, folder, file, requests, calls } = setup(t);
  folder('/');
  folder('Exports');
  folder('Exports/Graphs');
  folder('Archive');
  folder('.obsidian');
  folder('Hidden/.private');
  file('not-a-folder.md');
  const suggest = modal.folderSuggest;
  assert.ok(suggest instanceof obsidian.AbstractInputSuggest);
  assert.equal(suggest.limit, 8);
  assert.deepEqual(suggest.getSuggestions(''), ['', 'Archive', 'Exports', 'Exports/Graphs']);
  assert.deepEqual(suggest.getSuggestions('EXPORTS\\GR'), ['Exports/Graphs']);
  assert.deepEqual(suggest.getSuggestions('new/nested'), []);
  const rendered = element();
  suggest.renderSuggestion('', rendered);
  assert.equal(rendered.text, 'Vault root');
  let prevented = false;
  let stopped = false;
  suggest.open();
  suggest.selectSuggestion('Exports/Graphs', {
    key: 'Enter',
    preventDefault: () => (prevented = true),
    stopPropagation: () => (stopped = true),
  });
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  assert.equal(suggest.opened, false);
  assert.equal(modal.folderInput.value, 'Exports/Graphs');
  assert.equal(modal.destinationPath, 'Exports/Graphs/graphfrontier-static.html');
  modal.form.events.submit({ preventDefault() {} });
  assert.equal(requests.length, 0, 'implicit folder Enter never submits an export');
  suggest.selectSuggestion('', { preventDefault() {}, stopPropagation() {} });
  assert.equal(modal.folderInput.value, '');
  assert.equal(modal.destinationPath, 'graphfrontier-static.html');
  assert.deepEqual(calls, []);
});

test('folder selection updates replacement action and typing new nested folders is unrestricted', async (t) => {
  const { modal, file, folder, contents, requests } = setup(t);
  folder('Exports');
  file('Exports/graphfrontier-static.html', 'keep');
  modal.folderSuggest.selectSuggestion('Exports');
  assert.equal(modal.submitButton.text, 'Replace file');
  edit(modal.folderInput, 'New/Nested');
  assert.equal(modal.submitButton.text, 'Export');
  assert.equal(modal.destinationPath, 'New/Nested/graphfrontier-static.html');
  await modal.submitButton.events.click();
  assert.equal(requests[0].overwrite, false);
  assert.equal(contents.get('New/Nested/graphfrontier-static.html'), 'HTML');
  assert.equal(contents.get('Exports/graphfrontier-static.html'), 'keep');
});

test('folder selector cannot modify a busy, completed or closed modal and closes with it', async (t) => {
  const gate = deferred();
  const { modal } = setup(t, async ({ exportPath }) => {
    await gate.promise;
    return { path: exportPath };
  });
  const suggest = modal.folderSuggest;
  suggest.open();
  const pending = modal.submit();
  assert.equal(suggest.opened, false);
  assert.deepEqual(suggest.getSuggestions(''), []);
  suggest.selectSuggestion('Other');
  assert.equal(modal.folderInput.value, '');
  gate.resolve();
  await pending;
  suggest.selectSuggestion('Other');
  assert.equal(modal.folderInput.value, '');
  suggest.open();
  modal.close();
  assert.equal(suggest.opened, false);
  suggest.selectSuggestion('Other');
  assert.equal(modal.folderInput.value, '');
});

test('Open file uses the completed relative path and the app method receiver, never input edits', async (t) => {
  const { modal, requests } = setup(t);
  const opened = [];
  modal.app.openWithDefaultApp = function (path) {
    assert.equal(this, modal.app);
    opened.push(path);
  };
  await modal.openFile();
  assert.deepEqual(opened, []);
  edit(modal.folderInput, 'Exports/Graphs');
  edit(modal.filenameInput, 'My graph');
  await modal.submitButton.events.click();
  modal.filenameInput.value = 'changed';
  await modal.openButton.events.click();
  assert.deepEqual(opened, ['Exports/Graphs/My graph.html']);
  assert.equal(requests.length, 1);
  assert.equal(modal.errorEl.hidden, true);
  assert.equal(modal.opened, true);
  modal.close();
  await modal.openFile();
  await modal.submitButton.events.click();
  assert.equal(opened.length, 1);
  assert.equal(requests.length, 1);
});

test('missing or failing file opener leaves durable success/path and shows a retryable inline error', async (t) => {
  const { modal } = setup(t);
  await modal.submit();
  await modal.openButton.events.click();
  assert.match(modal.errorEl.text, /unavailable/);
  assert.equal(modal.completed, true);
  assert.equal(modal.successEl.hidden, false);
  assert.match(textOf(modal.successEl), /graphfrontier-static.html/);
  modal.app.openWithDefaultApp = async () => {
    throw new Error('No default app');
  };
  await modal.openButton.events.click();
  assert.match(modal.errorEl.text, /No default app/);
  assert.equal(modal.openButton.disabled, false);
  modal.app.openWithDefaultApp = async () => {};
  await modal.openButton.events.click();
  assert.equal(modal.errorEl.hidden, true);
});

test('Open file blocks duplicate opens and ignores late opener errors after closing', async (t) => {
  const { modal } = setup(t);
  const gate = deferred();
  let opened = 0;
  modal.app.openWithDefaultApp = async () => {
    opened++;
    await gate.promise;
  };
  await modal.submit();
  const pending = modal.openButton.events.click();
  assert.equal(modal.openButton.disabled, true);
  await modal.openButton.events.click();
  assert.equal(opened, 1);
  modal.close();
  gate.reject(new Error('Late error'));
  await pending;
  assert.equal(modal.contentEl.children.length, 0);
  assert.equal(modal.errorEl.hidden, true);
});

test('view passes readiness/write errors to the modal but retains Notice/undefined API failures', async (t) => {
  const { app, view } = fixture(t);
  const { vault, contents } = mobileVault(t);
  Object.assign(app.vault, vault);
  const open = obsidian.Modal.prototype.open;
  let modal;
  t.mock.method(obsidian.Modal.prototype, 'open', function () {
    modal = this;
    open.call(this);
  });
  await view.commandExportStaticHtml();
  await modal.submit();
  assert.equal(modal.completed, false);
  assert.match(modal.errorEl.text, /canvas is not ready/);
  assert.equal(contents.size, 0);
  assert.equal(notices.length, 0);
  assert.equal(await view.commandExportStaticHtml({ exportPath: 'graph.html' }), undefined);
  assert.match(notices.at(-1), /canvas is not ready/);
  view.canvasEl = {};
  view.ctx = {};
  view.app.vault.create = async () => {
    throw new Error('Permission denied');
  };
  await modal.submit();
  assert.match(modal.errorEl.text, /Permission denied/);
  assert.equal(modal.completed, false);
  assert.equal(modal.opened, true);
  const oldModal = modal;
  assert.equal(await view.commandExportStaticHtml({ exportPath: 'graph.html' }), undefined);
  assert.match(notices.at(-1), /Failed to write static HTML export: Permission denied/);
  assert.equal(modal, oldModal, 'explicit paths do not open a modal');
});

test('sidebar Export to opens the same vault modal without writing', async (t) => {
  const { app, view } = fixture(t);
  const { vault, calls } = mobileVault(t);
  Object.assign(app.vault, vault);
  const open = obsidian.Modal.prototype.open;
  let modal;
  t.mock.method(obsidian.Modal.prototype, 'open', function () {
    modal = this;
    open.call(this);
  });
  const parent = element();
  view.addSideSaveLayoutButton(parent);
  await descendants(parent)
    .find((el) => el.text === 'Export to')
    .events.click();
  assert.ok(modal instanceof ExportModal);
  assert.equal(modal.opened, true);
  assert.equal(modal.destinationPath, 'graphfrontier-static.html');
  assert.deepEqual(calls, []);
});

test('an HTML-named folder appearing before generation never redirects a modal export', async (t) => {
  const { app, view } = fixture(t);
  const { vault, folder, contents } = mobileVault(t);
  Object.assign(app.vault, vault);
  view.canvasEl = {};
  view.ctx = {};
  folder('graph.html');
  await assert.rejects(
    view.commandExportStaticHtml(
      { exportPath: 'graph.html', overwrite: false },
      {
        throwOnError: true,
        exactPath: true,
      }
    ),
    /destination changed/
  );
  assert.equal(contents.size, 0);
});

test('closing the actual view export during note reads prevents the HTML write', async (t) => {
  const { app, view } = fixture(t);
  const { vault, file, contents, calls } = mobileVault(t);
  Object.assign(app.vault, vault);
  file('alpha.md', '# Alpha');
  view.canvasEl = {};
  view.ctx = {};
  const gate = deferred();
  const started = deferred();
  app.vault.cachedRead = async () => {
    started.resolve();
    await gate.promise;
    return '# Alpha';
  };
  const open = obsidian.Modal.prototype.open;
  let modal;
  t.mock.method(obsidian.Modal.prototype, 'open', function () {
    modal = this;
    open.call(this);
  });
  await view.commandExportStaticHtml();
  const pending = modal.submit();
  await started.promise;
  modal.close();
  gate.resolve();
  await pending;
  assert.equal(contents.has('graphfrontier-static.html'), false);
  assert.deepEqual(calls, []);
  assert.equal(modal.completed, false);
  assert.equal(notices.length, 0);
});
