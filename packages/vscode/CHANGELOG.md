# Changelog

## 0.9.7

- Synced VS Code & Open VSX (Cursor, Windsurf, VSCodium) release version with the GraphFrontier 0.9.7 monorepo engine.
- Added adaptive P3M short-range cap and FIRE steering to eliminate perpetual-motion trapped nodes in dense graphs, plus batched mid-zoom rendering optimization.
- Raised minimum `repel_strength` to `3`, kept **Grow** and **Wave** always expanded inside **Effects**, temporarily removed **Frame** controls from text labels, and skipped border calculation when `node_border_width` is `0`.
- Completed Marketplace & Open VSX metadata (`repository`, `homepage`, `bugs`, `keywords`, `galleryBanner`, `.vscodeignore`) and pure-Node VSIX packaging/validation.

## 0.1.0

- Initial VS Code extension wrapping GraphFrontier 0.9.6 engine.
- Global graph tab, split subgraph tabs, Activity Bar Local Graph sidebar following active editors, native adjacent editor opening, live file watcher, and Streamable HTTP MCP server.
