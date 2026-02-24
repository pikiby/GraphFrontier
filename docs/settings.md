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
- `Node size`: node radius scale
- `Edge width`: regular edge thickness
- `Painted edge width`: thickness for painted edges only
- `Text zoom`: how far labels stay visible when zooming out
- `Text size`: base label font size
- `Hover dimming`: how strongly non-focused elements are dimmed

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
- `Save layout`: save positions + settings + pin states
- `Load layout`: restore saved layout snapshot

## Related Docs

- Usage: `usage.md`
- Physics: `physics.md`
