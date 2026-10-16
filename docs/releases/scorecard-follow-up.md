# Scorecard Follow-up (0.8.3)

This work starts from 0.8.2 and is included in 0.8.3. It does not replace the
0.8.2 tag or establish a new directory review result. The last inspected public Scorecard still referenced
0.8.0 and reported 16 CSS warnings, direct filesystem access, missing attestations,
extra release files, vault enumeration, clipboard access and dynamic code.

## Changes

- HTML export uses a single Vault API implementation on desktop and mobile.
  Absolute/URL/parent-traversal paths are rejected. The Export to button saves graphfrontier-static.html in the vault root without
  prompting and reports its location; old remembered paths are ignored. API/MCP
  exports still accept an explicit vault-relative path.
- Export location discovery no longer reads Linux user directories or checks the
  desktop folder. It returns the vault name, null home/desktop and vaultRelative=true.
- External Open path still resolves native paths and calls Electron shell.openPath.
  The preliminary fs.stat is removed; native errors are reported. Obsidian URIs
  and vault note opening remain separate paths.
- Export writes are serialized per vault. The overwrite option is checked inside
  that queue; failed writes do not poison later exports. State is checked again
  after awaited parent creation for API exports.
- The 16 !important declarations are replaced with selectors scoped to the panel.
  No palette or intended control design changes are included.
- The release workflow attests the final main.js and styles.css before upload.
  Signing is only verified after an authorized remote workflow and asset download.

## Security Assessment Boundaries

| Finding                   | Source and interpretation                                                                                                             | Action / limit                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Filesystem access         | Export, export-location discovery, external path preflight                                                                            | Direct fs imports removed from plugin source and bundled code; build tooling still uses Node normally                  |
| Network listener          | src/mcp-server.js creates the optional loopback HTTP server                                                                           | Existing bearer, Host/Origin, body/rate/concurrency limits retained and tested                                         |
| SDK request methods       | MCP shared/protocol.js and server/index.js contain JSON-RPC request methods (ping, roots, sampling, elicitation, tasks)               | Method names do not mean independent outbound HTTP calls; not all bundled methods are exposed by GraphFrontier         |
| Hono fetchCallback        | SDK server/streamableHttp.js uses getRequestListener to adapt incoming HTTP to WebStandardStreamableHTTPServerTransport.handleRequest | A local incoming-request callback, not global fetch; unused serve/WebSocket helpers also appear in the CommonJS bundle |
| 14 network calls          | Aggregate in the old public report; individual scanner locations were not provided                                                    | No exact one-to-one mapping to all 14 findings is claimed; source analysis is not a complete traffic audit             |
| Dynamic code              | Two AJV compilation functions in SDK / ajv-formats dependencies                                                                       | Retained; no disabling schema validation or patching generated code                                                    |
| Clipboard                 | Explicit writeText copy actions in view.js and mcp-settings.js                                                                        | No clipboard read found in inspected source; preserve requested copy functions                                         |
| Vault enumeration         | Graph construction requires note metadata and paths                                                                                   | Retained and disclosed                                                                                                 |
| Extra ZIP / versions.json | Manual installation archive and compatibility information                                                                             | Retained; no removal solely to improve score                                                                           |

Bundle integration tests exercise real authenticated MCP while rejecting calls
from the plugin to Node HTTP request/get. The disabled/mobile loading checks do
not import the server. These tests are scenario-bound, not proof that every
possible renderer or dependency is network-free. Markdown previews can load
resources through Obsidian; user links open externally; connected AI clients may
send received data to their provider. A complete runtime preview/export/MCP
traffic audit remains outstanding. Unavailable malware/network scans are not
successful safety checks.

Vault-relative validation is lexical. Obsidian controls linked-folder resolution;
no physical-path containment guarantee across symlinks is made. The export queue
coordinates this plugin, not other applications or processes. Prefer ordinary
vault folders. Cross-process atomic no-overwrite behavior depends on the adapter.

## Verification and Remaining Gates

Before publication, run format:check, lint, tests, build and check:release, compare
repeat-build hashes and the ZIP contents. Version metadata is synchronized to 0.8.3.

The isolated desktop Obsidian check compared old/new computed control styles for
light/dark themes, normal/hover/active/focus states and desktop/mobile CSS classes:
all 16 combinations matched. This is a desktop CSS check, not physical Android
verification or a guarantee for every third-party theme. Live export in the
isolated vault produced HTML for two nodes and one edge and refused a second
API export without overwrite permission.

Runtime files were subsequently updated and reloaded on physical Android; this
is not exhaustive visual or traffic coverage. Publication is authorized. Live
GitHub attestations must be verified on downloaded assets after the release
workflow; a fresh directory Scorecard is a separate check.
