# Settings

GraphFrontier settings are mainly controlled in the right side panel inside the view.

## Visibility Toggles

- `Show grid`: show/hide background grid
- `Existing files only`: hide unresolved links or non-existing targets
- `Show orphans`: show/hide nodes with no links

The collapsible `Attachments` section sits between `Display` and `Physics` and
contains `Show attachments`, the visibility toggle for non-Markdown graph nodes.
When enabled, it reveals `Show unlinked attachments` (off by default, stored per layout).
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
attachments obey the filter, and excluded attachments' edges are omitted.
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

- `Grid step`: world-space grid spacing
- `Grid thickness`: grid line width, 0.1-1 CSS px in steps of 0.1, independent of zoom; default 1 preserves the original appearance. Stored per layout and included in static HTML exports; legacy layouts default to 1.
- `Node size`: node radius scale, 0.1-4
- `Node color`: base color for nodes without a group or individual color
- `Edge width`: regular edge thickness
- `Painted edge width`: thickness for painted edges only
- `Text zoom`: how far labels stay visible when zooming out, 1-40 steps
- `Text size`: base label font size
- `Hover dimming`: how strongly non-focused elements are dimmed

## Individual Visual Settings

Right-click a node and open **Visual settings** to override applicable visual controls.
Individual color overrides Groups; otherwise the first matching group overrides the base color.
One **Reset visual settings** action clears visual overrides and edge painting, not pins or forces.

Only this menu exposes **Color aura** (0-5000, corresponding to 0-500 graph units)
and **Aura brightness** (0-50%, default 22%). Auras default off and do not affect physics.
Gravity nodes omit edge controls and Strong pull. Overrides are stored with the layout and
included in static HTML exports.

## Force And Layout Controls

- `Link strength`: spring force for link attraction
- `Link distance`: target length for all graph edges
- `Strong pull x`: multiplier used by strong pull action
- `Orbit distance`: spacing used when distributing orbit-pinned nodes
- `Repel strength`: node-to-node repulsion force, 0-200; default 51
- `Repel radius`: cutoff distance for repel calculations, 20-1000; default 265 (larger value means wider repel influence)
- `Center strength`: pull toward layout center
- `Damping`: per-frame velocity damping

## Groups

Group rows define color rules for nodes based on query expressions.

Supported query patterns:

- `name:<value>`
- `tag:<value>`
- `path:<value>`
- `file:<value>`
- `line:<value>`
- `section:<value>`
- `[property]:<value>`

Behavior:

1. Higher row order has higher color priority.
2. First matching enabled group provides node color.
3. Group rows can be reordered by drag-and-drop.

## Save/Load Row

- `Autosave`: saves layout after movement settles
- `Save layout`: save positions, settings, pins, camera and any exact API node subset
- `Load layout`: restore saved layout snapshot

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
