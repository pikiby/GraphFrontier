# Installation

## Community Plugins (Recommended)

1. Open **Settings -> Community plugins** in Obsidian.
2. Enable community plugins if restricted mode is on.
3. Select **Browse**, search for **GraphFrontier**, and select **Install**.
4. Select **Enable**.
5. Run **Open GraphFrontier** from the command palette or use its ribbon icon.

[GraphFrontier in the official directory](https://community.obsidian.md/plugins/graphfrontier).

You do not need npm, a separate Node.js installation, an AI subscription, or an
MCP client to use the graph. MCP is optional and disabled by default.

## Compatibility

GraphFrontier 0.8.2 requires Obsidian **1.12.7 or newer**. Desktop candidate
checks passed on 1.12.7 in an isolated vault. Android checks covered Obsidian
1.14.4 on Android 11 hardware and an Android 15 emulator. iOS remains unverified.
Automated tests complement these checks; they do not certify every platform or
touch workflow. Compatibility entries for earlier plugin releases are unchanged.

The graph is available on desktop and mobile. HTML export stays inside
the vault on both platforms. External-file and folder navigation remain
desktop features. MCP additionally requires desktop Obsidian's embedded Node
18+ runtime and Web Fetch APIs; an unavailable MCP runtime does not disable
the graph. See [MCP setup](mcp.md) and [mobile export](usage.md#static-html-export-on-mobile).

## Manual Installation

Download the ZIP from the [0.8.2 release](https://github.com/pikiby/GraphFrontier/releases/tag/0.8.2).
Extract it into `<vault>/.obsidian/plugins/graphfrontier/` without an extra nested
folder. The runtime files are `main.js`, `manifest.json` and `styles.css`.
Then enable GraphFrontier under **Settings -> Community plugins**.

## Updates

For catalog installations, use **Check for updates** in Community plugins and
install the available GraphFrontier update. Reload the plugin if prompted.

For manual updates, disable the plugin, replace the runtime files together, and
enable it again. Keep `data.json`, `layouts/` and optional `mcp.json`; do not
replace or delete the entire plugin directory. Never publish `mcp.json` or your
personal layout files.

## Build From Source

For contributors only: use Node.js 20 (the CI version) and npm. In your checkout:

```bash
npm ci
npm run format:check
npm run lint
npm test
npm run build
npm run check:release
```

The production build replaces `dist/`. Copy `dist/main.js`, `dist/manifest.json`
and `dist/styles.css` into a separate test vault's `.obsidian/plugins/graphfrontier/`
directory. Do not copy `node_modules` or overwrite personal settings/layouts.

## If The Plugin Does Not Appear

- Confirm community plugins are enabled and GraphFrontier itself is enabled.
- For manual installation, check that `main.js` and `manifest.json` are directly inside the `graphfrontier` folder.
- Reload Obsidian after replacing files. Report the Obsidian version, platform, plugin version and error text if loading fails; exclude tokens and private notes.

See [usage](usage.md) and [troubleshooting](troubleshooting.md).
