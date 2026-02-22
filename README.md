# GraphFrontier

GraphFrontier is a custom graph view plugin for Obsidian focused on advanced layout control:
pin modes, orbit pinning, strong pull, edge painting, grouped coloring, and physics tuning.

## Highlights

- Dedicated GraphFrontier view (openable as a normal tab)
- Multiple pin modes for nodes: `pin`, `pin to grid`, `orbit pin`
- Per-node force controls: strong pull / multiplier
- Edge painting per node with separate painted edge width
- Search row with `find` and `filter` behavior
- Group-based node coloring using query expressions
- Layout save/load and autosave after stabilization
- Attachment/orphan handling with separate behaviors

## Demo

**Pin nodes exactly where you want them!**

![Pin node demo](docs/media/pin_node.gif)

[Watch HD video (MP4)](docs/media/pin_node.mp4)

**Pin nodes to the grid.**

![Pin node to grid demo](docs/media/pin_node_grid.gif)

[Watch HD video (MP4)](docs/media/pin_node_grid.mp4)

**Save node positions. Keep your layout exactly where you want it every time you open the graph.**

![Save layout demo](docs/media/save.gif)

[Watch HD video (MP4)](docs/media/save.mp4)

## Quick Start

1. Build:
   - `npm run build`
2. Build output appears in `dist/`:
   - `dist/main.js`
   - `dist/manifest.json`
   - `dist/styles.css`
   - `dist/versions.json`
3. Copy plugin files into your vault plugin folder.
4. In Obsidian:
   - `Settings -> Community plugins -> Installed plugins -> GraphFrontier -> Enable`

## Documentation

- Installation: `docs/installation.md`
- Usage: `docs/usage.md`
- Settings: `docs/settings.md`
- Hotkeys and commands: `docs/hotkeys.md`
- Physics model: `docs/physics.md`
- Troubleshooting: `docs/troubleshooting.md`
- Manual build and release: `docs/manual-build-release.md`

## Project Structure

- `src/main.js`: plugin core, persistence, graph data collection, commands registration
- `src/view.js`: view lifecycle, UI, interactions, context actions, runtime orchestration
- `src/physics.js`: simulation and orbit-related calculations
- `src/render.js`: render pass, visual helpers, focus/label/color behavior
- `src/constants.js`: defaults, limits, command metadata, shared constants
- `src/static/`: plugin release assets source (`manifest.json`, `styles.css`, `versions.json`)
- `dist/`: release artifacts ready to install into a vault plugin folder

## License

MIT. See `LICENSE`.
