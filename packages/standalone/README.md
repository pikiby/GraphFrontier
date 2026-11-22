# GraphFrontier Standalone

Universal Node.js CLI and web runtime for **GraphFrontier**: runs the full interactive graph **without Obsidian** over any folder of Markdown notes (or an existing Obsidian vault with `.obsidian/plugins/graphfrontier/`), including a built-in Streamable HTTP MCP server for AI agents.

## Quick start (read-only mode, zero disk writes)

```bash
node packages/standalone/bin/graphfrontier.cjs /path/to/vault --read-only --port 8790
```

Main flags in [bin/graphfrontier.cjs](./bin/graphfrontier.cjs):

- `[vaultDir]` — folder with `.md` notes (defaults to current directory);
- `--port <n>` — web UI port (default `8790`, `0` = random);
- `--mcp-port <n>` — preferred local MCP port (`127.0.0.1:<port>/mcp/<secret>`);
- `--read-only` — strictly forbids writes to disk;
- `--state-dir <dir>` — store `data.json` and `layouts/` in `<dir>` (default `<vault>/.graphfrontier/`);
- `--obsidian-config` — read/write directly in `<vault>/.obsidian/plugins/graphfrontier/`;
- `--no-watch`, `--open`.

## Build and test

```bash
npm run build:standalone
GRAPHFRONTIER_PLAYWRIGHT_MODULE=... GRAPHFRONTIER_CHROMIUM=... npm run test:standalone
GRAPHFRONTIER_PLAYWRIGHT_MODULE=... GRAPHFRONTIER_CHROMIUM=... npm --prefix packages/standalone run verify:parity -- /path/to/vault
```
