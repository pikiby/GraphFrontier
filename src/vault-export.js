const { TFile, TFolder, normalizePath } = require('obsidian');

function validateVaultExportPath(rawPath) {
  const value = String(rawPath || '')
    .trim()
    .replace(/\\/g, '/');
  if (!value || value.startsWith('/') || value.startsWith('~') || /^[a-z][\w+.-]*:/i.test(value)) {
    throw new Error('Use a path inside the vault, not an absolute path or URL');
  }
  const parts = value.split('/').filter(Boolean);
  if (
    parts.some(
      (part) =>
        part.startsWith('.') ||
        /[<>:"|?*]/u.test(part) ||
        /[. ]$/u.test(part) ||
        Array.from(part).some((char) => char.charCodeAt(0) < 32)
    )
  ) {
    throw new Error(
      'Use visible vault folders without parent traversal or invalid filename characters'
    );
  }
  if (parts.some((part) => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('This filename is reserved on Windows');
  }
  return normalizePath(value);
}

function withHtmlExtension(path) {
  return /\.html?$/iu.test(path) ? path : path.replace(/\.[^/.]+$/u, '') + '.html';
}

function buildVaultExportPath(rawFilename, rawFolder = '') {
  const filename = String(rawFilename || '').trim();
  if (!filename) throw new Error('Enter a filename');
  validateVaultExportPath(filename);
  if (/[\\/]/u.test(filename)) throw new Error('Put folders in the folder field, not the filename');
  const folder = String(rawFolder || '').trim();
  const parent = folder ? `${validateVaultExportPath(folder)}/` : '';
  return validateVaultExportPath(`${parent}${withHtmlExtension(filename)}`);
}

function resolveVaultExportPath(vault, rawPath) {
  let target = validateVaultExportPath(rawPath);
  if (
    /[\\/]$/u.test(String(rawPath).trim()) ||
    vault.getAbstractFileByPath(target) instanceof TFolder
  ) {
    target = `${target}/graphfrontier-static.html`;
  } else target = withHtmlExtension(target);
  return target;
}

const exportQueues = new WeakMap();

function writeVaultExport(vault, target, html, options = {}) {
  // Serialize our exports so overwrite checks also cover concurrent MCP requests.
  const previous = exportQueues.get(vault) || Promise.resolve();
  const pending = previous.catch(() => {}).then(() => writeExport(vault, target, html, options));
  exportQueues.set(vault, pending);
  const cleanup = () => {
    if (exportQueues.get(vault) === pending) exportQueues.delete(vault);
  };
  pending.then(cleanup, cleanup);
  return pending;
}

async function writeExport(vault, target, html, options) {
  // Storage stays with Obsidian's public Vault API on every platform.
  validateVaultExportPath(target);
  options.assertCurrent?.();
  const folders = target.split('/').slice(0, -1);
  let parent = '';
  for (const part of folders) {
    parent = parent ? `${parent}/${part}` : part;
    let entry = vault.getAbstractFileByPath(parent);
    if (!entry) {
      try {
        options.assertCurrent?.();
        await vault.createFolder(parent);
      } catch (error) {
        if (!(vault.getAbstractFileByPath(parent) instanceof TFolder)) throw error;
      }
      entry = vault.getAbstractFileByPath(parent);
    }
    if (!(entry instanceof TFolder)) throw new Error(`Not a folder: ${parent}`);
  }
  options.assertCurrent?.();
  const existing = vault.getAbstractFileByPath(target);
  if (existing && options.overwrite === false) throw new Error('Export already exists');
  if (existing instanceof TFile) await vault.modify(existing, html);
  else if (!existing) await vault.create(target, html);
  else throw new Error('The export filename points to a folder');
}

module.exports = { buildVaultExportPath, resolveVaultExportPath, writeVaultExport };
