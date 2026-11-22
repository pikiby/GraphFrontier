'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_VSIX_ENTRIES = [
  '[Content_Types].xml',
  'extension.vsixmanifest',
  'extension/package.json',
  'extension/readme.md',
  'extension/changelog.md',
  'extension/LICENSE.txt',
  'extension/media/icon.png',
  'extension/media/activity-icon.svg',
  'extension/dist/extension.cjs',
  'extension/dist/webview-bundle.js',
  'extension/dist/webview.css',
];

const FORBIDDEN_VSIX_PREFIXES = [
  'extension/src/',
  'extension/tests/',
  'extension/scripts/',
  'extension/node_modules/',
];

const FORBIDDEN_VSIX_EXACT = new Set(['extension/dist/workspace-controller.cjs']);

function listZipEntries(zipPath) {
  const buf = fs.readFileSync(zipPath);
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error(`${zipPath}: missing ZIP end of central directory`);
  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  let ptr = cdOffset;
  const names = [];
  for (let i = 0; i < totalEntries; i++) {
    if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== 0x02014b50) {
      throw new Error(`${zipPath}: invalid ZIP central directory header at ${ptr}`);
    }
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
    names.push(name);
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

function checkVscodeRelease(rootDir, { tag } = {}) {
  const vscodeDir = path.join(rootDir, 'packages', 'vscode');
  const standaloneDir = path.join(rootDir, 'packages', 'standalone');
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const readJson = (filePath, label) => {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    check(
      value !== null && typeof value === 'object' && !Array.isArray(value),
      `${label}: expected JSON object`
    );
    return value;
  };

  const rootPkg = readJson(path.join(rootDir, 'package.json'), 'package.json');
  const standalonePkg = readJson(
    path.join(standaloneDir, 'package.json'),
    'packages/standalone/package.json'
  );
  const pkg = readJson(path.join(vscodeDir, 'package.json'), 'packages/vscode/package.json');
  const version = pkg.version;

  check(
    typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version),
    'packages/vscode/package.json: expected x.y.z version'
  );
  check(
    pkg.private !== true,
    'packages/vscode/package.json: must not set "private": true for Marketplace/Open VSX publishing'
  );
  check(
    typeof pkg.publisher === 'string' && pkg.publisher.trim().length > 0,
    'packages/vscode/package.json: missing publisher'
  );
  check(
    typeof pkg.displayName === 'string' && pkg.displayName.trim().length > 0,
    'packages/vscode/package.json: missing displayName'
  );
  check(
    typeof pkg.license === 'string' && pkg.license.trim().length > 0,
    'packages/vscode/package.json: missing license'
  );
  check(
    typeof pkg.engines?.vscode === 'string' && pkg.engines.vscode.trim().length > 0,
    'packages/vscode/package.json: missing engines.vscode'
  );
  check(
    Boolean(typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url),
    'packages/vscode/package.json: missing repository URL'
  );
  check(
    typeof pkg.homepage === 'string' && pkg.homepage.startsWith('http'),
    'packages/vscode/package.json: missing homepage URL'
  );
  check(
    typeof pkg.bugs?.url === 'string' && pkg.bugs.url.startsWith('http'),
    'packages/vscode/package.json: missing bugs URL'
  );
  check(
    Array.isArray(pkg.keywords) && pkg.keywords.length > 0,
    'packages/vscode/package.json: missing keywords'
  );
  check(
    pkg.galleryBanner?.color && pkg.galleryBanner?.theme,
    'packages/vscode/package.json: missing galleryBanner'
  );
  check(
    standalonePkg.version === version,
    `packages/standalone/package.json (${standalonePkg.version}) must match VS Code version (${version})`
  );

  const isStandaloneVscodeTag = typeof tag === 'string' && /^vscode-/.test(tag);
  if (!isStandaloneVscodeTag) {
    check(
      version === rootPkg.version,
      `packages/vscode/package.json (${version}) must match root GraphFrontier version (${rootPkg.version})`
    );
  }

  if (tag !== undefined) {
    const normalizedTag = tag.replace(/^vscode-(?:v)?/, '');
    check(
      normalizedTag === version,
      `Release tag ${JSON.stringify(tag)} (normalized ${normalizedTag}) must match packages/vscode/package.json (${version})`
    );
  }

  const changelog = fs.readFileSync(path.join(vscodeDir, 'CHANGELOG.md'), 'utf8');
  check(
    changelog.includes(`## ${version}`),
    `packages/vscode/CHANGELOG.md must contain section "## ${version}"`
  );

  const requiredFiles = [
    'README.md',
    'LICENSE.txt',
    '.vscodeignore',
    'media/icon.png',
    'media/activity-icon.svg',
    'dist/extension.cjs',
    'dist/webview-bundle.js',
    'dist/webview.css',
    `dist/${pkg.name}-${version}.vsix`,
  ];
  for (const rel of requiredFiles) {
    const target = path.join(vscodeDir, rel);
    const stat = fs.statSync(target, { throwIfNoEntry: false });
    check(stat?.isFile() && stat.size > 0, `packages/vscode/${rel}: expected a non-empty file`);
  }

  const vsixPath = path.join(vscodeDir, 'dist', `${pkg.name}-${version}.vsix`);
  const entries = listZipEntries(vsixPath);
  const entrySetLower = new Set(entries.map((entry) => entry.toLowerCase()));
  for (const reqEntry of REQUIRED_VSIX_ENTRIES) {
    check(
      entrySetLower.has(reqEntry.toLowerCase()),
      `${vsixPath}: missing required VSIX entry ${reqEntry}`
    );
  }
  for (const entry of entries) {
    const lower = entry.toLowerCase();
    for (const prefix of FORBIDDEN_VSIX_PREFIXES) {
      check(
        !lower.startsWith(prefix.toLowerCase()),
        `${vsixPath}: forbidden dev entry in VSIX (${entry})`
      );
    }
    check(!FORBIDDEN_VSIX_EXACT.has(lower), `${vsixPath}: forbidden test-only entry (${entry})`);
  }

  return { version, vsixPath, entryCount: entries.length };
}

if (require.main === module) {
  try {
    if (process.argv.length > 3) {
      throw new Error('Usage: node packages/vscode/scripts/check-vscode-release.cjs [tag]');
    }
    const rootDir = path.resolve(__dirname, '..', '..', '..');
    const info = checkVscodeRelease(rootDir, { tag: process.argv[2] });
    console.log(
      `VS Code release package is valid (${info.version}, ${info.entryCount} ZIP entries).`
    );
  } catch (error) {
    console.error(`VS Code release check failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { checkVscodeRelease, listZipEntries };
