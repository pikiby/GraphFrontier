# Local Graph API and MCP

Available starting with **GraphFrontier 0.8.0**. This release includes a
desktop-only MCP server inside GraphFrontier.
There is no separate service to install or start. JavaScript dependencies are
bundled into `main.js`; users do not need npm or a separate Node installation.
The embedded server requires the Node 18+ runtime and Web Fetch APIs supplied
by a sufficiently recent desktop Obsidian installer. Failure to start MCP does
not disable the graph. Mobile keeps the graph but does not load the server.

## Enable

Open **Settings -> GraphFrontier -> Local MCP** and enable MCP. The default port
is `27125`, bound only to `127.0.0.1`. A random access token is generated on first
enable. Use a different port for each vault. The settings page shows status,
provides **Copy token**, and displays configuration examples.

The server starts when the enabled plugin loads, independently of graph tabs.
Closing a graph tab leaves MCP running; disabling MCP or the plugin stops it.
Without an open graph, `list_views` returns an empty list. A tab is opened only
by an explicit `graph_action` with `action: "open"`. Closing Obsidian makes the
endpoint unavailable.

Settings and the token live in `<configDir>/plugins/graphfrontier/mcp.json`, not
`data.json` or `layouts/`. Keep that file private and exclude it from public Git
repositories, exports and sharing. Vault sync can copy it to another device.
Changing layouts never changes the MCP token or port. A malformed configuration
is not overwritten; MCP stays off and reports the problem.

## Client Configurations

All clients use the same Streamable HTTP endpoint and Bearer authentication.
Set `GRAPHFRONTIER_MCP_TOKEN` in the environment used to launch the client to
the token copied from Obsidian. Merge the example with your existing settings;
do not replace other servers. GraphFrontier never changes client configs itself.

### Codex

In `~/.codex/config.toml`:

```toml
[mcp_servers.graphfrontier]
url = "http://127.0.0.1:27125/mcp"
bearer_token_env_var = "GRAPHFRONTIER_MCP_TOKEN"
```

