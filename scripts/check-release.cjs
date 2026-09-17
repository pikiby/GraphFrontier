const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

function checkRelease(rootDir, { tag } = {}) {
  const resolve = (file) => path.join(rootDir, file);
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const readJson = (file) => {
    let value;
    try {
      value = JSON.parse(fs.readFileSync(resolve(file), 'utf8'));
    } catch (error) {
      throw new Error(`${file}: ${error.message}`);
    }
    check(
      value !== null && typeof value === 'object' && !Array.isArray(value),
      `${file}: expected a JSON object`
    );
    return value;
  };

  const pkg = readJson('package.json');
  const lock = readJson('package-lock.json');
  const manifest = readJson('manifest.json');
  const versions = readJson('versions.json');
  const version = pkg.version;

  check(
    typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version),
    'package.json: expected an x.y.z version'
  );
  check(typeof pkg.name === 'string' && pkg.name.length > 0, 'package.json: missing name');
  check(pkg.main === 'dist/main.js', 'package.json: main must be dist/main.js');
  for (const [file, record] of [
    ['package-lock.json', lock],
    ['package-lock.json packages[""]', lock.packages?.['']],
  ]) {
    check(record?.name === pkg.name, `${file}: name must match package.json`);
    check(record?.version === version, `${file}: version must match package.json (${version})`);
  }

  for (const field of ['id', 'name', 'version', 'minAppVersion', 'description', 'author']) {
    check(
      typeof manifest[field] === 'string' && manifest[field].trim().length > 0,
      `manifest.json: missing ${field}`
    );
  }
  check(
    typeof manifest.isDesktopOnly === 'boolean',
    'manifest.json: isDesktopOnly must be boolean'
  );
  check(manifest.id === pkg.name, 'manifest.json: id must match package.json name');
  check(
    manifest.version === version,
    `manifest.json: version must match package.json (${version})`
  );
  check(
    versions[version] === manifest.minAppVersion,
    `versions.json: ${version} must map to manifest.minAppVersion (${manifest.minAppVersion})`
  );

  // Compare all metadata, including attribution and historical compatibility entries.
  for (const directory of ['src/static', 'dist']) {
    for (const [file, expected] of [
      ['manifest.json', manifest],
      ['versions.json', versions],
    ]) {
      const target = `${directory}/${file}`;
      check(isDeepStrictEqual(readJson(target), expected), `${target}: must match root ${file}`);
    }
  }

  for (const file of ['main.js', 'manifest.json', 'styles.css', 'versions.json', 'LICENSE']) {
    const target = `dist/${file}`;
    const stat = fs.statSync(resolve(target));
    check(stat.isFile() && stat.size > 0, `${target}: expected a non-empty file`);
  }
  for (const [source, target] of [
    ['src/static/styles.css', 'dist/styles.css'],
    ['LICENSE', 'dist/LICENSE'],
  ]) {
    check(
      fs.readFileSync(resolve(source)).equals(fs.readFileSync(resolve(target))),
      `${target}: must match ${source}`
    );
  }
  if (tag !== undefined) {
    check(
      tag === version,
      `Release tag ${JSON.stringify(tag)} must exactly match package.json version (${version})`
    );
  }
  return version;
}

if (require.main === module) {
  try {
    if (process.argv.length > 3) throw new Error('Usage: node scripts/check-release.cjs [tag]');
    const version = checkRelease(path.resolve(__dirname, '..'), { tag: process.argv[2] });
    console.log(`Release metadata and assets are consistent (${version}).`);
  } catch (error) {
    console.error(`Release check failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { checkRelease };
