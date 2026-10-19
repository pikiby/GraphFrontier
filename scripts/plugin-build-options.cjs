const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { builtinModules } = require('node:module');

const ROOT = path.resolve(__dirname, '..');
const ZOD_ROOT = path.dirname(require.resolve('zod/package.json'));
const SDK_ROOT = path.resolve(
  path.dirname(require.resolve('@modelcontextprotocol/sdk/server/mcp.js')),
  '../../..'
);
const ADAPTER = path.join(__dirname, 'adapters/mcp-ajv-provider.cjs');

// Reviewed Zod 4.6.7 / SDK 1.32.1 sources. Dependency changes require an explicit
// review of these narrow adaptations, never a best-effort text substitution.
const ZOD_HASHES = {
  'doc.cjs': '920b37602309434c783ecd326141418dbb0e2eff560e42cb1b85a91f4fdd9cc4',
  'doc.js': 'be4c1b1a1ad247cc70f360a572060edd7e0cea24252c3a319f33d247899c5643',
  'util.cjs': 'c7fd0ee0303e7344463692d0936d59c982ed28bb1b73dbd97d2b887ae15d80f1',
  'util.js': 'bb08133b11b478c8e715038fff26ebea204d7fd5443fba31fe138b142d202efb',
  'compile.cjs': '53920c324ac3709a099d2b608398699a6160211738c9ced6473065d9509b7b61',
  'compile.js': '53fcf24821f50ecf42492ab7101abe8a50ead8286a53567d71648fe5ca346b99',
};
const SDK_PROVIDER_HASHES = {
  cjs: '697c11d91d249750a3e44d4423c415264f102631b4fe755ff998ccc9b8402bff',
  esm: '1893726b2b43d0688e8c37ce48b3c5f87a55eb93ca370433f882ae81c09c491a',
};

function verifySource(source, expected, label) {
  if (!expected || createHash('sha256').update(source).digest('hex') !== expected) {
    throw new Error(`Unreviewed no-dynamic-code dependency source: ${label}`);
  }
}

function replaceSection(source, start, end, replacement) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (
    from < 0 ||
    to < 0 ||
    source.indexOf(start, from + start.length) !== -1 ||
    source.indexOf(end, to + end.length) !== -1
  ) {
    throw new Error('No-dynamic-code transform boundaries do not match reviewed source');
  }
  return source.slice(0, from) + replacement + source.slice(to);
}

function transformZodModule(filename, source) {
  verifySource(source, ZOD_HASHES[filename], `zod/v4/core/${filename}`);
  const esm = filename.endsWith('.js');
  if (filename.startsWith('doc.')) {
    return replaceSection(
      source,
      '    compile() {',
      '\n    }\n}',
      '    compile() {\n        throw new Error("Dynamic schema compilation is disabled in GraphFrontier");'
    );
  }
  if (filename.startsWith('util.')) {
    return replaceSection(
      source,
      esm
        ? 'export const allowsEval = /* @__PURE__*/ cached(() => {'
        : 'exports.allowsEval = cached(() => {',
      esm ? 'export function isPlainObject' : 'function isPlainObject',
      `${esm ? 'export const' : 'exports.'}${esm ? ' allowsEval' : 'allowsEval'} = cached(() => false);\n`
    );
  }
  return replaceSection(
    source,
    `${esm ? 'export ' : ''}function compileFn(schema, options) {`,
    'function addConstant(ctx, value) {',
    `${esm ? 'export ' : ''}function compileFn(schema, options) {\n    throw new ZodCompileUnsupportedError("dynamic compilation in GraphFrontier", false);\n}\n`
  );
}

function noDynamicCodePlugin() {
  return {
    name: 'graphfrontier-no-dynamic-code',
    setup(build) {
      build.onStart(() => {
        for (const [root, expected] of [
          [ZOD_ROOT, '4.6.7'],
          [SDK_ROOT, '1.32.1'],
        ]) {
          const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
          if (pkg.version !== expected)
            throw new Error(`Unreviewed ${pkg.name} version: ${pkg.version}`);
        }
      });
      build.onResolve(
        { filter: /ajv-provider\.js$|^@modelcontextprotocol\/sdk\/validation\/ajv$/ },
        (args) => {
          const resolved = args.path.startsWith('@')
            ? require.resolve(args.path)
            : path.resolve(args.resolveDir, args.path);
          for (const format of ['cjs', 'esm']) {
            const provider = path.join(SDK_ROOT, 'dist', format, 'validation/ajv-provider.js');
            if (resolved !== provider) continue;
            verifySource(fs.readFileSync(provider, 'utf8'), SDK_PROVIDER_HASHES[format], provider);
            return { path: ADAPTER };
          }
          return null;
        }
      );
      build.onResolve({ filter: /^ajv(?:\/|$)|^ajv-formats(?:\/|$)/ }, () => {
        throw new Error('AJV must not enter the no-dynamic-code plugin bundle');
      });
      build.onLoad(
        { filter: /[\\/]zod[\\/]v4[\\/]core[\\/](?:doc|util|compile)\.(?:cjs|js)$/ },
        (args) => {
          if (path.dirname(args.path) !== path.join(ZOD_ROOT, 'v4/core')) {
            throw new Error(`Unexpected Zod installation: ${args.path}`);
          }
          return {
            contents: transformZodModule(
              path.basename(args.path),
              fs.readFileSync(args.path, 'utf8')
            ),
            loader: 'js',
          };
        }
      );
    },
  };
}

function createPluginBuildOptions({ production = false } = {}) {
  return {
    absWorkingDir: ROOT,
    entryPoints: ['src/main.js'],
    bundle: true,
    external: ['obsidian', ...builtinModules, 'node:*'],
    format: 'cjs',
    platform: 'browser',
    target: 'es2018',
    sourcemap: production ? false : 'inline',
    minify: false,
    logLevel: 'info',
    outdir: 'dist',
    plugins: [noDynamicCodePlugin()],
  };
}

module.exports = { createPluginBuildOptions, transformZodModule };