See the [official Codex MCP documentation](https://developers.openai.com/codex/mcp).

### Claude Code

In the project's `.mcp.json`:

```json
{
  "mcpServers": {
    "graphfrontier": {
      "type": "http",
      "url": "http://127.0.0.1:27125/mcp",
      "headers": {
        "Authorization": "Bearer ${GRAPHFRONTIER_MCP_TOKEN}"
      }
    }
  }
}
```

Claude Code expands the environment variable in the header. See its
[official MCP documentation](https://code.claude.com/docs/en/mcp).
This is a Claude Code profile, not a guarantee that every Claude Desktop or
cloud connector can reach local HTTP. Stdio-only clients need an adapter.

### OpenCode 1.x

In `opencode.json` or `opencode.jsonc`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "graphfrontier": {
      "type": "remote",
      "url": "http://127.0.0.1:27125/mcp",
      "enabled": true,
      "oauth": false,
      "headers": {
        "Authorization": "Bearer {env:GRAPHFRONTIER_MCP_TOKEN}"
      }
    }
  }
}
```

Here `remote` means HTTP rather than a subprocess; the address is still local.
OAuth is disabled because this server uses a local access token. See the
[official OpenCode documentation](https://opencode.ai/docs/mcp-servers/).
For other major client versions, check their configuration schema and negotiated
protocol support rather than assuming this 1.x example applies unchanged.

## Tools and Internal API

### Node lists and group visuals

`list_node_lists` returns the vault-wide lists. `node_lists` changes their
membership without requiring an open graph or a layout context token:

```json
{
  "name": "node_lists",
  "arguments": {
    "action": "add",
    "listId": "problems",
    "nodeIds": ["Nodes/Airflow/example.md"]
  }
}
```

Create a list in **Node lists...**, or use `action: "create"` with `name` and an
optional `listId`. Other actions are `rename`, `delete`, `remove`, and `replace`.
Add/remove are idempotent; replace accepts the complete current membership,
including an empty array. Paths must be vault-relative; missing files are
retained. Calls are persisted independently of layouts and never write notes.

Use a group query `list:problems` to style its members. `edit_rules` group entries
accept an optional `settings` object with existing visual keys such as
`aura_radius`, `aura_brightness`, `node_size_scale` and `label_font_size`.
Keep color in the existing `color` field. Passing `settings: {}` clears the
group's additional overrides. These operations reuse the existing MCP endpoint
and authentication; no additional HTTP service is introduced.

Start with `list_views`. Use an explicit `viewId` from its result. Saved layouts
are shared plugin state, not independent layouts per tab.

| MCP tool               | Internal API method        | Purpose                                                                                   |
| ---------------------- | -------------------------- | ----------------------------------------------------------------------------------------- |
| `list_views`           | `listViews()`              | Vault identity and open graphs                                                            |
| `get_state`            | `getState(args)`           | Layout, counts, camera and context token                                                  |
| `get_selection`        | `getSelection(args)`       | Explicit selection, separately from search focus                                          |
| `get_graph`            | `getGraph(args)`           | Bounded pages of nodes or edges, no note content                                          |
| `select_nodes`         | `selectNodes(args)`        | Replace selection; empty `nodeIds` clears it                                              |
| `frame_nodes`          | `frameNodes(args)`         | Frame selected IDs without moving the nodes                                               |
| `get_configuration`    | `getConfiguration(args)`   | All global settings, rules, gravity nodes, hotkeys, UI state                              |
| `update_settings`      | `updateSettings(args)`     | Patch any global setting: physics, appearance, attachments, autosave, modifiers           |
| `get_node_settings`    | `getNodeSettings(args)`    | Individual overrides and effective settings, pins and force                               |
| `update_node_settings` | `updateNodeSettings(args)` | Individual colors, aura, sizes, labels, edge color and strong pull; reset overrides       |
| `edit_rules`           | `editRules(args)`          | Add/update/remove/replace/clear groups, blacklist and whitelist                           |
| `search_nodes`         | `searchNodes(args)`        | Find nodes using existing typed-query matching without changing the UI                    |
| `set_search`           | `setSearch(args)`          | Set/clear Search, choose find/filter, toggle linked highlighting                          |
| `highlight_nodes`      | `highlightNodes(args)`     | Highlight explicit IDs and optionally their neighbors                                     |
| `set_visible_nodes`    | `setVisibleNodes(args)`    | Exact node subset with its internal edges; null clears it                                 |
| `set_camera`           | `setCamera(args)`          | Exact position/zoom or fit; restores a previously read camera                             |
| `move_nodes`           | `moveNodes(args)`          | Explicit coordinates with keep/exact/grid/none pin behavior                               |
| `pin_nodes`            | `pinNodes(args)`           | Pin/grid/unpin explicit/all nodes, or pin/grid/orbit/unpin linked nodes and attachments   |
| `gravity_nodes`        | `gravityNodes(args)`       | Create, update or delete gravity nodes; typed queries, attraction and repulsion           |
| `subgraph_nodes`       | `subgraphNodes(args)`      | Layout-only containers: create, rename, open an independent pane, Ungroup                 |
| `list_layouts`         | `listLayouts(args)`        | Saved layout names and current layout                                                     |
| `create_layout`        | `createLayout(args)`       | Create from current graph or saved source; optionally activate                            |
| `save_layout`          | `saveLayout(args)`         | Save current state; back up an existing destination first                                 |
| `load_layout`          | `loadLayout(args)`         | Switch/reload settings, positions, search, subset and camera                              |
| `delete_layout`        | `deleteLayout(args)`       | Back up and delete; retain at least one readable layout                                   |
| `backup_layout`        | `backupLayout(args)`       | Copy a saved layout; ensure=true reuses an identical backup                               |
| `list_backups`         | `listBackups(args)`        | Paginated backup IDs, original names and dates                                            |
| `restore_layout`       | `restoreLayout(args)`      | Restore a backup to its original or a new layout; optionally activate                     |
| `get_export_locations` | `getExportLocations(args)` | Return vault name and vaultRelative=true; home and desktop are null                       |
| `export_html`          | `exportHtml(args)`         | Static interactive HTML, optional exact node subset and note previews                     |
| `graph_action`         | `graphAction(args)`        | Open/refresh, pause/resume, align pins, select linked, arm box selection, clear selection |
| `update_ui`            | `updateUi(args)`           | Panel visibility, collapsed sections and command hotkeys                                  |
| `node_action`          | `nodeAction(args)`         | Copy names/paths/links; open note/path/URL/local graph; quick preview                     |

These methods are available on the plugin instance's `api` property while it is
loaded. MCP and internal consumers call the same implementation.
There is no separate REST route for each action: external callers initialize an
MCP session, discover schemas through `tools/list`, then use `tools/call`.
Internal integrations can use `api.runTool(methodName, args, readOnly, signal)`
to share the MCP operation queue and cancellation handling; use `readOnly: false`
for any method that mutates state. Direct method calls do not enter that queue.

The tools have strict discoverable input schemas. `update_settings.settings`
contains every current global setting and validates the same ranges as the UI.
Node visual ranges come from the shared `NODE_VISUAL_SETTINGS` catalog. Unknown
keys and invalid values fail before mutation rather than silently clamping.
Use `null` to remove an individual visual override, or `reset: true` with
`settings: {}` to reset the node's visual overrides. Gravity nodes reject edge
and strong-pull settings, just like their context menu.

`subgraph_nodes` (`subgraphNodes`) manages layout-only containers. Use `action: "create"`
with `name` and optional `memberIds` (otherwise the current selection). IDs are generated.
Only creation accepts membership. `rename` requires `id` and a nonempty `name`.
`open` opens/reuses a separate Obsidian pane and returns it as `openedView`;
`ungroup` removes the container and releases members at its current position plus their
latest local offsets. Neither action deletes notes. Open/Ungroup target a container in
its parent graph. The old `expand`, `collapse`, `update` and `dissolve` actions are rejected.
There is no in-place expansion or OS popout.

`get_graph` reports containers as `type: "subgraph"`; view state includes `subgraphId`
(null for the main graph), and `get_configuration` includes `subgraphs` definitions.
Movement/physics/pin operations use coordinates local to that view's graph. Moving a
container never translates its members. Normal node tools act in the targeted scope;
creating or moving a node in an inner pane does not wake unrelated parent physics.
Save from any pane merges local positions from all open graphs while retaining closed
spaces, the main camera/search and independent scoped cameras/filters. Mutations respect
autosave off. Reread state/context tokens after grouping or Ungroup. Old layouts migrate
to `subgraph_coordinates: "local-v1"` through normal layout loading; cross-space orbit
pins convert to exact local pins. Explicit layout restoration remains paused.

`select_nodes` and `frame_nodes` require `contextToken` from the latest state
and at most 500 `nodeIds`. Unknown or filtered IDs reject the whole operation.
An empty list is invalid for framing. A reload, layout change or graph rebuild
invalidates old tokens; reread state on `STATE_CHANGED`. Closing a view produces
`VIEW_NOT_FOUND`; calls after plugin unload produce `API_CLOSED`.

`get_graph` accepts `kind: "nodes" | "edges"`, `offset` (default 0), `limit`
(default 100, maximum 500), and `visibleOnly` (default true). Follow `nextOffset`
until it is null, even if a page is empty. Offsets refer to the source arrays;
one call scans at most 10,000 entries. Pass `contextToken` on subsequent pages
to detect graph rebuilds. Positions remain live; pages do not freeze physics.
`get_selection` also supports offset/limit pagination. `search_nodes` uses offsets
into the matching results, not the source node array; follow its `nextOffset` too.

New mutations also require `viewId` and `contextToken` (except opening a graph).
Mutating MCP calls are serialized across clients. Layout file commits use the
same queue as UI saves/autosave and loads. Reread state after loading a layout,
rebuilding the graph or creating/removing gravity nodes. An HTTP error after a
write is not proof that nothing happened: inspect the destination before retrying.

This is graph control, not arbitrary JavaScript execution or a generic note
editor. Native Obsidian/third-party menu actions such as bookmarking, merging
notes and deleting vault files are **not** exposed. Neither are MCP credentials
or server enable/port controls. Those stay in the local settings page. Blacklist
and whitelist are visual filters, not access control: `visibleOnly: false`
exposes hidden metadata, and explicit node IDs may be edited/exported even when
hidden. Selection/frame still require visible IDs.

### Rules, Search and Selection

Queries use `name:`, `path:`, `file:`, `tag:`, `line:`, `section:` or `[property]:`.
Bare text is rejected rather than reinterpreted. In `edit_rules`, choose
`list: "groups" | "blacklist" | "whitelist"` and `action`. Add/replace needs
complete queries; groups additionally need colors. Update accepts partial rows
with existing IDs. Remove takes `ids`; clear removes the entire selected list.
Replace also supports reordering. Other lists are untouched.

`set_search` follows UI behavior: name filtering shows a focused node and its
neighbors, while find highlights matching nodes. Use `set_visible_nodes` for an
exact arbitrary set, or `highlight_nodes` for explicit highlights independent of
a shared query. The exact subset intersects normal visibility filters and is
saved with the layout. Passing null removes the subset; an empty array hides
everything. Explicit highlight-only state is temporary and is replaced by a
subsequent search or graph refresh.

Node IDs refer to vault paths, not necessarily real filesystem paths. The current
`path:` matcher searches the graph's vault-relative file path. It does not search
a note's YAML `path` property; use `[path]:` for that property. Neither form is an
automatic resolver for externally linked folders. When given a system path,
find candidate nodes and verify them with `node_action`,
`action: "copy_system_path"`, `clipboard: false`. Do not substitute a similarly
named entity or repository note without confirming its identity.

`pin_nodes` accepts exactly one of `nodeIds`, `all: true` or `anchorId`. The
`anchorId` form operates on direct neighbors, not the anchor itself; pin the
anchor explicitly as well if requested. `targetKind` limits linked actions to
regular nodes, attachments or both. Orbit mode requires an anchor. Pinning fixes
position but keeps the node's repulsion, link influence and Strong pull toward
eligible free nodes. Notes and attachments use the same physics.

Copy actions return text; `clipboard: true` also writes it to the clipboard.
Linked names and paths use commas followed by line breaks, without a trailing
comma. Exported graph metadata and copy operations are not a general API for
reading or editing arbitrary file contents.

### Tool Call Examples

These are `tools/call` parameter objects, not complete JSON-RPC messages. The
client handles the MCP handshake and authentication. Replace `<viewId>` and
`<contextToken>` with values returned by `list_views`/`get_state`, and replace
example node IDs with IDs from the actual graph. Read fresh state after a graph
or layout change. Examples are independent, not a script to run blindly.

Set the global label size to its current maximum and disable layout autosave:

```json
{
  "name": "update_settings",
  "arguments": {
    "viewId": "<viewId>",
    "contextToken": "<contextToken>",
    "settings": { "label_font_size": 20, "layout_autosave": false }
  }
}
```

Give one node an individual color, size and aura without changing other nodes:

```json
{
  "name": "update_node_settings",
  "arguments": {
    "viewId": "<viewId>",
    "contextToken": "<contextToken>",
    "nodeIds": ["Architecture/API.md"],
    "settings": {
      "node_color": "#e9c46a",
      "node_size_scale": 2,
      "aura_radius": 300,
      "aura_brightness": 20
    }
  }
}
```

Append a whitelist rule without replacing existing rules:

```json
{
  "name": "edit_rules",
  "arguments": {
    "viewId": "<viewId>",
    "contextToken": "<contextToken>",
    "list": "whitelist",
    "action": "add",
    "rules": [{ "query": "tag:architecture", "enabled": true }]
  }
}
```

Ensure a backup exists for the currently saved file; use the returned `backupId`
with `restore_layout` if restoration is requested:

```json
{
  "name": "backup_layout",
  "arguments": {
    "viewId": "<viewId>",
    "contextToken": "<contextToken>",
    "name": "Architecture.json",
    "ensure": true
  }
}
```

For temporary work, remember that turning autosave off does not save a previous
unsaved state. Preserve that state in a separate layout only when requested.

### Layouts and Backups

Use filenames, not paths, for layouts. The existing plugin's filename rules
allow ASCII letters/digits, spaces, dots, hyphens and underscores; `.json` is
optional. MCP rejects traversal, reserved names and names that the normalizer
would silently rename. `create_layout` never overwrites; `activate` defaults to
true. Omitting `source` copies the current unsaved graph state; providing it
copies that saved file instead.

Backups are stored in `layouts/backups/`, not among selectable layouts. A backup
envelope preserves the original saved JSON text, layout name and timestamp.
The ID returned by `backup_layout` is accepted by `restore_layout`. Backups are
not silently removed. `ensure: true` reuses a byte-identical existing copy; a
changed file receives a new backup. This operation backs up the **saved file**,
not unsaved UI changes; create a new layout first to preserve current edits.

MCP save, delete and replacement during restore first create/ensure a backup of
the existing destination. If the copy cannot be read back, the destructive step
does not run. Deleting the last layout is rejected, as is deleting the active
layout when its fallback cannot be read. Restoring over the active layout loads
the restored version even if `activate: false`, avoiding immediate autosave of
the old in-memory state over the restored file. Backups protect against logical
replacement/deletion, not disk failure or edits by external programs.
Restoring a valid backup can also repair a corrupt destination: the damaged
bytes are preserved in a separate backup first. `list_backups.validLayout`
distinguishes those forensic copies from valid, restorable JSON layouts.

`save_layout` uses the shared snapshot/save routine with search-enabled capture:
positions, settings, pins, colors, gravity definitions, camera, search and exact
subset are preserved. The manual UI Save button's existing nonempty-search guard
is unchanged. Newly captured layouts restore their camera when reopened; old
layouts without the camera marker retain their original opening behavior.
Collapsed sections remain global UI preferences, not layout-owned settings.
Switching layouts discards unsaved edits, like the UI. Settings changes mark the
layout dirty; they do not bypass the user's autosave choice. Normal plugin
preference persistence to `data.json` is still separate from saved layout files.

### Export a Requested Subgraph

For a request such as "show only these notes and their links, then export to Exports/schema.html inside my
vault", a client can perform this sequence, rereading the token after graph
changes:

1. `list_views`, then `get_configuration` to inspect the current state.
2. `create_layout` with a new name if the user wants a separate layout. Disable
   autosave through `update_settings` while constructing it, if requested.
3. `search_nodes` with the user's typed criteria, following pagination. Use
   `get_graph` to inspect relationships. Resolve the intended IDs, not just names.
4. `set_visible_nodes` for the exact set; change styles/physics, position or pin
   nodes as requested; `set_camera` with `fit: true` frames the result.
5. `get_export_locations` identifies the vault and confirms vault-relative export.
   Ask for a folder/filename inside that vault if the requested location is external.
6. `export_html` with an explicit path, the chosen `nodeIds` and
   `includeContents: false` unless embedding Markdown previews is wanted.
7. `save_layout` only when the user requested persistence. Restore prior camera,
   selection/filter or layout if the requested operation was temporary.

Export reuses the existing HTML generator (pan/zoom, hover and Markdown preview).
With `nodeIds`, it contains only those nodes and edges whose two endpoints are
both included, even if other nodes are currently visible. Without `nodeIds`, it
exports current visibility. Node lists are limited to 500 per call; omit them to
export a larger visible graph. All platforms use vault-relative paths; absolute paths are rejected. A directory gets the default HTML filename.
Existing export files require `overwrite: true`; the plugin serializes its own exports and refuses to modify an existing file
without permission. Other applications and symlink targets are governed by the
Obsidian adapter; no cross-process atomic or physical-path sandbox guarantee is made. MCP exports do not change the remembered
UI export path. The result reports the actual filename and node/edge counts.
`includeContents` defaults to true, matching the existing export; use false to
omit note previews. Metadata such as paths/properties is still included.

## Safety and Verification

The listener validates Host, Origin and a constant-time Bearer token check.
Requests are limited to 64 KiB, 8 concurrently, 120 per 10 seconds, and a
60-second timeout. Graph result JSON is limited to 2 MiB before wrapping in
MCP content. Access tokens are never returned by graph tools. No LAN binding,
CORS wildcard, OAuth discovery, or cloud tunnel is provided.

Anyone holding the token can invoke both read and write tools. There is no
per-tool permission scope in the server; configure client-side approvals and
connect only trusted clients. GraphFrontier does not call a model provider, but
an AI client can forward tool results to its provider. Local transport is not
a guarantee that the client's later processing stays local.

The implementation pins official `@modelcontextprotocol/sdk` 1.32.1 and uses
stateless, per-request transports with JSON responses. It supports the SDK's
2025-era protocol revisions, including 2025-03-26, 2025-06-18 and 2025-11-25.
Clients must negotiate a revision supported by this SDK; support for future
protocol revisions or every client major version is not implied.

Automated tests cover the official SDK client handshake, tool discovery and
calls, security rejection, multiple clients, pagination, stale state, lifecycle
and desktop/mobile bundle loading. These are not a substitute for testing the
installed plugin in Obsidian and connecting each actual client after restart.
Extended tests cover settings/rule/node validation, layout round trips, backup
deduplication, delete/restore, failed-backup protection, stale queued operations,
exact subsets, camera restoration and real HTML files generated in a temporary
directory. Tests use artificial vaults; no personal layouts are modified.

Build and check with `npm run format:check`, `npm run lint`, `npm test`,
`npm run build`, and `npm run check:release`. The Community Plugins acceptance
of optional desktop networking in a mobile-capable plugin remains a separate
review question; this local implementation does not change the manifest.

Group `settings` also accepts `edge_color` (hex color) and `strong_pull` (boolean).
They follow group membership without writing individual node overrides. Changing
Strong pull rules or membership in an active Strong pull group wakes the layout.
