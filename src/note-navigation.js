const { Menu, Notice, Platform } = require('obsidian');

// Shown on hover over the menu items that add or edit url/path.
const NOTE_TARGET_HINT =
  "A string or a list of strings. Alias: '[Label](target)', quoted in YAML. " +
  'URLs need http(s); paths take local files and obsidian://open links.';

function validateNoteTarget(type, target) {
  if (type === 'url') {
    let url;
    try {
      url = new URL(target);
    } catch {
      throw new Error('Invalid URL in note properties');
    }
    if (!['http:', 'https:'].includes(url.protocol))
      throw new Error('URL must use http:// or https://');
    return url;
  }
  if (/^obsidian:/i.test(target)) {
    let uri;
    try {
      uri = new URL(target);
    } catch {
      throw new Error('Invalid Obsidian URI in path');
    }
    if (!/^obsidian:\/\/open\?/i.test(target) || uri.hostname !== 'open' || !uri.search)
      throw new Error('Obsidian path must use obsidian://open?...');
    return uri;
  }
  if (
    /\p{Cc}/u.test(target) ||
    (/^[a-z][a-z\d+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target))
  )
    throw new Error('Path must be a local path or obsidian://open link');
  return null;
}

function getNoteTargets(type, value) {
  const array = Array.isArray(value);
  return (array ? value : [value]).flatMap((entry) => {
    if (typeof entry !== 'string' || !entry.trim()) return [];
    const raw = entry.trim();
    const aliasEnd = raw.startsWith('[') ? raw.indexOf('](') : -1;
    const alias = aliasEnd > 0 && raw.endsWith(')');
    const target = alias ? raw.slice(aliasEnd + 2, -1).trim() : raw;
    if (!target) return [];
    let uri;
    try {
      uri = validateNoteTarget(type, target);
    } catch {
      // Keep legacy scalar errors actionable on click; arrays list valid choices only.
      if (array) return [];
    }
    const label = (
      (alias && raw.slice(1, aliasEnd).trim()) ||
      (type === 'url' && uri
        ? `${uri.host}${uri.pathname}${uri.search}${uri.hash}`
        : target
            .replace(/[\\/]+$/, '')
            .split(/[\\/]/)
            .at(-1) || target)
    ).replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, ' ');
    const characters = Array.from(label);
    return [
      { target, label: characters.length > 48 ? `${characters.slice(0, 45).join('')}...` : label },
    ];
  });
}

async function openNoteTarget(app, type, target, hostWindow) {
  const uri = validateNoteTarget(type, target);
  const nodeRequire =
    !Platform.isMobile && typeof hostWindow?.require === 'function'
      ? hostWindow.require.bind(hostWindow)
      : null;
  if (uri) {
    if (nodeRequire) await nodeRequire('electron').shell.openExternal(uri.href);
    else hostWindow.open(uri.href, '_blank', 'noopener,noreferrer');
    return;
  }

  const file = app.vault.getAbstractFileByPath(target);
  if (file && typeof file.extension === 'string') {
    await app.workspace.getLeaf(true).openFile(file);
    return;
  }
  if (!nodeRequire) {
    throw new Error('On mobile, Open path supports vault files and obsidian://open links only');
  }
  const path = nodeRequire('path');
  if (path.sep !== '\\' && path.win32.isAbsolute(target) && !path.posix.isAbsolute(target)) {
    throw new Error('This Windows path is not available on this device');
  }
  if (target.startsWith('~/')) target = path.join(nodeRequire('os').homedir(), target.slice(2));
  const base = app.vault.adapter.getBasePath?.();
  if (!path.isAbsolute(target) && !base) throw new Error('Cannot resolve the vault folder');
  const resolved = path.isAbsolute(target) ? target : path.resolve(base, target);
  const error = await nodeRequire('electron').shell.openPath(resolved);
  if (error) throw new Error(error);
}

function addNoteTargetActions(menu, app, key, value, hostWindow, options = {}) {
  const targets = getNoteTargets(key, value);
  if (!targets.length) return;
  const title = key === 'url' ? 'Open URL' : 'Open path';
  const icon = key === 'url' ? 'external-link' : 'folder-open';
  const add =
    options.add ||
    ((targetMenu, label, actionIcon, callback) => {
      let added;
      targetMenu.addItem((item) => {
        added = item;
        item
          .setTitle(label)
          .setIcon(actionIcon)
          .onClick(async () => {
            try {
              await callback();
            } catch (error) {
              new Notice(`Cannot open ${key}: ${error.message}`);
            }
          });
      });
      return added;
    });
  const choice = (targetMenu, entry, label) => {
    const item = add(targetMenu, label, icon, () =>
      openNoteTarget(app, key, entry.target, hostWindow)
    );
    item?.dom?.setAttribute('title', entry.target);
  };
  const fill = (targetMenu) => {
    targets.forEach((entry) => choice(targetMenu, entry, entry.label));
    if (options.edit)
      add(targetMenu, 'Edit', 'pencil', options.edit)?.dom?.setAttribute('title', NOTE_TARGET_HINT);
  };
  if (options.submenu) options.submenu(title, icon, fill);
  else
    menu.addItem((item) => {
      item.setTitle(title).setIcon(icon);
      if (typeof item.setSubmenu === 'function') fill(item.setSubmenu());
      else
        item.onClick((event) => {
          const submenu = new Menu(app);
          fill(submenu);
          submenu.showAtMouseEvent(event);
        });
    });
}

// Opens the note on its YAML url/path line, adding an empty property if needed. The note keeps
// the reader's own view mode; only plain source mode has a text line to put the cursor on,
// while Live Preview and Reading show the property in the Properties block.
async function editNoteTarget(app, file, key) {
  await app.fileManager.processFrontMatter(file, (frontmatter) => {
    if (!(key in frontmatter)) frontmatter[key] = null;
  });
  const lines = (await app.vault.read(file)).split(/\r?\n/);
  const line = Math.max(
    0,
    lines.findIndex((entry, index) => index > 0 && new RegExp(`^${key}\\s*:`).test(entry))
  );
  const leaf = app.workspace.getLeaf(true);
  await leaf.openFile(file, { eState: { line } });
  const editor = leaf.view?.editor;
  if (!editor || leaf.getViewState?.().state?.source !== true) return;
  editor.setCursor({ line, ch: editor.getLine(line).length });
  editor.focus();
}

function addNoteNavigationActions(menu, app, file, hostWindow) {
  const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
  if (!frontmatter) return;
  for (const key of ['url', 'path'])
    addNoteTargetActions(menu, app, key, frontmatter[key], hostWindow);
}

module.exports = {
  addNoteNavigationActions,
  addNoteTargetActions,
  editNoteTarget,
  getNoteTargets,
  openNoteTarget,
  NOTE_TARGET_HINT,
};
