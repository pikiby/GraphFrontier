# Usage

This document describes daily workflow in GraphFrontier.

## Open The View

Use one of these options:

- Ribbon icon: `Open GraphFrontier`
- Command palette command: `Open GraphFrontier`

The view opens as a regular tab and can be moved between panes/sidebars.

## Basic Navigation

- Drag empty area: pan
- Mouse wheel: zoom
- Drag node: move node
- Left click node: open markdown file (if node is a markdown file)

## Touch Navigation

- Drag empty space with one finger to pan; drag a node to move it.
- Use two fingers to pan and pinch to zoom.
- Hold a node for about 450 ms to open its context menu.
- Hold empty space to open **Create gravity node**. Moving more than 10 screen
  pixels, releasing early or adding a second finger cancels the pending menu.
- Touch box selection is not implemented; desktop modifier-key selection does
  not automatically translate into a touch gesture.

Color swatches use the native color palette again in 0.8.2. The compact circular
swatch controls are preserved; the palette itself follows the platform.
Version 0.8.1 used a replacement RGB/HEX dialog.

## Gravity Nodes

Right-click empty graph space and choose **Create gravity node**. Set a name, attraction
strength using the slider (0-100), and one or more query rules. Rules reuse the search types: `name:`,
`path:`, `file:`, `tag:`, `line:`, `section:`, and `[property]:`. Matching any rule is enough.
Click the type prefix to change it through the existing dropdown. Enter keeps your typed
rule; click a suggestion or press Tab to accept one.

The colored ring marks a movable attraction center, not a note or folder. Drag it to move
the center; click it or use **Edit gravity node** in its context menu to edit it. **Delete
gravity node** removes only the object. No Markdown files or links are created.

Matching free nodes are attracted to the center while ordinary graph forces continue.
The **Repulsion** slider (0-100, default 0/off) pushes nonmatching nodes away without
changing attraction. Repulsion fades smoothly to zero at 1000 graph units from the center.
Like attraction, it respects pins, active dragging and attachment isolation, and is saved
with the layout. Gravity centers do not repel each other.
Pinned, orbit-pinned and actively dragged nodes are not pulled. Attachment isolation
settings still apply. Multiple centers combine their attraction. Centers stay visible
when search or blacklist/whitelist hide notes, but hidden notes do not participate in physics.

Objects, rules, strength and positions belong to the active layout and follow its existing
Save, Load and autosave behavior. They remain stationary unless moved manually.

## Subgraphs

Select existing nodes with the normal selection modifier, selection commands, or box
selection. Right-click a node or empty space and choose **Combine selected into subgraph**.
The compact creation dialog has only a **Name** input; the captured selection supplies
membership. No notes, files, folders or links are modified.

The parent graph always shows a hollow standard ball with a thicker outer outline.
There is no in-place expand/collapse. Outside links are aggregated onto the container,
deduplicated and used by the ordinary node physics. The container supports the normal
drag, selection, exact/grid/orbit pin, Strong pull, color, aura, size and edge actions.

Single-click selects the container. Double-click or **Open subgraph in pane** opens its
contents in a separate Obsidian pane, like a local graph, never an OS popout. The outer
container is not an actor in this inner graph. Its viewport is fitted after a nonzero
size is available; saved inner cameras are restored instead. Inner coordinates, camera,
filters and physics are independent. Moving the parent container never moves its members.
Closing the pane never expands, rearranges or wakes the parent graph.

Subgraphs can contain nested containers. Each node belongs to exactly one immediate
parent coordinate space. **Rename subgraph** changes only the name. Membership is fixed:
to change it, use **Ungroup subgraph** and create another group from the new selection.
**Ungroup subgraph** removes the container only, releasing its immediate members around
the container's current position using their latest local offsets. A nested container's
interior is not translated. Notes and their links/settings remain intact.

Save from any pane merges all open local spaces and retains closed/filtered members,
without replacing the main camera or search with an inner pane's state. Autosave off
stays off; mutations remain dirty until an explicit save. Creation and Ungroup wake
physics immediately. Explicit layout restoration stays paused. A stale pane after a
layout switch or Ungroup remains empty instead of exposing the whole vault.

Whitelist, blacklist and exact node filters still apply to canonical members and links.
A matching hidden member keeps its container visible, but opening the pane does not
bypass blacklist/whitelist. Inner filters are saved separately. A blacklist matching a
container name hides that container and its descendants. Gravity only affects nodes
when its gravity center belongs to the same projected graph.

Existing global-coordinate subgraph layouts are migrated in memory to local coordinates
when loaded, ignoring obsolete expansion state; the normal Save/autosave policy controls
writing. Exact and grid pin coordinates are converted while retaining the pin mode.
Orbit pins within one space remain orbit pins. When grouping separates a pin from its
orbit anchor, it becomes an exact pin at its converted position rather than becoming
free or pulling across graph spaces. Initial migrated inner cameras are refitted.

Static HTML export includes only the current projected graph and hollow container balls;
it is not a subgraph editor and cannot open nested panes.

## Search Row (Find / Filter)

The top search row supports two modes:

- `find`: focus/highlight a target node and relations visually
- `filter`: keep only target node and directly linked nodes visible

