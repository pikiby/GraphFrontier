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

## Search Row (Find / Filter)

The top search row supports two modes:

- `find`: focus/highlight a target node and relations visually
- `filter`: keep only target node and directly linked nodes visible

Flow:

1. Choose mode (`find` or `filter`).
2. Type query.
3. Select a suggestion to apply target node.
4. Clear the search row to reset highlighting/filter.

## Right-Click Context Menu On Node

Typical operations:

- Strong pull / Clear strong pull
- Paint edges / Clear painted edges
- Pin node / Pin to grid / Unpin node
- Pin linked nodes / Pin linked nodes to grid
- Pin linked to orbit / Unpin linked nodes
- Add to search
- Show local graph (for markdown files)

## Layout Persistence

- `Save layout`: stores current node positions and pin states
- `Load layout`: restores previously saved layout
- `Autosave`: optionally saves layout after graph stabilizes

If search row is active, save is blocked to avoid saving filtered/focus state as final layout.

## Related Docs

- Settings: `settings.md`
- Hotkeys: `hotkeys.md`
- Physics model: `physics.md`
