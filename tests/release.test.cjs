const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { checkRelease } = require('../scripts/check-release.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'graphfrontier-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, value) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
  };
  const edit = (file, update) => {
    const value = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    update(value);
    write(file, value);
  };
  const manifest = {
    id: 'graphfrontier',
    name: 'GraphFrontier',
    version: '0.7.1',
    minAppVersion: '1.4.0',
    author: 'Boris Kazakov (pikiby)',
    authorUrl: 'https://github.com/pikiby',
    fundingUrl: 'https://buymeacoffee.com/pikiby',
    description: 'Release checker fixture',
    isDesktopOnly: false,
  };
  const versions = { '0.7.0': '1.4.0', '0.7.1': '1.4.0' };
  write('package.json', { name: 'graphfrontier', version: '0.7.1', main: 'dist/main.js' });
  write('package-lock.json', {
    name: 'graphfrontier',
    version: '0.7.1',
    lockfileVersion: 3,
    packages: { '': { name: 'graphfrontier', version: '0.7.1' } },
  });
  for (const directory of ['', 'src/static', 'dist']) {
    write(path.join(directory, 'manifest.json'), manifest);
    write(path.join(directory, 'versions.json'), versions);
  }
  write('dist/main.js', 'module.exports = {};\n');
  write('src/static/styles.css', '.graphfrontier {}\n');
  write('dist/styles.css', '.graphfrontier {}\n');
  write('LICENSE', 'MIT fixture license\n');
  write('dist/LICENSE', 'MIT fixture license\n');
  return { root, write, edit };
}

test('accepts consistent metadata and assets with an optional exact tag', (t) => {
  const { root } = fixture(t);
  assert.equal(checkRelease(root), '0.7.1');
  assert.equal(checkRelease(root, { tag: '0.7.1' }), '0.7.1');
});

test('compares metadata semantically, not by JSON whitespace or key order', (t) => {
  const { root, write, edit } = fixture(t);
  edit('src/static/manifest.json', (value) => {
    const entries = Object.entries(value).reverse();
    write('dist/manifest.json', JSON.stringify(Object.fromEntries(entries), null, 2));
  });
  assert.equal(checkRelease(root), '0.7.1');
});

for (const tag of ['v0.7.1', '0.7.2', '', '0.7.1\n']) {
  test(`rejects nonmatching tag ${JSON.stringify(tag)}`, (t) => {
    const { root } = fixture(t);
    assert.throws(() => checkRelease(root, { tag }), /Release tag .* must exactly match/);
  });
}

for (const [label, file, update, message] of [
  [
    'package version',
    'package.json',
    (value) => {
      value.version = '0.7.2';
    },
    /package-lock.json: version/,
  ],
  [
    'invalid package version',
    'package.json',
    (value) => {
      value.version = '';
    },
    /expected an x.y.z version/,
  ],
  [
    'package entry point',
    'package.json',
    (value) => {
      value.main = 'main.js';
    },
    /main must be dist\/main.js/,
  ],
  [
    'lock version',
    'package-lock.json',
    (value) => {
      value.version = '0.7.0';
    },
    /package-lock.json: version/,
  ],
  [
    'lock name',
    'package-lock.json',
    (value) => {
      value.name = 'other';
    },
    /package-lock.json: name/,
  ],
  [
    'lock root version',
    'package-lock.json',
    (value) => {
      value.packages[''].version = '0.7.0';
    },
    /packages\[""\]: version/,
  ],
  [
    'lock root name',
    'package-lock.json',
    (value) => {
      value.packages[''].name = 'other';
    },
    /packages\[""\]: name/,
  ],
  [
    'missing lock root',
    'package-lock.json',
    (value) => {
      delete value.packages[''];
    },
    /packages\[""\]: name/,
  ],
  [
    'manifest version',
    'manifest.json',
    (value) => {
      value.version = '0.7.0';
    },
    /manifest.json: version/,
  ],
  [
    'manifest id',
    'manifest.json',
    (value) => {
      value.id = 'other';
    },
    /manifest.json: id/,
  ],
  [
    'missing author',
    'manifest.json',
    (value) => {
      delete value.author;
    },
    /manifest.json: missing author/,
  ],
  [
    'desktop flag',
    'manifest.json',
    (value) => {
      value.isDesktopOnly = 'false';
    },
    /isDesktopOnly must be boolean/,
  ],
  [
    'missing current compatibility',
    'versions.json',
    (value) => {
      delete value['0.7.1'];
    },
    /0.7.1 must map/,
  ],
  [
    'wrong current compatibility',
    'versions.json',
    (value) => {
      value['0.7.1'] = '1.5.0';
    },
    /0.7.1 must map/,
  ],
]) {
  test(`rejects ${label} drift`, (t) => {
    const { root, edit } = fixture(t);
    edit(file, update);
    assert.throws(() => checkRelease(root), message);
  });
}

