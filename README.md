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

<table>
  <tr>
    <td width="50%" valign="top" align="center">
      <img src="docs/media/pin_node.gif" alt="Pin node demo" width="100%">
      <br>
      <sub><strong>Pin nodes exactly where you want them!</strong></sub>
    </td>
    <td width="50%" valign="top" align="center">
      <img src="docs/media/pin_node_grid.gif" alt="Pin node to grid demo" width="100%">
      <br>
      <sub><strong>Pin nodes to the grid.</strong></sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top" align="center">
      <img src="docs/media/save.gif" alt="Save layout demo" width="100%">
      <br>
      <sub><strong>Save node positions. Keep your layout exactly where you want it every time you open the graph.</strong></sub>
    </td>
    <td width="50%" valign="top" align="center">
      <img src="docs/media/strong_pull.gif" alt="Strong pull demo" width="100%">
      <br>
      <sub><strong>Boost attraction to a specific node.</strong></sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top" align="center">
      <img src="docs/media/pin_orbit.gif" alt="Pin linked nodes to orbit demo" width="100%">
      <br>
      <sub><strong>Place linked nodes on another node's orbit with one click.</strong></sub>
    </td>
    <td width="50%" valign="top" align="center">
      <img src="docs/media/unpin_linked_grid.gif" alt="Move linked nodes and keep position demo" width="100%">
      <br>
      <sub><strong>Move linked nodes and keep them exactly where you need them.</strong></sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top" align="center">
      <img src="docs/media/paint_links.gif" alt="Paint links demo" width="100%">
      <br>
      <sub><strong>Paint links for better visual clarity.</strong></sub>
    </td>
    <td width="50%" valign="top" align="center">
      <img src="docs/media/hide_edges.gif" alt="Hide edges demo" width="100%">
      <br>
      <sub><strong>Hide links you do not need.</strong></sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top" align="center">
      <img src="docs/media/find.gif" alt="Find mode demo" width="100%">
      <br>
      <sub><strong>Find mode: explore links in the full context.</strong></sub>
    </td>
    <td width="50%" valign="top" align="center">
      <img src="docs/media/filter.gif" alt="Filter mode demo" width="100%">
      <br>
      <sub><strong>Filter mode: local graph behavior directly in the global view.</strong></sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top" align="center">
      <img src="docs/media/orphan.gif" alt="Orphan files separation demo" width="100%">
      <br>
      <sub><strong>Orphan files stay separate from primary nodes.</strong></sub>
    </td>
    <td width="50%" valign="top" align="center">
      <img src="docs/media/attachments.gif" alt="Attachments on orbit demo" width="100%">
      <br>
      <sub><strong>Show only linked attachments and place them directly on node orbits.</strong></sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top" align="center">
      <img src="docs/media/hotkeys.gif" alt="Hotkey support demo" width="100%">
      <br>
      <sub><strong>Hotkey support.</strong></sub>
    </td>
    <td width="50%" valign="top" align="center">
      <img src="docs/media/commands.gif" alt="Command support demo" width="100%">
      <br>
      <sub><strong>Command support.</strong></sub>
    </td>
  </tr>
</table>

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
