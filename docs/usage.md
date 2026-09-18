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

## Related Docs

- Settings: `settings.md`
- Hotkeys: `hotkeys.md`
- Physics model: `physics.md`