Flow:

1. Choose mode (`find` or `filter`).
2. Enter a value after the default `name:` prefix, or choose another query type from the dropdown.
3. Select a suggestion to apply target node.
4. Clear the query value to reset highlighting/filter; the type prefix remains.

## Right-Click Context Menu On Node

**Visual settings** provides per-node sliders for node size, edge width, painted edge width,
text zoom, text size and hover dimming. Attachment nodes also offer attachment size.
Node size supports up to x4 in both menus. **Text zoom** supports 1-40 steps in both menus. **Node color** sets the global base color or
an individual override; individual color takes priority over Groups, then the global base.
**Color aura** is available only in individual settings: 0 disables it (the default),
and its 0-5000 scale corresponds to a radius of 0-500 graph units.
**Aura brightness** controls opacity from 0 to 50%, defaulting to 22%.
Both controls are individual-only; the gradient uses the node's color.
The aura does not affect physics or the mouse hit area.
Each value inherits the main panel setting until changed; one **Reset visual settings**
action restores all visual inheritance and clears this node's edge painting.
Gravity nodes omit edge settings, edge painting and Strong pull.
Hover dimming controls how much this node fades when another node is focused. Edge widths
apply to incident edges; if both endpoints override a width, the larger override wins.
Visual changes do not restart physics. Overrides follow layout Save, Load and autosave,
and are included in static HTML export. Grid, graph-wide visibility and physics settings
are not individual visual overrides.

Notes with a `url` or `path` string in YAML properties have **Open URL** or **Open path**
actions in their node's right-click menu:

```yaml
---
url: https://example.com
path: /home/user/Documents/project
---
```

Either property can be used on its own. URLs open in the default browser. Vault-relative file
paths open in Obsidian; external files and folders open through the desktop's default application.
Paths can be absolute, vault-relative, or start with `~/`. External paths must exist on the
current device. The note and normal node click behavior are unchanged.

The menu is arranged in this order:

- **Copy system root**, then **Copy**: Obsidian URL, vault-relative path, linked names and linked paths.
- **Open path**, **Open URL**, then **Open**: same tab, new window, default app, system explorer and file navigation.
- **Pin node**, **Pin to grid**, **Pin linked**, and **Unpin node**. Linked actions include both notes and attachments.
- **Visual settings**: text size, strong pull and edge painting, including their reset actions.
- **Select linked nodes**, **Bookmark**, then **Other**: move, bookmark, merge, add to search and local graph.
- **Delete** at the bottom uses Obsidian's normal deletion confirmation.

Actions appear only when applicable: YAML actions require the corresponding property, unpin actions require matching pins, and linked actions require linked nodes. The text-size slider changes only this node; **Use global text size** removes its override.

## Layout Persistence

- `Save layout`: stores current node positions and pin states
- `Load layout`: restores previously saved layout
- `Autosave`: optionally saves layout after graph stabilizes

If search row is active, save is blocked to avoid saving filtered/focus state as final layout.

## Static HTML Export

**Export to** and the static HTML export command open **Export graph**. Choose a
filename (default: `graphfrontier-static.html`) and a folder **inside the current
vault**. The folder field suggests existing vault folders; select one or type a
new nested path. Leave it empty for the vault root. Enter in the folder field
selects a suggestion rather than exporting.
The `.html` extension is added when omitted.
Absolute paths, URLs, parent traversal, hidden folders and reserved names are rejected.
Missing folders are created when exporting. For an existing destination, the main
button becomes **Replace file**; only activating that button permits replacement.
If a file appears concurrently, export stops instead of silently replacing it.
**Cancel** closes the dialog without exporting.

After saving, the dialog stays open with **Saved** and the full vault-relative
path. **Open file** opens that result through Obsidian's default-app action;
if unavailable or opening fails, the path remains visible with an inline error.
Use **Close** to dismiss the dialog. HTML files may be hidden in Obsidian's file
explorer; no global visibility settings are changed.
Filenames and folders are not remembered. The HTML contains note previews and
metadata; review it before sharing.
API/MCP exports may still specify a vault-relative path and require explicit
permission to overwrite an existing file.

Storage uses Obsidian's Vault API. Linked folders follow the vault adapter's behavior; this is not a filesystem sandbox that resolves and blocks symlink
targets outside the vault. Choose a regular vault folder for exports.

On mobile, **Open URL** and Obsidian `path` links are passed to the host without
Electron. Vault files open in Obsidian. Opening arbitrary external files or folders
is desktop-only. Actual link handling depends on the device and installed apps.

Mobile export and navigation have automated coverage with a simulated platform and
vault API. This is not yet verification on a physical Android or iOS device.

## Related Docs

- Settings: `settings.md`
- Hotkeys: `hotkeys.md`
- Physics model: `physics.md`

## Motion Settling

Damping controls velocity loss without an additional timed brake. Simulation continues
past three seconds while nodes remain unsettled. Nodes sleep after eight consecutive
frames of low speed and low net force; a higher wake threshold suppresses tiny oscillations.
Layout-changing actions wake the simulation. Once every movable node sleeps, physics pauses.
