const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const VIEWER = path.join(ROOT, 'src/viewer');

// Inside the page, modules that need Obsidian's own app or Node are replaced: the Obsidian API by
// the browser one, and the MCP server, external API and backups by empty versions.
const REPLACED = {
  'mcp-settings.js': path.join(VIEWER, 'stubs/mcp-settings.js'),
  'api.js': path.join(VIEWER, 'stubs/api.js'),
  'backups.js': path.join(VIEWER, 'stubs/backups.js'),
};

function viewerResolvePlugin() {
  return {
    name: 'graphfrontier-viewer-resolve',
    setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(VIEWER, 'obsidian.js') }));
      build.onResolve({ filter: /^\.\/(mcp-settings|api|backups)$/ }, (args) => {
        if (path.resolve(args.resolveDir) !== path.join(ROOT, 'src')) return null;
        return { path: REPLACED[`${path.basename(args.path)}.js`] };
      });
      build.onResolve({ filter: /^node:|^(fs|path|http|crypto|electron)$/ }, (args) => ({
        path: args.path,
        namespace: 'graphfrontier-empty',
      }));
      build.onLoad({ filter: /.*/, namespace: 'graphfrontier-empty' }, () => ({
        contents: 'module.exports = {};',
        loader: 'js',
      }));
    },
  };
}

// The exported page's script as text; production builds are minified.
async function buildViewerScript({ production = false } = {}) {
  const result = await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: [path.join(VIEWER, 'main.js')],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2018',
    minify: production,
    legalComments: 'none',
    logLevel: 'silent',
    plugins: [viewerResolvePlugin()],
  });
  return result.outputFiles[0].text;
}

// The page's styles: its own base styles, then the plugin's styles.css.
function readViewerStyles() {
  return ['src/viewer/page.css', 'src/static/styles.css']
    .map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8'))
    .join('\n');
}

// Theme variables the styles use; their values are read from Obsidian at export.
function cssVariableNames(styles) {
  return [...new Set(styles.match(/--[a-zA-Z0-9-]+/g) || [])].sort();
}

// Every quoted lowercase word in the plugin may be an icon name; at export only names that
// Obsidian draws as icons are kept.
function iconCandidates() {
  const names = new Set(['x']);
  const dir = path.join(ROOT, 'src');
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.js')) continue;
    for (const match of fs
      .readFileSync(path.join(dir, file), 'utf8')
      .matchAll(/'([a-z][a-z0-9-]{0,40})'/g))
      names.add(match[1]);
  }
  return [...names].sort();
}

async function buildViewerSource({ production = false } = {}) {
  const viewerStyles = readViewerStyles();
  return {
    viewerScript: await buildViewerScript({ production }),
    viewerStyles,
    cssVariables: cssVariableNames(viewerStyles),
    iconCandidates: iconCandidates(),
  };
}

// The plugin build fills src/viewer-source.js with the page script, styles and their inputs.
function viewerSourcePlugin({ production = false } = {}) {
  return {
    name: 'graphfrontier-viewer-source',
    setup(build) {
      build.onLoad({ filter: /[\\/]src[\\/]viewer-source\.js$/ }, async () => ({
        contents: `module.exports = ${JSON.stringify(await buildViewerSource({ production }))};`,
        loader: 'js',
        watchDirs: [
          path.join(ROOT, 'src'),
          path.join(ROOT, 'src/viewer'),
          path.join(ROOT, 'src/static'),
        ],
      }));
    },
  };
}

module.exports = { buildViewerScript, buildViewerSource, viewerSourcePlugin };
