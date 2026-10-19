# Development

## Project Structure

- `src/main.js`: plugin core, persistence, graph data collection, commands registration
- `src/view.js`: view lifecycle, UI, interactions, context actions, runtime orchestration
- `src/physics.js`: simulation and orbit-related calculations
- `src/render.js`: render pass, visual helpers, focus/label/color behavior
- `src/constants.js`: defaults, limits, command metadata, shared constants
- `src/api.js`, `src/api-actions.js`, `src/api-layouts.js`, `src/api-tools.js`: graph API, actions, layout recovery and validated schemas
- `src/mcp-server.js`, `src/mcp-settings.js`: optional authenticated MCP transport and connection settings
- `src/static/`: plugin release assets source (`manifest.json`, `styles.css`, `versions.json`)
- `dist/`: built plugin files ready to install into a vault plugin folder
- `dist/release/`: packaged release zip files

## No-Dynamic-Code Build

Production and bundle tests share `createPluginBuildOptions({ production })` from
`scripts/plugin-build-options.cjs`. Use async esbuild APIs: the dependency adapters
are build plugins, so `buildSync()` is not supported.

`src/schema-runtime.js` enables Zod's `jitless` mode before application schemas or
the MCP SDK are loaded. Tool inputs still use real Zod validation. The server
explicitly selects the SDK's CfWorker JSON Schema provider; a narrow build adapter
also replaces the SDK's unconditional default AJV-provider import with that real
validator, excluding AJV's compiler from the plugin bundle.

For reviewed Zod 4.6.7 sources, guarded build transforms remove the dynamic-code
probe and the generators in `core/doc` and `core/compile`, in both CommonJS and
ESM forms. The ordinary interpreted parser remains intact. `z.compile(schema)`
falls back to that parser; strict compilation throws a typed unsupported error.
This is not a validation stub or a global `Function` override.

The helper pins Zod 4.6.7 and MCP SDK 1.32.1 and checks SHA-256 hashes of every
adapted upstream file. A changed version or source stops the build. When upgrading
these dependencies, review the affected sources and transformations before updating
the pins/hashes, then run the no-codegen and bundle tests. Those tests check the
bundle for code-generation references and exercise validation with string code
generation disabled; do not bypass the guards to make an upgrade build.
