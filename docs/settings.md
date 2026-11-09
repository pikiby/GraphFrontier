# Settings

GraphFrontier settings are mainly controlled in the right side panel inside the view.

Note YAML `url`/`path` syntax (strings, lists and quoted aliases `'[Label](target)'`) is shown
on hover over **Add URL or path** and **Edit** in the node menu. See
[quick-open navigation](usage.md).

## Sets

**Add to search** chooses the modifier for adding a clicked node name to the search
field (default: **Alt**; **None** disables it). On conflicting shortcuts, node
selection takes priority, followed by Add to search, then quick preview.
Local GraphFrontier starts with its settings panel hidden; click **Show** to open it.

## Visibility Toggles

- `Show grid`: show/hide background grid
- `Existing files only`: hide unresolved links or non-existing targets
- `Show orphans`: show/hide nodes with no links

`Show attachments` sits in `Settings` -> `Groups` -> `Filters` and is the visibility toggle
for non-Markdown graph nodes. When enabled, it reveals the file types search,
`Show unlinked attachments` (off by default, stored per layout) and the attachment node color.
When both are enabled, all vault non-Markdown files are included, even without note links.
`Show orphans` still applies: unlinked attachments remain hidden when it is off.

The `File types` search appears only with `Show attachments` enabled. It uses the
full-width shared search field and suggestion menu, without a separate left label.
The permanent `File type:` prefix stays visible and protected while editing and
in the selection summary (`All file types`, selected formats, or `No file types`).
Each selection immediately updates that summary while keeping the menu and active
filter intact. The next typing starts a fresh query; `pdf` and `.PDF` match alike.
Focusing starts an empty query after the prefix, not a search for that summary.
The inline clear button clears only the search, never the selection.
Focus, click, or type in the input to open an anchored menu; typing filters the
scrollable list without moving focus from the inline input. The menu lists actual non-Markdown vault extensions
and file counts (case-insensitive), including `No extension`. Counts refresh each
time the control opens. Checked formats are allowed; both linked and unlinked
attachments obey the filter, and excluded attachments' links are omitted.
The menu is capped at 248px (about six 34px rows), with a separately scrolling
list and pinned compact `All` / `None` controls. It fits above or below the input
within the visible viewport, including when the mobile keyboard opens.
`All` / `None` actions affect matched formats while searching, or all
current formats with an empty query. Mouse and keyboard selections keep the shared
menu open. Escape, blur, or an outside click closes it and restores the summary
without reopening it.
Exclusions are stored per layout in `excluded_attachment_extensions`
(lowercase strings, `""` for no extension); missing formats retain their exclusions,
and newly encountered formats are allowed by default. The same array can be patched
through the settings API. Markdown and existing global filter rules are unchanged.
Changing either attachment toggle refreshes graph data; no file or folder selection is needed.
`Attachment node color` uses the existing color picker and is stored per layout as
`attachment_node_color`: a hex color or `null` (default). Null inherits the actual
`Node color`, including custom colors in existing layouts; the picker displays that
inherited color until chosen. The settings API accepts `null` to restore inheritance.
Color priority is individual node color, matching group, attachment default (attachments
only), then global node color. Notes are unchanged.
Attachments use the same global/individual `Node size`, global `Link distance` and
ordinary topology-based forces as notes. Labels use the same zoom thresholds and
individual text overrides. Attachment labels include the file extension, preserving
its case, in the graph and static HTML export. Hover highlighting and ordinary labels
remain, but there is no separate hover name plate. Manual exact/grid/orbit pinning is unchanged.
Legacy attachment size, link-distance and interaction settings are discarded on load,
including saved layout settings and the old individual attachment-size override.
Other settings, overrides, positions and pins are preserved; no replacement overrides are created.

## Visual Controls

