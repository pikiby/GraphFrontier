# Hotkeys And Commands

GraphFrontier commands are registered in Obsidian command palette and can be assigned in:

- `Settings -> Hotkeys`

## Command List

- Open GraphFrontier
- Open local GraphFrontier
- Toggle pin under cursor (GraphFrontier)
- Set force multiplier under cursor (GraphFrontier)
- Clear force multiplier under cursor (GraphFrontier)
- Align pins to grid (GraphFrontier)
- Pin node under cursor (GraphFrontier)
- Pin node to grid under cursor (GraphFrontier)
- Unpin node under cursor (GraphFrontier)
- Pin linked to orbit under cursor (GraphFrontier)
- Unpin linked nodes under cursor (GraphFrontier)
- Add to search under cursor (GraphFrontier)
- Show local graph under cursor (GraphFrontier)
- Pin linked nodes under cursor (GraphFrontier)
- Pin linked nodes to grid under cursor (GraphFrontier)
- Paint edges under cursor (GraphFrontier)
- Clear painted edges under cursor (GraphFrontier)
- Strong pull under cursor (GraphFrontier)
- Clear strong pull under cursor (GraphFrontier)
- Save layout (GraphFrontier)
- Load layout (GraphFrontier)
- Pin all nodes (GraphFrontier)
- Unpin all nodes (GraphFrontier)

## Practical Notes

- Commands with `under cursor` require:
  - active GraphFrontier view
  - a node under mouse cursor
- If no active GraphFrontier view exists, command shows a notice.
- Hotkeys work best when focus is not inside a text input.

Exact pin, grid pin and unpin commands use the current selection when nonempty, otherwise
the node under the cursor. Other explicit-target and linked commands remain single-target.
Ctrl+C / Cmd+C copies selected node names while the graph is active, preserving normal
text/input copying.

## Suggested Starter Mapping

- `Open GraphFrontier`: quick global shortcut
- `Add to search under cursor`: fast graph exploration
- `Strong pull under cursor` / `Clear strong pull under cursor`: fast local force tuning
- `Pin node under cursor` / `Unpin node under cursor`: layout locking workflow

## Related Docs

- Usage: `usage.md`
- Physics: `physics.md`

## Undo and redo in the graph

- **Ctrl+Z** (macOS: **Cmd+Z**): undo a manual move or pin action.
- **Ctrl+Y** or **Ctrl+Shift+Z** (macOS: **Cmd+Shift+Z**): redo.

These shortcuts apply only to the active graph, not text fields. A multi-node drag
or pin action is one step. History is shared by panes of the same layout and graph
scope, kept in memory for up to 100 actions, and discarded when layout data is
replaced or the plugin reloads. Local graphs have independent history.

Physics and list updates are not recorded. External positioning/pinning API
commands clear position history to avoid overwriting newer automation changes.
Undo does not change colors, lists, selection, camera or other visual settings.
Free nodes remain free and can move again under physics after undo.
