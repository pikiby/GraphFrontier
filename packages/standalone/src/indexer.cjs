'use strict';

const fs = require('node:fs');
const path = require('node:path');

function toPosix(relPath) {
  return String(relPath || '')
    .split(path.sep)
    .join('/');
}

function compileIgnoreFilters(vaultDir) {
  const appJsonPath = path.join(vaultDir, '.obsidian', 'app.json');
  let rawFilters = [];
  try {
    if (fs.existsSync(appJsonPath)) {
      const appCfg = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
      if (Array.isArray(appCfg?.userIgnoreFilters)) rawFilters = appCfg.userIgnoreFilters;
    }
  } catch {
    // Ignore malformed .obsidian/app.json.
  }

  const matchers = [];
  for (const item of rawFilters) {
    if (typeof item !== 'string' || !item.trim()) continue;
    const trimmed = item.trim();
    const regexMatch = /^\/(.+)\/([a-z]*)$/i.exec(trimmed);
    if (regexMatch) {
      try {
        const re = new RegExp(regexMatch[1], regexMatch[2]);
        matchers.push((rel) => re.test(rel));
        continue;
      } catch {
        // Fall back to prefix match if regex syntax is invalid.
      }
    }
    const clean = trimmed.replace(/^\/+|\/+$/g, '');
    if (!clean) continue;
    matchers.push((rel) => rel === clean || rel.startsWith(`${clean}/`) || rel.startsWith(trimmed));
  }
  return matchers;
}

function walkVault(vaultDir) {
  const rootDir = path.resolve(vaultDir);
  const ignoreMatchers = compileIgnoreFilters(rootDir);
  const files = [];
  const visitedDirs = new Set();
  try {
    visitedDirs.add(fs.realpathSync(rootDir));
  } catch {
    return files;
  }

  function isIgnored(rel) {
    return ignoreMatchers.some((fn) => fn(rel));
  }

  function walk(absDir, relPrefix) {
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = entry.name;
      if (!name || name.startsWith('.') || name === 'node_modules') continue;
      const rel = relPrefix ? `${relPrefix}/${name}` : name;
      if (isIgnored(rel)) continue;
      const fullPath = path.join(absDir, name);

      let stat;
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          stat = fs.statSync(fullPath);
          isDir = stat.isDirectory();
          isFile = stat.isFile();
        } catch {
          continue;
        }
      }

      if (isDir) {
        if (entry.isSymbolicLink()) {
          try {
            const real = fs.realpathSync(fullPath);
            if (visitedDirs.has(real)) continue;
            visitedDirs.add(real);
          } catch {
            continue;
          }
        }
        walk(fullPath, rel);
      } else if (isFile) {
        if (!stat) {
          try {
            stat = fs.statSync(fullPath);
          } catch {
            continue;
          }
        }
        files.push({
          path: toPosix(rel),
          ctime: Math.round(stat.birthtimeMs || stat.ctimeMs || 0),
          mtime: Math.round(stat.mtimeMs || 0),
          size: stat.size || 0,
        });
      }
    }
  }

  walk(rootDir, '');
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

function parseYamlScalar(raw) {
  const s = raw.trim();
  if (!s || s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    return s.slice(1, -1);
  }
  if (/^-?\d+(?:\.\d+)?$/.test(s)) {
    const num = Number(s);
    if (Number.isFinite(num)) return num;
  }
  return s;
}