The sidebar order is `Search`, `Settings`, `Layout`. Search and layout actions are unchanged.
Settings has four compact tabs: `Groups`, `Display`, `Physics`, `Sets`. Groups holds two
collapsible subgroups, Groups and Filters: one list of rules and, below a divider,
`Show only groups` (hide notes that match no group), `Existing files only`, `Show orphans` and
`Show attachments`. Each rule's three-dot button opens a menu with an
**Exclude / Include only** switch (blacklist / whitelist) and Delete rule; in Groups,
Filters and Custom lists rows are reordered by their handle, the handle and buttons appear once
you finish editing a row, and each editor keeps a single empty row; a
summary shows how many notes the rules hide; Sets holds two
collapsible subgroups, Selection (modifiers) and Custom lists. All controls keep
their previous behavior. Left/Right arrow keys switch tabs, Home/End select the first/last.
The selected tab is a global UI preference, not part of named layouts or backup payloads;
Load and restore keep the current tab. Local Graph keeps its own workspace UI state and
starts with its sidebar closed, as before.

`Display` groups its controls without titles: general, nodes, text, links, background and grid.

- `Dim low-degree nodes`: off by default. Nodes with established graph degree 0 or 1 use 65% opacity; hover, selection and search highlights remain fully visible. Live canvas and HTML export use the same degree, not a degree recalculated from the screen filter.

- `Hover dimming`: how strongly non-focused elements are dimmed
- `Hover color`: color of highlighted links and of the hover ring. Until a color is picked,
  highlighted links keep their own color and move it towards the theme text color, and the
  ring uses the theme selection color. A picked color is reached smoothly, also by painted links.
- `Node color`: base color for nodes without a group or individual color
- `Node size`: node radius scale, 0.1-2 in steps of 0.005. The radius is proportional to it at every value, so
  the size ratio between nodes of different degree is kept. As in Obsidian's graph, nodes grow and shrink with the
  square root of zoom on screen: zooming out four times halves them. Hit testing, labels and
  selection follow the same radius; the color aura stays in graph units.
- `Text zoom`: how far labels stay visible when zooming out, 1-40 steps
- `Text size`: base label font size
- `Link color`: base color of regular links. It follows the theme until a color is picked.
  Individual colors (including legacy painting) and group link colors take priority.
- `Link opacity`: 0-1, default 1, applied to every link at rest. Highlighted links become
  fully opaque, as do highlighted nodes and their neighbors.
  Links of the same appearance are stroked together, so translucent links do not darken where
  they cross or overlap. The grid is not affected.
- `Link width`: thickness in physical screen pixels, 0.1-5, like Obsidian's link
  thickness, for regular and painted links alike. It does not change with zoom. Highlighted
  links (hover, Find connections, HTML-export selection) grow relative to their own width: to
  at least twice as thick and one physical pixel thicker, capped at 12. They keep their
  own color, link color or painted color, and move it smoothly towards the theme text color,
  or towards `Hover color` when set.
- `Show grid`, `Grid step`: background grid and its world-space spacing
- `Show arrows`: off by default; references point source to target. Reciprocal references show two heads, with one physical spring. `Reverse arrows` appears only when arrows are enabled and changes visuals only.
- `Custom background`: off by default (theme). Enable it to reveal a color swatch; disabling retains the chosen color.
- `Grid color`: theme color until a custom swatch color is selected. `Grid opacity`: 0-1, with theme opacity until changed.
- `Grid thickness`: grid line width, 0.1-2 CSS px in steps of 0.1, independent of zoom; default 1 preserves the original appearance. Stored per layout and included in static HTML exports; legacy layouts default to 1.

Lines thinner than one canvas pixel are drawn exactly one pixel wide with proportionally lower
opacity, so very thin links, grid lines and outlines fade instead of breaking into dashes.

### Updating from earlier versions

Data and layouts saved before render model 2 are converted once when they are loaded, and the
result is marked with `render_model: 2`; new data and layouts are created with the mark.

- Node sizes keep the look of unlinked nodes under the former radius ceiling: the new value is
  `min(4 * max(1, s / 2), 2.2 * s) / 2.2`, limited to 0.1-2. Sizes up to about 1.8 are
  unchanged; larger ones settle at the new maximum 2. High-degree nodes are no longer clipped,
  so they can look larger than before.
