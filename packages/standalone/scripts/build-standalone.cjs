'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STANDALONE_ROOT = path.resolve(__dirname, '..');
const GF_ROOT = path.resolve(process.env.GF_ROOT || path.join(STANDALONE_ROOT, '..', '..'));

if (!fs.existsSync(path.join(GF_ROOT, 'src', 'main.js'))) {
  throw new Error(`GraphFrontier source directory not found at: ${GF_ROOT}`);
}

const esbuild = require(path.join(GF_ROOT, 'node_modules/esbuild'));
const { viewerSourcePlugin } = require(path.join(GF_ROOT, 'scripts/viewer-build.cjs'));

const OUT_DIR = path.join(STANDALONE_ROOT, 'dist');
fs.mkdirSync(OUT_DIR, { recursive: true });

const STANDALONE_MCP_SETTINGS = path.join(STANDALONE_ROOT, 'src', 'standalone-mcp-settings.js');

function standaloneBrowserPlugin() {
  return {
    name: 'graphfrontier-standalone-browser',
    setup(build) {
      build.onResolve({ filter: /^@gf\// }, (args) => ({
        path: path.join(GF_ROOT, 'src', args.path.slice(4)),
      }));
      build.onResolve({ filter: /^obsidian$/ }, () => ({
        path: path.join(GF_ROOT, 'src', 'viewer', 'obsidian.js'),
      }));
      build.onResolve({ filter: /^\.\/mcp-settings\.js$/ }, (args) => {
        if (path.resolve(args.resolveDir) === path.join(GF_ROOT, 'src')) {
          return { path: STANDALONE_MCP_SETTINGS };
        }
        return null;
      });
      build.onResolve({ filter: /^node:|^(fs|path|http|crypto|electron)$/ }, (args) => ({
        path: args.path,
        namespace: 'gf-standalone-empty',
      }));
      build.onLoad({ filter: /.*/, namespace: 'gf-standalone-empty' }, () => ({
        contents: 'module.exports = {};',
        loader: 'js',
      }));
    },
  };
}

function standaloneMcpNodePlugin() {
  return {
    name: 'graphfrontier-standalone-mcp-node',
    setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({
        path: 'obsidian-mcp-stub',
        namespace: 'gf-obsidian-mcp-stub',
      }));
      build.onLoad({ filter: /.*/, namespace: 'gf-obsidian-mcp-stub' }, () => ({
        contents: 'export const Platform = { isDesktop: true, isDesktopApp: true };',
        loader: 'js',
      }));
      build.onResolve({ filter: /^node:/ }, (args) => ({
        path: args.path,
        external: true,
      }));
    },
  };
}

