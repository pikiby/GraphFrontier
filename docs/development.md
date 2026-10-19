# Development

## Project Structure

- `src/main.js`: plugin core, persistence, graph data collection, commands registration
- `src/view.js`: view lifecycle, UI, interactions, context actions, runtime orchestration
- `src/physics.js`: simulation and orbit-related calculations
- `src/render.js`: render pass, visual helpers, focus/label/color behavior
- `src/constants.js`: defaults, limits, command metadata, shared constants
- `src/api.js`, `src/api-actions.js`, `src/api-layouts.js`, `src/api-tools.js`: graph API, actions, layout recovery and validated schemas
- `src/mcp-server.js`, `src/mcp-settings.js`: optional authenticated MCP transport and connection settings
- `src/static/`: plugin release assets source (`manifest.json`, `styles.css`, `versions.json`)
- `dist/`: built plugin files ready to install into a vault plugin folder
- `dist/release/`: packaged release zip files
