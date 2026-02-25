# GraphFrontier

GraphFrontier is **not** a plugin for Obsidian Graph View.
It is a fully independent plugin with its own physics engine, designed to implement ideas that are not possible in the standard graph plugin.

The main goal is to build an ideal, universal data-visualization tool that keeps the strengths of Graph View while removing its limitations.

It helps create a clean, well-organized structure for large collections of notes and stays very smooth even with a very large number of objects.

Especially useful for:

- Finding patterns
- Documentation
- Visualizing relationships in database structures
- Prompt engineering

## Support

This project is actively growing, and I would be very grateful for your support.

<a href="https://www.buymeacoffee.com/pikiby" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" style="height: 60px !important;width: 217px !important;" ></a>

I would be happy to hear your ideas:

https://github.com/pikiby/GraphFrontier/discussions

And I would really appreciate your help with bug reports:

https://github.com/pikiby/GraphFrontier/issues

## Installation

Download:

https://github.com/pikiby/GraphFrontier/releases/download/0.6.7/graphfrontier-0.6.7.zip

1. Download `graphfrontier-0.6.7.zip` from Releases
2. Extract it into your vault plugins folder:
   - `<vault>/.obsidian/plugins/graphfrontier/`
3. In Obsidian enable the plugin:
   - `Settings -> Community plugins -> GraphFrontier -> Enable`

## Features

<table style="border-collapse: collapse; width: 100%;">
  <tr style="background-color: transparent;">
    <td width="50%" valign="top" align="left" style="background-color: transparent; border: none;">
      <img src="docs/media/pin_node.gif" alt="Pin node demo" width="100%">
      <br>
      <p style="font-size: 1.05em;"><strong>Pin nodes exactly where you want them</strong></p>
    </td>
    <td width="50%" valign="top" align="left" style="background-color: transparent; border: none;">
      <img src="docs/media/pin_node_grid.gif" alt="Pin node to grid demo" width="100%">
      <br>
      <p style="font-size: 1.05em;"><strong>Pin nodes to the grid</strong></p>
    </td>
  </tr>
  <tr style="background-color: transparent;">
    <td width="50%" valign="top" align="left" style="background-color: transparent; border: none;">
      <img src="docs/media/save.gif" alt="Save layout demo" width="100%">
      <br>
      <p style="font-size: 1.05em;"><strong>Save node positions and keep your layout exactly where you want it every time you open the graph</strong></p>
    </td>
    <td width="50%" valign="top" align="left" style="background-color: transparent; border: none;">
      <img src="docs/media/strong_pull.gif" alt="Strong pull demo" width="100%">
      <br>
      <p style="font-size: 1.05em;"><strong>Boost attraction to a specific node</strong></p>
    </td>
  </tr>
  <tr style="background-color: transparent;">
    <td width="50%" valign="top" align="left" style="background-color: transparent; border: none;">
      <img src="docs/media/pin_orbit.gif" alt="Pin linked nodes to orbit demo" width="100%">
      <br>
      <p style="font-size: 1.05em;"><strong>Place linked nodes on another node orbit with one click</strong></p>
    </td>
    <td width="50%" valign="top" align="left" style="background-color: transparent; border: none;">
      <img src="docs/media/unpin_linked_grid.gif" alt="Move linked nodes and keep position demo" width="100%">
      <br>
      <p style="font-size: 1.05em;"><strong>Move linked nodes and keep them exactly where you need them</strong></p>
    </td>
  </tr>
  <tr style="background-color: transparent;">
    <td width="50%" valign="top" align="left" style="background-color: transparent; border: none;">
      <img src="docs/media/paint_links.gif" alt="Paint links demo" width="100%">
      <br>
      <p style="font-size: 1.05em;"><strong>Paint links for better visual clarity</strong></p>
    </td>
    <td width="50%" valign="top" align="left" style="background-color: transparent; border: none;">
      <img src="docs/media/hide_edges.gif" alt="Hide edges demo" width="100%">
      <br>
      <p style="font-size: 1.05em;"><strong>Hide links you do not need</strong></p>
    </td>
  </tr>
  <tr style="background-color: transparent;">
    <td width="50%" valign="top" align="left" style="background-color: transparent; border: none;">
      <img src="docs/media/find.gif" alt="Find mode demo" width="100%">
      <br>
      <p style="font-size: 1.05em;"><strong>Find mode explore links in the full context</strong></p>
    </td>
    <td width="50%" valign="top" align="left" style="background-color: transparent; border: none;">
      <img src="docs/media/filter.gif" alt="Filter mode demo" width="100%">
      <br>
      <p style="font-size: 1.05em;"><strong>Filter mode local graph behavior directly in the global view</strong></p>
    </td>
  </tr>
  <tr style="background-color: transparent;">
    <td width="50%" valign="top" align="left" style="background-color: transparent; border: none;">
      <img src="docs/media/orphan.gif" alt="Orphan files separation demo" width="100%">
      <br>
      <p style="font-size: 1.05em;"><strong>Orphan files stay separate from primary nodes</strong></p>
    </td>
    <td width="50%" valign="top" align="left" style="background-color: transparent; border: none;">
      <img src="docs/media/attachments.gif" alt="Attachments on orbit demo" width="100%">
      <br>
      <p style="font-size: 1.05em;"><strong>Show only linked attachments and place them directly on node orbits</strong></p>
    </td>
  </tr>
  
  <tr style="background-color: transparent;">
    <td width="50%" valign="top" align="left" style="background-color: transparent; border: none;">
      <img src="docs/media/hotkeys.gif" alt="Hotkey support demo" width="100%">
      <br>
      <p style="font-size: 1.05em;"><strong>Hotkey support</strong></p>
    </td>
    <td width="50%" valign="top" align="left" style="background-color: transparent; border: none;">
      <img src="docs/media/commands.gif" alt="Command support demo" width="100%">
      <br>
      <p style="font-size: 1.05em;"><strong>Command support</strong></p>
    </td>
  </tr>
  <tr style="background-color: transparent;">
    <td width="50%" valign="top" align="left" style="background-color: transparent; border: none;">
      <img src="docs/media/blacklist.gif" alt="Blacklist demo" width="100%">
      <br>
      <p style="font-size: 1.05em;"><strong>Hide unnecessary objects</strong></p>
    </td>
    <td width="50%" valign="top" align="left" style="background-color: transparent; border: none;">
      <img src="docs/media/whitelist.gif" alt="Whitelist demo" width="100%">
      <br>
      <p style="font-size: 1.05em;"><strong>Keep only necessary objects</strong></p>
    </td>
  </tr>
</table>

## Documentation

- Installation: `docs/installation.md`
- Usage: `docs/usage.md`
- Settings: `docs/settings.md`
- Hotkeys and commands: `docs/hotkeys.md`
- Physics model: `docs/physics.md`
- Troubleshooting: `docs/troubleshooting.md`

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