function splitInlineYamlList(inner) {
  const items = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      current += ch;
      if (ch === quote && inner[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ',') {
      if (current.trim()) items.push(parseYamlScalar(current));
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) items.push(parseYamlScalar(current));
  return items;
}

function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return { frontmatter: null, body: text };

  const yamlText = match[1];
  const body = text.slice(match[0].length);
  const frontmatter = {};
  const lines = yamlText.split(/\r?\n/);
  let currentKey = null;
  let currentType = null; // 'list' | 'object' | 'scalar'

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;

    const listMatch = /^\s*-\s*(.*)$/.exec(line);
    if (listMatch && currentKey) {
      if (!Array.isArray(frontmatter[currentKey])) {
        frontmatter[currentKey] = [];
      }
      const itemVal = parseYamlScalar(listMatch[1]);
      if (itemVal !== null && itemVal !== '') {
        frontmatter[currentKey].push(itemVal);
      }
      currentType = 'list';
      continue;
    }

    const nestedKv = /^\s+([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (nestedKv && currentKey) {
      if (
        !frontmatter[currentKey] ||
        typeof frontmatter[currentKey] !== 'object' ||
        Array.isArray(frontmatter[currentKey])
      ) {
        frontmatter[currentKey] = {};
      }
      frontmatter[currentKey][nestedKv[1]] = parseYamlScalar(nestedKv[2]);
      currentType = 'object';
      continue;
    }

    const kv = /^([^\s:][^:]*?)\s*:\s*(.*)$/.exec(line);
    if (kv) {
      const key = kv[1].trim().replace(/^["']|["']$/g, '');
      const val = kv[2].trim();
      currentKey = key;
      if (!val) {
        frontmatter[key] = null;
        currentType = 'pending';
      } else if (val.startsWith('[') && val.endsWith(']')) {
        const inner = val.slice(1, -1).trim();
        frontmatter[key] = inner ? splitInlineYamlList(inner) : [];
        currentType = 'list';
        currentKey = null;
      } else {
        frontmatter[key] = parseYamlScalar(val);
        currentType = 'scalar';
        currentKey = null;
      }
      continue;
    }

    if (/^\s+/.test(line) && currentKey && currentType === 'scalar') {
      const prev = frontmatter[currentKey];
      frontmatter[currentKey] = prev ? `${prev} ${line.trim()}` : line.trim();
    }
  }

  return {
    frontmatter: Object.keys(frontmatter).length ? frontmatter : null,
    body,
  };
}

function stripFencedCode(body) {
  return body.replace(/^(?:`{3,}|~{3,})[^\n]*\n[\s\S]*?^(?:`{3,}|~{3,})[^\n]*$/gm, (m) =>
    '\n'.repeat((m.match(/\n/g) || []).length)
  );
}

function stripInlineCodeAndComments(withoutFences) {
  let clean = withoutFences.replace(/`+[^`\n]+`+/g, '');
  clean = clean.replace(/<!--[\s\S]*?-->/g, '');
  return clean;
}

function extractFrontmatterLinkTargets(frontmatter) {
  const targets = [];
  if (!frontmatter || typeof frontmatter !== 'object') return targets;
  const visit = (val) => {
    if (typeof val === 'string') {
      for (const m of val.matchAll(/!?\[\[([^\]\n]+)\]\]/g)) {
        targets.push({ rawTarget: m[1], isMarkdownLink: false });
      }
    } else if (Array.isArray(val)) {
      for (const item of val) visit(item);
    } else if (val && typeof val === 'object') {
      for (const item of Object.values(val)) visit(item);
    }
  };
  visit(frontmatter);
  return targets;
}

function extractMarkdownMetadata(text) {
  const { frontmatter, body } = parseFrontmatter(String(text || ''));
  const withoutFences = stripFencedCode(body);
  const clean = stripInlineCodeAndComments(withoutFences);

  const headings = [];
  for (const line of withoutFences.split(/\r?\n/)) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (m) {
      headings.push({
        heading: m[2].replace(/\s+#+$/, '').trim(),
        level: m[1].length,
      });
    }
  }

  const linkTargets = extractFrontmatterLinkTargets(frontmatter);
  for (const m of clean.matchAll(/!?\[\[([^\]\n]+)\]\]/g)) {
    linkTargets.push({ rawTarget: m[1], isMarkdownLink: false });
  }
  for (const m of clean.matchAll(/!?\[[^\]]*\]\(([^)\n]+)\)/g)) {
    let rawUrl = m[1].trim();
    if (rawUrl.startsWith('<') && rawUrl.includes('>')) {
      rawUrl = rawUrl.slice(1, rawUrl.indexOf('>'));
    } else {
      rawUrl = rawUrl.split(/\s+/)[0];
    }
    linkTargets.push({ rawTarget: rawUrl, isMarkdownLink: true });
  }

  // Strip links and URLs before scanning inline hashtags so URL fragments (#section) are ignored.
  const withoutLinks = clean
    .replace(/!?\[[^\]]*\]\([^)\n]*\)/g, ' ')
    .replace(/!?\[\[[^\]\n]*\]\]/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ');

  const seenTags = new Set();
  const tags = [];
  for (const m of withoutLinks.matchAll(
    /(?:^|\s)(#(?:[A-Za-zА-Яа-яЁё0-9_/-]*[A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё0-9_/-]*))/gm
  )) {
    const tag = m[1];
    if (!seenTags.has(tag)) {
      seenTags.add(tag);
      tags.push({ tag });
    }
  }

  const cache = {};
  if (tags.length) cache.tags = tags;
  if (frontmatter) cache.frontmatter = frontmatter;
  if (headings.length) cache.headings = headings;
  return { cache, linkTargets };
}

function buildFileIndex(files) {
  const byLowerPath = new Map();
  const byLowerNoExt = new Map();
  const byLowerBase = new Map();
  const byLowerBaseNoExt = new Map();
  const push = (map, key, value) => {
    let list = map.get(key);
    if (!list) {
      list = [];
      map.set(key, list);
    }
    list.push(value);
  };
  for (const file of files) {
    const p = file.path;
    const lp = p.toLowerCase();
    byLowerPath.set(lp, p);
    const base = p.split('/').pop();
    push(byLowerBase, base.toLowerCase(), p);
    if (lp.endsWith('.md')) {
      byLowerNoExt.set(lp.slice(0, -3), p);
      push(byLowerBaseNoExt, base.slice(0, -3).toLowerCase(), p);
    }
  }
  return { byLowerPath, byLowerNoExt, byLowerBase, byLowerBaseNoExt };
}

function pickBestCandidate(candidates, exactTarget = '') {
  if (candidates.length === 1) return candidates[0];
  const exactSuffixMd = exactTarget ? `/${exactTarget}.md` : '';
  const exactSuffixRaw = exactTarget ? `/${exactTarget}` : '';
  const exactScore = (p) => {
    if (!exactTarget) return 0;
    if (p === `${exactTarget}.md` || p === exactTarget) return 2;
    if (p.endsWith(exactSuffixMd) || p.endsWith(exactSuffixRaw)) return 1;
    return 0;
  };
  return [...candidates].sort((a, b) => {
    const ea = exactScore(a);
    const eb = exactScore(b);
    if (ea !== eb) return eb - ea;
    const ad = a.split('/').length;
    const bd = b.split('/').length;
    if (ad !== bd) return ad - bd;
    if (a.length !== b.length) return a.length - b.length;
    return a.localeCompare(b);
  })[0];
}

function resolveLinkpath(rawTarget, sourcePath, fileIndex, isMarkdownLink = false) {
  let t = String(rawTarget || '')
    .trim()
    .replace(/\\\|/g, '|');
  if (!isMarkdownLink) {
    const pipeIdx = t.indexOf('|');
    if (pipeIdx !== -1) t = t.slice(0, pipeIdx);
  }
  const hashIdx = t.indexOf('#');
  if (hashIdx !== -1) t = t.slice(0, hashIdx);
  try {
    t = decodeURIComponent(t);
  } catch {
    // Keep malformed percent sequences untouched.
  }
  t = t.trim().replace(/\\/g, '/');
  if (!t) return { resolved: sourcePath };
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return { external: true };
  if (isMarkdownLink && !t.includes('/') && !t.includes('.')) return { external: true };

  const { byLowerPath, byLowerNoExt, byLowerBase, byLowerBaseNoExt } = fileIndex;
  const srcDir = sourcePath.includes('/') ? sourcePath.slice(0, sourcePath.lastIndexOf('/')) : '';

  if (t.startsWith('./') || t.startsWith('../')) {
    const joined = path.posix.normalize(srcDir ? `${srcDir}/${t}` : t).toLowerCase();
    if (joined.startsWith('..')) return { unresolved: t };
    if (byLowerPath.has(joined)) return { resolved: byLowerPath.get(joined) };
    if (byLowerNoExt.has(joined)) return { resolved: byLowerNoExt.get(joined) };
    return { unresolved: t };
  }

  const lt = t.toLowerCase().replace(/^\/+/, '');
  if (!lt) return { unresolved: t };

  // Root exact match before relative-to-source folder (matches Obsidian shortest/absolute rules).
  if (byLowerPath.has(lt)) return { resolved: byLowerPath.get(lt) };
  if (byLowerNoExt.has(lt)) return { resolved: byLowerNoExt.get(lt) };

  if (srcDir) {
    const rel = path.posix.normalize(`${srcDir}/${t}`).toLowerCase();
    if (!rel.startsWith('..')) {
      if (byLowerPath.has(rel)) return { resolved: byLowerPath.get(rel) };
      if (byLowerNoExt.has(rel)) return { resolved: byLowerNoExt.get(rel) };
    }
  }

  if (!t.includes('/')) {
    if (byLowerBaseNoExt.has(lt)) {
      return { resolved: pickBestCandidate(byLowerBaseNoExt.get(lt), t.replace(/\.md$/i, '')) };
    }
    if (byLowerBase.has(lt)) {
      return { resolved: pickBestCandidate(byLowerBase.get(lt), t) };
    }
  } else {
    const matches = [];
    for (const [noExt, full] of byLowerNoExt.entries()) {
      if (noExt.endsWith(`/${lt}`)) matches.push(full);
    }
    for (const [lp, full] of byLowerPath.entries()) {
      if (lp.endsWith(`/${lt}`)) matches.push(full);
    }
    if (matches.length) {
      return { resolved: pickBestCandidate(matches, t) };
    }
  }

  const normalizedUnresolved = t.replace(/\.md$/i, '').replace(/^\/+/, '');
  return normalizedUnresolved ? { unresolved: normalizedUnresolved } : null;
}

function extractCanvasTargets(text) {
  try {
    const data = JSON.parse(text);
    if (!data || !Array.isArray(data.nodes)) return [];
    const targets = [];
    for (const node of data.nodes) {
      if (node && node.type === 'file' && typeof node.file === 'string' && node.file.trim()) {
        targets.push({ rawTarget: node.file.trim(), isMarkdownLink: false });
      }
    }
    return targets;
  } catch {
    return [];
  }
}

function loadVaultAppearance(vaultDir) {
  const rootDir = path.resolve(vaultDir);
  const appearancePath = path.join(rootDir, '.obsidian', 'appearance.json');
  let appearance = {};
  try {
    if (fs.existsSync(appearancePath)) {
      appearance = JSON.parse(fs.readFileSync(appearancePath, 'utf8')) || {};
    }
  } catch {
    appearance = {};
  }

  const bodyClasses = [appearance.theme === 'moonstone' ? 'theme-light' : 'theme-dark'];
  const cssParts = [];
  let themeName = '';

  if (typeof appearance.cssTheme === 'string' && appearance.cssTheme.trim()) {
    const name = appearance.cssTheme.trim();
    const themeCssPath = path.join(rootDir, '.obsidian', 'themes', name, 'theme.css');
    try {
      if (fs.existsSync(themeCssPath)) {
        cssParts.push(`/* Obsidian Theme: ${name} */\n${fs.readFileSync(themeCssPath, 'utf8')}`);
        themeName = name;
      }
    } catch {
      // Ignore unreadable theme file.
    }
  }

  if (Array.isArray(appearance.enabledCssSnippets)) {
    for (const snippet of appearance.enabledCssSnippets) {
      if (typeof snippet !== 'string' || !snippet.trim()) continue;
      const snippetPath = path.join(rootDir, '.obsidian', 'snippets', `${snippet.trim()}.css`);
      try {
        if (fs.existsSync(snippetPath)) {
          cssParts.push(
            `/* Snippet: ${snippet.trim()} */\n${fs.readFileSync(snippetPath, 'utf8')}`
          );
        }
      } catch {
        // Ignore unreadable snippet file.
      }
    }
  }

  return {
    bodyClasses,
    themeName,
    vaultThemeCss: cssParts.join('\n\n'),
  };
}

function indexVault(vaultDir) {
  const rootDir = path.resolve(vaultDir);
  const files = walkVault(rootDir);
  const fileIndex = buildFileIndex(files);
  const caches = {};
  const resolvedLinks = {};
  const unresolvedLinks = {};

  for (const file of files) {
    const lower = file.path.toLowerCase();
    const isMd = lower.endsWith('.md');
    const isCanvas = lower.endsWith('.canvas');
    if (!isMd && !isCanvas) continue;

    let text;
    try {
      text = fs.readFileSync(path.join(rootDir, file.path), 'utf8');
    } catch {
      continue;
    }

    let targets;
    if (isMd) {
      const meta = extractMarkdownMetadata(text);
      caches[file.path] = meta.cache;
      targets = meta.linkTargets;
    } else {
      targets = extractCanvasTargets(text);
    }

    const resMap = {};
    const unresMap = {};
    for (const item of targets) {
      const outcome = resolveLinkpath(item.rawTarget, file.path, fileIndex, item.isMarkdownLink);
      if (!outcome || outcome.external) continue;
      if (outcome.resolved) {
        if (isMd || outcome.resolved !== file.path) {
          resMap[outcome.resolved] = (resMap[outcome.resolved] || 0) + 1;
        }
      } else if (outcome.unresolved && isMd) {
        unresMap[outcome.unresolved] = (unresMap[outcome.unresolved] || 0) + 1;
      }
    }
    if (isMd) {
      resolvedLinks[file.path] = resMap;
      unresolvedLinks[file.path] = unresMap;
    } else if (Object.keys(resMap).length) {
      resolvedLinks[file.path] = resMap;
    }
  }

  const appearance = loadVaultAppearance(rootDir);

  return {
    vaultName: path.basename(rootDir) || 'Vault',
    files,
    fileIndex,
    caches,
    resolvedLinks,
    unresolvedLinks,
    bodyClasses: appearance.bodyClasses,
    themeName: appearance.themeName,
    vaultThemeCss: appearance.vaultThemeCss,
  };
}

module.exports = {
  walkVault,
  parseFrontmatter,
  extractMarkdownMetadata,
  buildFileIndex,
  resolveLinkpath,
  loadVaultAppearance,
  indexVault,
};