- Link widths were CSS pixels and are now physical pixels: global, saved-layout and individual
  widths are multiplied by the device pixel ratio of the first device that opens the graph,
  limited to 0.1-5, so lines keep their thickness.
- The separate painted link width and the short-lived Sharpness setting are removed.
- The original values and the device pixel ratio are kept in `legacy_render_settings`.

A layout file that was not opened since the update is converted when it is next loaded.
Link color, link opacity and hover color are stored per layout like other settings and are
included in static HTML exports.

## Individual Visual Settings

Right-click a node and open **Visual settings** to override applicable visual controls.
Individual color overrides Groups; otherwise the first matching group overrides the base color.
One **Reset visual settings** action clears visual overrides and link painting, not pins or forces.
Link color, opacity and arrows also appear in the shared node/group menu. Individual overrides beat group overrides, then global values; at equal priority the stored source wins, regardless of visual reversal. Width retains its maximum-endpoint rule. An explicit false overrides inherited true. The color picker replaces legacy painting for that target; old painting commands/API remain compatible.

Only this menu exposes **Color aura** (0-5000, corresponding to 0-500 graph units)
and **Aura brightness** (0-50%, default 22%). Auras default off and do not affect physics.
Gravity nodes omit link controls and Strong pull. Overrides are stored with the layout and
included in static HTML exports.

## Force And Layout Controls

- `Link strength`: spring force for link attraction
- `Link distance`: target length for all graph links
- `Orbit distance`: spacing used when distributing orbit-pinned nodes
- `Repel strength`: node-to-node repulsion force, 0-200; default 51
- `Repel radius`: cutoff distance for repel calculations, 20-1000; default 265 (larger value means wider repel influence)
- `Center strength`: pull toward layout center
- `Damping`: per-frame velocity damping

## Groups

Group rows define visual rules for nodes based on query expressions. By default,
only color changes. Each row has one round button filled with the group color and
marked with a settings icon; it opens the same visual settings menu used for
individual nodes, where the group color is changed with the other settings. **Reset visual settings** clears the additional
visual overrides and keeps its rule color and Strong pull. The same menu also
provides **Link color** and a **Strong pull** slider. The slider goes from 0 (off) to 20:
node menus change only the targeted eligible nodes; group menus store a group multiplier and
enable Strong pull. Individual values override group values, so 0 on a node turns off the pull
it would inherit from a group. Visual reset preserves Strong pull and its multiplier.

Supported query patterns:

- `name:<value>`
- `tag:<value>`
- `path:<value>`
- `file:<value>`
- `line:<words>`: every word, or `"quoted phrase"`, occurs in one line of the note text, as in
  Obsidian search. Note text is read the first time a `line:` query is used.
- `section:<value>`
- `[property]:<value>`
- `list:<id or name>` (node list)

Behavior:

1. Individual node settings take priority over groups.
2. For each setting, the first matching enabled group that defines it wins;
   otherwise the global setting is used. Every group still defines its color.
3. Group rows can be reordered by drag-and-drop.
4. The eye icon at the right edge of the query field hides or shows a group's nodes. A node that
   matches at least one hidden group is hidden, exactly like a blacklist match: it leaves
   the graph, physics and HTML export, while gravity centers stay visible. Hidden rows are
   dimmed. Whitelist rules and search apply to the remaining nodes. The flag is saved with
   the group in the layout and accepted by the API as `hidden`.
5. Alt-click the eye to solo a group: every other group is hidden. Alt-click the same group
   again to restore the previous hidden set; a plain click leaves solo mode. The previous
   set is remembered only until the view is reloaded.
6. The **Filtering: Hide / Exclude** switch at the top of Groups chooses what hiding a group
   means (hover either word for a short explanation). Any change to which nodes take part in
   physics — the eye, solo, this switch, blacklist/whitelist or filters — wakes a settled
   layout so it adapts immediately.
   **Exclude** (default) is the behavior above. **Hide** only stops drawing the nodes and
   their links: they keep their place in physics, still push and pull their neighbours,
   and reappear where they were. Hidden nodes cannot be hovered, clicked, box-selected or
   found by search, and HTML export and the API leave them out in both modes. Grid cells
   held by hidden pinned nodes stay occupied in both modes. The mode is saved in the
   layout settings as `group_hide_mode` (`exclude` or `hide`). With subgraphs, hidden
   groups are always excluded.