// Base Obsidian theme variables placed under :where(...) so injected vault themes (e.g. Atom) take precedence cleanly.
const BASE_THEME_VARS = `
:root,
:where(body.theme-dark) {
  --background-primary: #1e1e1e;
  --background-primary-alt: #242424;
  --background-secondary: #262626;
  --background-secondary-alt: #1f1f1f;
  --background-modifier-border: #363636;
  --background-modifier-border-hover: #4a4a4a;
  --background-modifier-border-focus: #5a5a5a;
  --background-modifier-form-field: #2a2a2a;
  --background-modifier-hover: rgba(255, 255, 255, 0.075);
  --text-normal: #dadada;
  --text-muted: #999999;
  --text-faint: #666666;
  --text-accent: #7aa2f7;
  --text-on-accent: #ffffff;
  --text-error: #fb464c;
  --text-warning: #e9973f;
  --interactive-normal: #363636;
  --interactive-hover: #3f3f3f;
  --interactive-accent: #7f6df2;
  --interactive-accent-hover: #8875ff;
  --icon-color: #999999;
  --icon-color-hover: #dadada;
  --icon-size: 16px;
  --icon-stroke: 1.75px;
  --button-radius: 5px;
  --input-border-width: 1px;
  --input-radius: 5px;
  --input-shadow: inset 0 0.5px 0.5px 0.5px rgba(255, 255, 255, 0.09), 0 2px 4px 0 rgba(0, 0, 0, 0.15);
  --slider-thumb-color: #dadada;
  --font-interface: ui-sans-serif, -apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", Roboto, Inter, sans-serif;
  --font-monospace: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  --font-semibold: 600;
  --font-text-size: 15px;
  --font-ui-medium: 15px;
  --font-ui-small: 13px;
  --font-ui-smaller: 12px;
  --shadow-s: 0 1px 2px rgba(0, 0, 0, 0.15), 0 3.4px 6.7px rgba(0, 0, 0, 0.2), 0 15px 30px rgba(0, 0, 0, 0.3);
  --shadow-l: 0 6.3px 24.7px rgba(0, 0, 0, 0.2), 0 30px 90px rgba(0, 0, 0, 0.35);
}

:where(body.theme-light) {
  --background-primary: #ffffff;
  --background-primary-alt: #f6f6f6;
  --background-secondary: #f2f3f5;
  --background-secondary-alt: #e9eaed;
  --background-modifier-border: #d4d4d4;
  --background-modifier-border-hover: #bdbdbd;
  --background-modifier-border-focus: #8a8a8a;
  --background-modifier-form-field: #ffffff;
  --background-modifier-hover: rgba(0, 0, 0, 0.05);
  --text-normal: #222222;
  --text-muted: #5c5c5c;
  --text-faint: #999999;
  --text-accent: #375fb5;
  --text-on-accent: #ffffff;
  --text-error: #e5484d;
  --text-warning: #d97706;
  --interactive-normal: #ffffff;
  --interactive-hover: #f3f3f3;
  --interactive-accent: #4c6ef5;
  --interactive-accent-hover: #3b5bdb;
  --icon-color: #5c5c5c;
  --icon-color-hover: #222222;
  --slider-thumb-color: #222222;
}
`;

const STANDALONE_EXTRA_CSS = `
.gf-standalone-mcp-url {
  margin-top: 6px;
}
.gf-standalone-mcp-url code {
  display: block;
  padding: 5px 7px;
  border-radius: 4px;
  background: var(--background-modifier-form-field);
  border: 1px solid var(--background-modifier-border);
  color: var(--text-muted);
  font-family: var(--font-monospace);
  font-size: 11px;
  word-break: break-all;
  user-select: all;
}
.gf-standalone-subview-bar {
  position: fixed;
  top: 12px;
  left: 12px;
  z-index: 820;
}
.graphfrontier-settings-section {
  margin-bottom: 18px;
}
.setting-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 0;
}
.setting-item-name {
  font-weight: 600;
}
.setting-item-description {
  font-size: var(--font-ui-smaller, 12px);
  color: var(--text-muted);
}
`;

async function main() {
  await esbuild.build({
    absWorkingDir: GF_ROOT,
    entryPoints: [path.join(STANDALONE_ROOT, 'src', 'standalone-client.js')],
    outfile: path.join(OUT_DIR, 'standalone-bundle.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    minify: false,
    legalComments: 'none',
    nodePaths: [path.join(GF_ROOT, 'node_modules')],
    plugins: [standaloneBrowserPlugin(), viewerSourcePlugin({ production: true })],
  });

  const pageCss = fs.readFileSync(path.join(GF_ROOT, 'src', 'viewer', 'page.css'), 'utf8');
  const pluginCss = fs.readFileSync(path.join(GF_ROOT, 'src', 'static', 'styles.css'), 'utf8');
  fs.writeFileSync(
    path.join(OUT_DIR, 'standalone.css'),
    [BASE_THEME_VARS, pageCss, pluginCss, STANDALONE_EXTRA_CSS].join('\n'),
    'utf8'
  );

  await esbuild.build({
    absWorkingDir: GF_ROOT,
    stdin: {
      contents: `
        export { GraphFrontierMcpServer } from './src/mcp-server.js';
        export { GraphApiError } from './src/api-errors.js';
      `,
      resolveDir: GF_ROOT,
      loader: 'js',
    },
    outfile: path.join(OUT_DIR, 'mcp-node.cjs'),
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    minify: false,
    legalComments: 'none',
    nodePaths: [path.join(GF_ROOT, 'node_modules')],
    plugins: [standaloneMcpNodePlugin()],
  });

  console.log('Built GraphFrontier Standalone bundles in', OUT_DIR);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
