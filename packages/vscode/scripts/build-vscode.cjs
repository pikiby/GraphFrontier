'use strict';

const fs = require('node:fs');
const path = require('node:path');

const VSCODE_ROOT = path.resolve(__dirname, '..');
const GF_ROOT = path.resolve(process.env.GF_ROOT || path.join(VSCODE_ROOT, '..', '..'));
const STANDALONE_ROOT = path.resolve(
  process.env.GF_STANDALONE_ROOT || path.join(VSCODE_ROOT, '..', 'standalone')
);

if (!fs.existsSync(path.join(GF_ROOT, 'src', 'main.js'))) {
  throw new Error(`GraphFrontier repo not found at: ${GF_ROOT}`);
}
if (!fs.existsSync(path.join(STANDALONE_ROOT, 'src', 'indexer.cjs'))) {
  throw new Error(`GraphFrontier-Standalone repo not found at: ${STANDALONE_ROOT}`);
}

const esbuild = require(path.join(GF_ROOT, 'node_modules/esbuild'));
const { viewerSourcePlugin } = require(path.join(GF_ROOT, 'scripts/viewer-build.cjs'));

const OUT_DIR = path.join(VSCODE_ROOT, 'dist');
fs.mkdirSync(OUT_DIR, { recursive: true });

const VSCODE_MCP_SETTINGS = path.join(VSCODE_ROOT, 'src', 'vscode-mcp-settings.js');

function webviewBrowserPlugin() {
  return {
    name: 'graphfrontier-vscode-webview',
    setup(build) {
      build.onResolve({ filter: /^@gf\// }, (args) => ({
        path: path.join(GF_ROOT, 'src', args.path.slice(4)),
      }));
      build.onResolve({ filter: /^obsidian$/ }, () => ({
        path: path.join(GF_ROOT, 'src', 'viewer', 'obsidian.js'),
      }));
      build.onResolve({ filter: /^\.\/mcp-settings\.js$/ }, (args) => {
        if (path.resolve(args.resolveDir) === path.join(GF_ROOT, 'src')) {
          return { path: VSCODE_MCP_SETTINGS };
        }
        return null;
      });
      build.onResolve({ filter: /^node:|^(fs|path|http|crypto|electron)$/ }, (args) => ({
        path: args.path,
        namespace: 'gf-vsc-empty',
      }));
      build.onLoad({ filter: /.*/, namespace: 'gf-vsc-empty' }, () => ({
        contents: 'module.exports = {};',
        loader: 'js',
      }));
    },
  };
}

function extensionHostPlugin() {
  return {
    name: 'graphfrontier-vscode-host',
    setup(build) {
      build.onResolve({ filter: /^\.\/mcp-runtime\.cjs$/ }, () => ({
        path: 'gf-mcp-runtime-entry',
        namespace: 'gf-mcp-runtime',
      }));
      build.onLoad({ filter: /.*/, namespace: 'gf-mcp-runtime' }, () => ({
        contents: `
          export { GraphFrontierMcpServer } from ${JSON.stringify(path.join(GF_ROOT, 'src', 'mcp-server.js'))};
          export { GraphApiError } from ${JSON.stringify(path.join(GF_ROOT, 'src', 'api-errors.js'))};
        `,
        resolveDir: GF_ROOT,
        loader: 'js',
      }));
      build.onResolve({ filter: /^obsidian$/ }, () => ({
        path: 'obsidian-mcp-stub',
        namespace: 'gf-vsc-obsidian-stub',
      }));
      build.onLoad({ filter: /.*/, namespace: 'gf-vsc-obsidian-stub' }, () => ({
        contents: 'export const Platform = { isDesktop: true, isDesktopApp: true };',
        loader: 'js',
      }));
      build.onResolve({ filter: /^vscode$|^node:/ }, (args) => ({
        path: args.path,
        external: true,
      }));
    },
  };
}

