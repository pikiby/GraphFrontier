# Settings

GraphFrontier settings are mainly controlled in the right side panel inside the view.

## Visibility Toggles

- `Show grid`: show/hide background grid
- `Existing files only`: hide unresolved links or non-existing targets
- `Show orphans`: show/hide nodes with no links
- `Show attachments`: show/hide non-markdown files as graph nodes

If `Show attachments` is enabled, additional controls appear:

- `Attachment size`: scale of attachment node radius
- `Attachment link distance`: target edge distance for attachment links

## Visual Controls

- `Grid step`: world-space grid spacing
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
- `Link distance`: target length for regular edges
- `Strong pull x`: multiplier used by strong pull action
- `Orbit distance`: spacing used when distributing orbit-pinned nodes
- `Repel strength`: node-to-node repulsion force
- `Repel radius`: cutoff distance for repel calculations (larger value means wider repel influence)
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
