const { Notice, Platform } = require('obsidian');

async function openNoteTarget(app, type, target, hostWindow) {
  const nodeRequire =
    !Platform.isMobile && typeof hostWindow?.require === 'function'
      ? hostWindow.require.bind(hostWindow)
      : null;
  if (type === 'url') {
    let url;
    try {
      url = new URL(target);
    } catch {
      throw new Error('Invalid URL in note properties');
    }
    if (!['http:', 'https:'].includes(url.protocol))
      throw new Error('URL must use http:// or https://');
    if (nodeRequire) await nodeRequire('electron').shell.openExternal(url.href);
    else hostWindow.open(url.href, '_blank', 'noopener,noreferrer');
    return;
  }

  if (type === 'path' && /^obsidian:/i.test(target)) {
    let uri;
    try {
      uri = new URL(target);
    } catch {
      throw new Error('Invalid Obsidian URI in path');
    }
    if (!/^obsidian:\/\/open\?/i.test(target) || uri.hostname !== 'open' || !uri.search)
      throw new Error('Obsidian path must use obsidian://open?...');
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

function addNoteNavigationActions(menu, app, file, hostWindow) {
  const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
  if (!frontmatter) return;
  for (const [key, title, icon] of [
    ['url', 'Open URL', 'external-link'],
    ['path', 'Open path', 'folder-open'],
  ]) {
    const value = frontmatter[key];
    if (typeof value !== 'string' || !value.trim()) continue;
    menu.addItem((item) =>
      item
        .setTitle(title)
        .setIcon(icon)
        .onClick(async () => {
          try {
            await openNoteTarget(app, key, value.trim(), hostWindow);
          } catch (error) {
            new Notice(`Cannot open ${key}: ${error.message}`);
          }
        })
    );
  }
}

module.exports = { addNoteNavigationActions, openNoteTarget };
