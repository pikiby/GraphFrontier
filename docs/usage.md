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
- Left click file node: open in a new Obsidian tab using its registered editor/viewer
  (including installed view plugins); unsupported vault formats open in the default external app.
  Missing files and folders are ignored; opening errors are shown as notices.

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
Like attraction, it respects pins and active dragging, and is saved
with the layout. Gravity centers do not repel each other.
Pinned, orbit-pinned and actively dragged nodes are not pulled. Attachments obey the same
force rules as notes. Multiple centers combine their attraction. Centers stay visible
when search, blacklist/whitelist or hidden groups (the eye button in Groups) hide notes,
but hidden notes do not participate in physics, except hidden groups in **Hide** mode,
which stay in physics while they are not drawn.

Objects, rules, strength and positions belong to the active layout and follow its existing
Save, Load and autosave behavior. They remain stationary unless moved manually.

## Subgraphs

Select existing nodes with the normal selection modifier, selection commands, or box
selection. Right-click a node or empty space and choose **Combine into subgraph**, the first
item of a selection menu. For one note, **Combine linked** next to **Select linked nodes** combines
the note with its direct links.
The compact creation dialog has only a **Name** input; the captured selection supplies
membership. No notes, files, folders or links are modified. Inside an opened subgraph,
**Remove from subgraph** in a node or selection menu returns those members to the parent graph,
placed where they were combined; removing every member is the same as **Ungroup subgraph**.
Ungroup also returns members to the place where they were combined (moves made inside are kept),
restores orbits around nodes outside the subgraph when those nodes are in the parent graph, and
moves a grid-pinned member to the nearest free cell if another node took its cell. Each subgraph
stores this as `origin` in the layout; subgraphs created before it ungroup around their container.

The parent graph always shows a hollow standard ball with a thicker outer outline.
There is no in-place expand/collapse. Outside links are aggregated onto the container,
deduplicated and used by the ordinary node physics. The container supports the normal
drag, selection, exact/grid/orbit pin, Strong pull, color, aura, size and link actions.

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
physics immediately. Opening a root or subgraph pane restores saved positions and camera,
then lets free nodes settle automatically without a click. Manual pins and orbit constraints
are retained. Explicit Load/Reset layout restoration stays paused. A stale pane after a
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
- `filter`: keep the target and directly linked nodes visible; name filtering includes all same-name nodes and their connections

Flow:

1. Choose mode (`find` or `filter`).
2. Enter a value after the default `name:` prefix, or choose another query type from the dropdown.
3. Select a suggestion to apply target node.
4. Clear the query value to reset highlighting/filter; the type prefix remains.

## Right-Click Context Menu On Node

The sidebar keeps Search first and Layout last. Its Settings section groups existing controls
into Groups (groups, and Filters with Exclude / Include only rules, file visibility and attachments), Display, Physics and
Sets (selection modifiers and custom lists) tabs. The chosen tab survives rebuilds and layout changes without changing physics.

**Visual settings** provides per-node sliders for node size, link width,
text zoom, text size and hover dimming. Notes and attachments use the same size controls.
Node size supports 0.1-2 in both menus. **Text zoom** supports 1-40 steps in both menus. **Node color** sets the global base color or
an individual override; individual color takes priority over Groups, then the global base.
**Color aura** is available only in individual settings: 0 disables it (the default),
and its 0-5000 scale corresponds to a radius of 0-500 graph units.
**Aura brightness** controls opacity from 0 to 50%, defaulting to 22%.
Both controls are individual-only; the gradient uses the node's color.
The aura does not affect physics or the mouse hit area.
Each value inherits the main panel setting until changed; one **Reset visual settings**
action restores all visual inheritance and clears this node's link painting.
Gravity nodes omit link settings, link painting and Strong pull.
Hover dimming controls how much this node fades when another node is focused. Link widths
are physical screen pixels (0.1-5) and apply to incident links; if both endpoints override a
width, the larger override wins.
Link color, opacity and arrow toggles inherit individual > group > global, preferring the stored source at equal priority. Reverse arrows is visual-only and appears only when arrows are on. The **Strong pull** slider (0 = off, up to 20) sits right below Visual settings and targets the node/eligible selection, or the group when opened from group settings; visual reset never resets force multipliers.
Visual changes do not restart physics. Overrides follow layout Save, Load and autosave,
and are included in static HTML export. Grid, graph-wide visibility and physics settings
are not individual visual overrides.