// Low-specificity :where(...) theme mapping adopting the active VS Code color theme,
// while letting optional injected .obsidian themes override if configured.
const VSCODE_THEME_CSS = `
:root,
:where(body.theme-dark) {
  --background-primary: var(--vscode-editor-background, #1e1e1e);
  --background-primary-alt: var(--vscode-editorWidget-background, #252526);
  --background-secondary: var(--vscode-sideBar-background, #252526);
  --background-secondary-alt: var(--vscode-activityBar-background, #1f1f1f);
  --background-modifier-border: var(--vscode-panel-border, var(--vscode-editorWidget-border, #3c3c3c));
  --background-modifier-border-hover: var(--vscode-contrastBorder, #505050);
  --background-modifier-border-focus: var(--vscode-focusBorder, #007fd4);
  --background-modifier-form-field: var(--vscode-input-background, #2d2d2d);
  --background-modifier-hover: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.08));
  --text-normal: var(--vscode-editor-foreground, #d4d4d4);
  --text-muted: var(--vscode-descriptionForeground, #9d9d9d);
  --text-faint: var(--vscode-disabledForeground, #6c6c6c);
  --text-accent: var(--vscode-textLink-foreground, #3794ff);
  --text-on-accent: var(--vscode-button-foreground, #ffffff);
  --text-error: var(--vscode-errorForeground, #f48771);
  --text-warning: var(--vscode-editorWarning-foreground, #cca700);
  --interactive-normal: var(--vscode-button-secondaryBackground, #3a3d41);
  --interactive-hover: var(--vscode-button-secondaryHoverBackground, #45494e);
  --interactive-accent: var(--vscode-button-background, #0e639c);
  --interactive-accent-hover: var(--vscode-button-hoverBackground, #1177bb);
  --icon-color: var(--vscode-icon-foreground, #c5c5c5);
  --icon-color-hover: var(--vscode-editor-foreground, #ffffff);
  --icon-size: 16px;
  --icon-stroke: 2px;
  --button-radius: 5px;
  --input-border-width: 1px;
  --input-radius: 5px;
  --input-shadow: none;
  --slider-thumb-color: #ffffff;
  --font-interface: ui-sans-serif, -apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", "Google Sans Flex", Roboto, "Inter Variable", "Inter", sans-serif;
  --font-monospace: var(--vscode-editor-font-family, ui-monospace, monospace);
  --font-semibold: 600;
  --font-text-size: 16px;
  --font-ui-medium: 15px;
  --font-ui-small: 13px;
  --font-ui-smaller: 12px;
  --shadow-s: 0 2px 10px rgba(0, 0, 0, 0.25);
  --shadow-l: 0 8px 30px rgba(0, 0, 0, 0.4);
}

:where(body.theme-light) {
  --background-primary: var(--vscode-editor-background, #ffffff);
  --background-primary-alt: var(--vscode-editorWidget-background, #f3f3f3);
  --background-secondary: var(--vscode-sideBar-background, #f3f3f3);
  --background-secondary-alt: var(--vscode-activityBar-background, #e8e8e8);
  --background-modifier-border: var(--vscode-panel-border, #d4d4d4);
  --background-modifier-hover: var(--vscode-list-hoverBackground, rgba(0, 0, 0, 0.05));
  --text-normal: var(--vscode-editor-foreground, #1f1f1f);
  --text-muted: var(--vscode-descriptionForeground, #616161);
  --text-faint: var(--vscode-disabledForeground, #999999);
  --text-accent: var(--vscode-textLink-foreground, #006ab1);
  --interactive-normal: var(--vscode-button-secondaryBackground, #e5e5e5);
  --interactive-hover: var(--vscode-button-secondaryHoverBackground, #d6d6d6);
  --interactive-accent: var(--vscode-button-background, #007acc);
  --interactive-accent-hover: var(--vscode-button-hoverBackground, #0062a3);
  --icon-color: var(--vscode-icon-foreground, #424242);
  --icon-color-hover: var(--vscode-editor-foreground, #1f1f1f);
  --slider-thumb-color: var(--vscode-editor-foreground, #1f1f1f);
}
`;

