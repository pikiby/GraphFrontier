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

function resolveMobileExportPath(vault, rawPath) {
  let target = validateVaultExportPath(rawPath);
  if (
    /[\\/]$/u.test(String(rawPath).trim()) ||
    vault.getAbstractFileByPath(target) instanceof TFolder
  ) {
    target = `${target}/graphfrontier-static.html`;
  } else if (!/\.html?$/iu.test(target)) {
    target = target.replace(/\.[^/.]+$/u, '') + '.html';
  }
  return target;
}

async function writeMobileExport(vault, target, html) {
  // Use the public Vault API so Obsidian's mobile adapter handles storage.
  validateVaultExportPath(target);
  const folders = target.split('/').slice(0, -1);
  let parent = '';
  for (const part of folders) {
    parent = parent ? `${parent}/${part}` : part;
    let entry = vault.getAbstractFileByPath(parent);
    if (!entry) {
      try {
        await vault.createFolder(parent);
      } catch (error) {
        if (!(vault.getAbstractFileByPath(parent) instanceof TFolder)) throw error;
      }
      entry = vault.getAbstractFileByPath(parent);
    }
    if (!(entry instanceof TFolder)) throw new Error(`Not a folder: ${parent}`);
  }
  const existing = vault.getAbstractFileByPath(target);
  if (existing instanceof TFile) await vault.modify(existing, html);
  else if (!existing) await vault.create(target, html);
  else throw new Error('The export filename points to a folder');
}

module.exports = { resolveMobileExportPath, writeMobileExport };
