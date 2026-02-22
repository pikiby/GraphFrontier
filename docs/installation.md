# Installation

This document explains how to install GraphFrontier manually from local source.

## Prerequisites

- Obsidian desktop installed
- A vault with community plugins enabled
- Node.js installed (for building from source)

## Build From Source

1. Open terminal in the project folder:
   - `cd /home/boris/Documents/GraphFrontier`
2. Install dependencies (first time only):
   - `npm install`
3. Build plugin:
   - `npm run build`

After build, release files are prepared in `dist/`.

## Copy Into Vault

Copy files into your vault plugin folder, for example:

```bash
cp -av /home/boris/Documents/GraphFrontier/dist/{main.js,manifest.json,styles.css} \
  /home/boris/Documents/Work/analytics/.obsidian/plugins/graphfrontier/
```

## Enable Plugin In Obsidian

1. Open `Settings -> Community plugins`.
2. Ensure community plugins are enabled.
3. Enable `GraphFrontier`.

## Update Workflow

1. Pull latest project changes.
2. Run `npm run build`.
3. Copy `dist/main.js`, `dist/manifest.json`, `dist/styles.css` again into vault plugin folder.
4. Reload plugin in Obsidian (or restart Obsidian).

## Related Docs

- Usage: `usage.md`
- Troubleshooting: `troubleshooting.md`