Notes with `url` or `path` YAML properties have **Open URL** or **Open path** actions
in their node's right-click menu. Each property accepts a string (as before) or a
list of strings. List entries can be raw targets or quoted Markdown aliases:

```yaml
---
url:
  - https://example.com
  - '[Dashboard](https://example.com/dashboard)'
path:
  - '[Project](/home/user/projects/example)'
  - '[Schema](Schemas/schema.sql)'
---
```

Either property can be used on its own. URLs open in the default browser. Vault-relative file
paths open in Obsidian; external files and folders open through the desktop's default application.
Paths can be absolute, vault-relative, or start with `~/`. External paths must exist on the
current device. The note and normal node click behavior are unchanged.
Only HTTP(S) URLs and local paths or `obsidian://open?...` path links are supported.
Empty or invalid list entries are ignored. Targets always appear in a hover submenu,
even with one target, so its alias stays visible. Aliases are plain text; raw URLs show host and path, raw paths show the basename.
Long labels are shortened; hover a choice to see its full target. Quote aliases in YAML,
including targets containing spaces or parentheses. Hovering **Add URL or path** choices or
**Edit** in the node menu shows this syntax.

Right-clicking a selected node targets the entire selection. Right-clicking an unselected
node targets only that node, without changing selection. Empty canvas offers compatible
actions for the selection, without picking an arbitrary node. Targets are captured when
the menu opens; removed nodes are ignored and switching layout invalidates old actions.

The ordinary **Copy** submenu copies names, vault paths and available system paths, one
per line. **Ctrl+C** / **Cmd+C** copies selected names through the same action, except in
text inputs or when native text is selected. Menu titles do not show node counts, to keep
menus narrow on mobile; actions apply only to eligible targets. Exact/grid pinning and unpinning support selections; unchanged
exact pins and already-grid pins are skipped. Grid placement reserves unique cells,
excludes batch targets' old pins, preserves unchanged grid pins and protects outsiders.
Grid occupancy ignores stale pins for nodes absent from the current graph or outside
the current graph scope, so they do not block available cells. Pinned nodes hidden by
blacklist, a hidden group or a filter keep their cells. Dragging a grid-pinned node over
such a cell shows a faint dashed ring with **Hidden: <name>**, with or without the visible
grid; on release the node takes the nearest free cell and a notice names the hidden holder
(API pin and move results return a `GRID_CELL_HELD_BY_HIDDEN_NODE` warning instead).

Basic **Visual settings** and reset apply to eligible selected nodes. Mixed values are marked **Mixed**, including colors, without writing
anything on opening. Link controls omit gravity nodes. In a multi-node menu, file opening/properties, rename, deletion, linked/orbit-center
operations and native plugin actions remain single-only under
**Only for <name>**. Deletion never becomes a batch operation. Blank-canvas selection
menus have no single-only actions.

For one effective target, the menu is arranged in this order:

- **Copy system root**, then **Copy**: Obsidian URL, vault-relative path, linked names and linked paths.
- **Open path**, **Open URL** (each ends with **Edit**, which opens the note on that YAML line), **Add URL or path** when the note lacks one (adds the empty property and opens the note in its usual view mode; in source mode the cursor lands on that line), then **Open**: same tab, new window, default app, system explorer and file navigation.
- **Pin node**, **Pin to grid**, **Pin linked**, and **Unpin node**. Linked actions include both notes and attachments.
- **Visual settings**: text size and link appearance, with visual reset independent of force settings; **Strong pull** right below it is a 0-20 slider, where 0 is off.
- **Select linked nodes** and **Combine linked** (the note and its direct links into a subgraph) as their own block, then **Add to list** and **Other**: move, bookmark, merge, add to search and local graph.
- **Delete** at the bottom uses Obsidian's normal deletion confirmation.

Actions appear only when applicable: YAML actions require the corresponding property, unpin actions require matching pins, and linked actions require linked nodes. The text-size slider changes the effective targets; **Reset visual settings** removes their overrides.

## Layout Persistence

- Layout rows: click one to make it active; **New layout...** saves the current graph under a new name
- `Save layout`: stores current node positions and pin states in the active layout
- `Load layout` command: restores the active layout's saved snapshot
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
