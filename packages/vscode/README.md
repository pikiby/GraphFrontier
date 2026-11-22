# GraphFrontier for VS Code & Cursor

Interactive graph workspace for Markdown vaults and codebase repositories inside Visual Studio Code, Cursor, Windsurf, VSCodium, and other VS Code-compatible editors.

## Highlights

- **Global Graph Tab** (`GraphFrontier: Open Graph`): arrange notes and code files on a custom canvas with exact/grid/orbit pinning, subgraphs, gravity centers, link/node styling, search & query filters, saved layouts, Grow/Wave effects, and standalone HTML export.
- **Split Subgraph Tabs**: double-click any subgraph container to open its contents in an adjacent VS Code editor tab (`ViewColumn.Beside`), synced with the parent graph.
- **Local GraphFrontier Sidebar**: docked Activity Bar view (movable to the Secondary Side Bar) that tracks the active Markdown file.
- **Adjacent Editor Opening**: click any node to open that note or file in a neighboring editor column without losing graph focus.
- **Obsidian Layout Compatibility**: reads `.obsidian/plugins/graphfrontier/` via `GraphFrontier: Import Saves from Obsidian` or shared storage mode, while keeping separate VS Code workspace storage by default.
- **Built-in MCP Server**: localhost Streamable HTTP MCP server (`GraphFrontier: Copy MCP Server URL`) so AI agents can inspect, filter, search, and lay out your graph.

## Commands

- `GraphFrontier: Open GraphFrontier`
- `GraphFrontier: Open GraphFrontier to the Side`
- `GraphFrontier: Open Local Graph`
- `GraphFrontier: Refresh Workspace Index`
- `GraphFrontier: Import Saves from Obsidian (.obsidian)`
- `GraphFrontier: Copy MCP Server URL`

## Extension Settings

- `graphfrontier.storageMode`: `vscode` (isolated VS Code storage, default), `workspace` (`.vscode/graphfrontier/`), `obsidian` (`.obsidian/plugins/graphfrontier/`), or `readOnly`.
- `graphfrontier.preferObsidianTheme`: apply the workspace's `.obsidian` CSS theme instead of adapting to your active IDE color theme.
- `graphfrontier.mcpEnabled`: run the built-in localhost Streamable HTTP MCP server for AI agents.

## Source & Documentation

Full documentation and the Obsidian plugin live at [github.com/pikiby/GraphFrontier](https://github.com/pikiby/GraphFrontier).