### Node lists

**Custom lists** sit in the **Sets** tab below the selection modifiers and use the same
rows as groups. Edit a list's name in place. The round button opens **Add selected notes** (only
with a selection), **Members** (click notes to remove them; the submenu stays open), **Create group**
(adds a `list:<id>` group) and **Delete list**. Drag a list by its handle to reorder
it. Type a name in the last row to
create a list; selected notes are added to it. Group, filter and list fields save when
you press Enter or leave the field.

Open **Settings → GraphFrontier → Node lists** to create, rename or delete lists and
search all lists and edit their members. Open a list to see filenames and paths,
remove members, or use **Add files...** to search the vault and select multiple files.
Rename, delete and **Copy list ID** are in the list's **...** menu. The node menu's
**Add to list** also supports a multi-node selection. Use `list:` in a group's
query to select a list by ID or name. New lists take their ID from the name when it has
Latin letters or digits, so a group keeps working after its list is deleted and created again.

Lists only define membership, not appearance. They are stored separately in
`node-lists.json` inside the plugin folder and shared across layouts and local
graphs. Missing paths are retained and counted in the editor. File/folder renames
inside Obsidian update membership. Lists do not force filtered nodes into view.
Membership changes update visuals. Strong pull groups also wake physics when their
membership changes.

## Layout

Every saved layout is a row, like groups and Custom lists; the active one is outlined.
Click a row to make that layout active. Its round button opens **Rename** (edit the name in
place, saved on Enter or blur) and **Delete layout**. Type a name in the last row,
**New layout...**, to save the current graph as a new layout and make it active; an existing
name is never overwritten.

- `Autosave`: saves the active layout after nodes settle, and right after settings, colors,
  groups or rules change; switching to another layout or closing the view first saves changes
  that are still pending. Settings tabs, collapsed sections and the camera alone do not trigger it
- `Save layout`: save positions, settings, pins, camera and any exact API node subset to the
  active layout
- The `Load layout` command restores the active layout's saved snapshot

MCP `save_layout` additionally permits saving a nonempty search query. Manual
Save and normal autosave retain their existing nonempty-search restriction.
Collapsed sections are stored as global UI preferences rather than per-layout
state. See [API layouts and backups](mcp.md#layouts-and-backups).

## Local MCP

Desktop Obsidian's `Settings -> GraphFrontier -> Local MCP` provides the optional
server toggle, port, status, token management and client configuration examples.
MCP is off by default and listens on localhost only. Its private `mcp.json`
configuration is separate from layout data. See [setup and API reference](mcp.md).

## Related Docs

- Usage: `usage.md`
- Physics: `physics.md`

## Backups

Open **Settings → GraphFrontier → Backups**. Automatic backups are enabled by
default and maintain one current file at
`GraphFrontier backups/graphfrontier-backup.json`, outside the installed plugin
folder. It includes all layouts, node lists and general preferences, not MCP
tokens. Change the vault-relative folder or disable automatic backups here.
**Back up now** works even when automatic backups are disabled.

A copy from a previous installation is protected until you explicitly restore it
or confirm replacement. Leaving settings and restarting Obsidian
do not remove that protection. The default folder is detected after reinstall;
if you previously chose another folder, select it again in **Backups**.

Restore shows the layout/list counts and asks for confirmation. It replaces matching
layouts, all lists and current preferences; unrelated layouts are retained. The
source backup remains intact during restoration. A failed write attempts rollback
of working files; corrupted backups are never automatically overwritten.

Before updating a backup, GraphFrontier verifies a temporary `.recovery` copy.
It is removed only after the new backup has been read back successfully. If a
write is interrupted, the recovery copy is protected and available through
**Restore**; it is not a rolling backup history. The first backup is verified
in a temporary file before being moved to its final path. Windows reserved
folder names are rejected on all platforms.

This protects against plugin reinstallation, not loss of the vault itself.