const VSCODE_EXTRA_CSS = `
html, body {
  width: 100% !important;
  height: 100% !important;
  margin: 0 !important;
  padding: 0 !important;
  overflow: hidden !important;
}
#graphfrontier-root {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
}
:where(#graphfrontier-root) {
  font-family: var(--font-interface);
  font-size: var(--font-ui-small);
}
:where(#graphfrontier-root) :where(button, input, select, textarea) {
  font-family: inherit;
}
.graphfrontier-sidepanel::-webkit-scrollbar,
.graphfrontier-gear-popover::-webkit-scrollbar,
.graphfrontier-input-menu-list::-webkit-scrollbar {
  width: 5px;
  height: 5px;
}
.graphfrontier-sidepanel::-webkit-scrollbar-thumb,
.graphfrontier-gear-popover::-webkit-scrollbar-thumb,
.graphfrontier-input-menu-list::-webkit-scrollbar-thumb {
  background: var(--vscode-scrollbarSlider-background, rgba(121, 121, 121, 0.4));
  border-radius: 999px;
}
.graphfrontier-sidepanel::-webkit-scrollbar-thumb:hover,
.graphfrontier-gear-popover::-webkit-scrollbar-thumb:hover,
.graphfrontier-input-menu-list::-webkit-scrollbar-thumb:hover {
  background: var(--vscode-scrollbarSlider-hoverBackground, rgba(100, 100, 100, 0.7));
}
.graphfrontier-sidepanel::-webkit-scrollbar-track,
.graphfrontier-gear-popover::-webkit-scrollbar-track,
.graphfrontier-input-menu-list::-webkit-scrollbar-track {
  background: transparent;
}
.gf-vsc-mcp-url {
  margin-top: 6px;
}
.gf-vsc-mcp-url code {
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
.gf-vsc-empty-local {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  pointer-events: none;
  z-index: 20;
}
.gf-vsc-empty-card {
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  max-width: 280px;
  padding: 16px 18px;
  text-align: center;
  background: var(--background-secondary);
  border: 1px solid var(--background-modifier-border);
  border-radius: 8px;
  box-shadow: var(--shadow-s);
  color: var(--text-normal);
}
.gf-vsc-empty-title {
  font-weight: 600;
  font-size: 14px;
}
.gf-vsc-empty-desc {
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.45;
}
.gf-vsc-open-global-btn {
  width: 100%;
  padding: 6px 12px;
}
.gf-vsc-local-floating-btn {
  position: fixed;
  left: 10px;
  bottom: 10px;
  z-index: 20;
  padding: 5px 10px;
  font-size: 12px;
  background: var(--background-secondary);
  color: var(--text-normal);
  border: 1px solid var(--background-modifier-border);
  border-radius: 6px;
  box-shadow: var(--shadow-s);
}
.gf-vsc-local-floating-btn:hover {
  background: var(--interactive-hover);
}
.gf-vsc-filter-hint {
  position: fixed;
  left: 50%;
  bottom: 16px;
  transform: translateX(-50%);
  z-index: 25;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background: var(--background-secondary);
  color: var(--text-normal);
  border: 1px solid var(--background-modifier-border);
  border-radius: 8px;
  box-shadow: var(--shadow-s);
  font-size: 12px;
}
.gf-vsc-filter-hint-text {
  color: var(--text-muted);
}
.gf-vsc-empty-local.graphfrontier-viewer-hidden,
.gf-vsc-local-floating-btn.graphfrontier-viewer-hidden,
.gf-vsc-filter-hint.graphfrontier-viewer-hidden,
.gf-vsc-filter-hint-btn.graphfrontier-viewer-hidden {
  display: none;
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
  // 1. Self-contained VS Code Extension Host bundle
  await esbuild.build({
    absWorkingDir: VSCODE_ROOT,
    entryPoints: [path.join(VSCODE_ROOT, 'src', 'extension.cjs')],
    outfile: path.join(OUT_DIR, 'extension.cjs'),
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    minify: false,
    legalComments: 'none',
    nodePaths: [path.join(GF_ROOT, 'node_modules')],
    plugins: [extensionHostPlugin()],
  });

  // 2. Standalone WorkspaceGraphController CJS bundle for tests outside VS Code host
  await esbuild.build({
    absWorkingDir: VSCODE_ROOT,
    entryPoints: [path.join(VSCODE_ROOT, 'src', 'workspace-controller.cjs')],
    outfile: path.join(OUT_DIR, 'workspace-controller.cjs'),
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    minify: false,
    legalComments: 'none',
    nodePaths: [path.join(GF_ROOT, 'node_modules')],
    plugins: [extensionHostPlugin()],
  });

  // 3. Webview browser bundle + styles
  await esbuild.build({
    absWorkingDir: GF_ROOT,
    entryPoints: [path.join(VSCODE_ROOT, 'src', 'vscode-webview-client.js')],
    outfile: path.join(OUT_DIR, 'webview-bundle.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    minify: false,
    legalComments: 'none',
    nodePaths: [path.join(GF_ROOT, 'node_modules')],
    plugins: [webviewBrowserPlugin(), viewerSourcePlugin({ production: true })],
  });

  const pageCss = fs.readFileSync(path.join(GF_ROOT, 'src', 'viewer', 'page.css'), 'utf8');
  const pluginCss = fs.readFileSync(path.join(GF_ROOT, 'src', 'static', 'styles.css'), 'utf8');
  fs.writeFileSync(
    path.join(OUT_DIR, 'webview.css'),
    [VSCODE_THEME_CSS, pageCss, pluginCss, VSCODE_EXTRA_CSS].join('\n'),
    'utf8'
  );

  console.log('Built GraphFrontier VS Code bundles in', OUT_DIR);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