for (const directory of ['src/static', 'dist']) {
  for (const field of [
    'version',
    'minAppVersion',
    'author',
    'authorUrl',
    'fundingUrl',
    'description',
  ]) {
    test(`rejects ${directory} manifest ${field} drift`, (t) => {
      const { root, edit } = fixture(t);
      edit(`${directory}/manifest.json`, (value) => {
        value[field] = 'changed';
      });
      assert.throws(() => checkRelease(root), /manifest.json: must match root manifest.json/);
    });
  }
  for (const version of ['0.7.0', '0.7.1']) {
    test(`rejects ${directory} compatibility drift for ${version}`, (t) => {
      const { root, edit } = fixture(t);
      edit(`${directory}/versions.json`, (value) => {
        delete value[version];
      });
      assert.throws(() => checkRelease(root), /versions.json: must match root versions.json/);
    });
  }
}

for (const file of ['main.js', 'manifest.json', 'styles.css', 'versions.json', 'LICENSE']) {
  for (const state of ['missing', 'empty', 'directory']) {
    test(`rejects ${state} dist/${file}`, (t) => {
      const { root, write } = fixture(t);
      const target = path.join(root, 'dist', file);
      if (state === 'empty') {
        write(`dist/${file}`, '');
      } else {
        fs.unlinkSync(target);
        if (state === 'directory') fs.mkdirSync(target);
      }
      assert.throws(
        () => checkRelease(root),
        (error) => error.message.includes(`dist/${file}`)
      );
    });
  }
}

for (const file of ['styles.css', 'LICENSE']) {
  test(`rejects stale dist/${file}`, (t) => {
    const { root, write } = fixture(t);
    write(`dist/${file}`, 'stale content');
    assert.throws(() => checkRelease(root), /must match/);
  });
}

for (const value of ['{broken', 'null', '[]']) {
  test(`reports invalid metadata ${value} with its path`, (t) => {
    const { root, write } = fixture(t);
    write('src/static/manifest.json', value);
    assert.throws(() => checkRelease(root), /src\/static\/manifest.json:/);
  });
}

test('CLI resolves the repository relative to the script and returns useful exit codes', (t) => {
  const { root, write } = fixture(t);
  write(
    'scripts/check-release.cjs',
    fs.readFileSync(require.resolve('../scripts/check-release.cjs'), 'utf8')
  );
  const run = (...args) => {
    const result = spawnSync(
      process.execPath,
      [path.join(root, 'scripts/check-release.cjs'), ...args],
      {
        cwd: os.tmpdir(),
        encoding: 'utf8',
      }
    );
    assert.ifError(result.error);
    return result;
  };
  const success = run('0.7.1');
  assert.equal(success.status, 0, success.stderr);
  assert.match(success.stdout, /consistent \(0.7.1\)/);
  const wrongTag = run('v0.7.1');
  assert.equal(wrongTag.status, 1);
  assert.match(wrongTag.stderr, /Release check failed: Release tag/);
  const invalidUsage = run('0.7.1', 'extra');
  assert.equal(invalidUsage.status, 1);
  assert.match(invalidUsage.stderr, /Usage:/);
  fs.unlinkSync(path.join(root, 'dist/main.js'));
  const missingAsset = run();
  assert.equal(missingAsset.status, 1);
  assert.match(missingAsset.stderr, /Release check failed:.*dist\/main.js/);
});
