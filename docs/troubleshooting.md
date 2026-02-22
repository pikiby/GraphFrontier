# Troubleshooting

## Plugin Loads But Changes Are Not Visible

Most common cause: Obsidian is still using an older `main.js` in the vault plugin folder.

Check:

1. Build current source:
   - `npm run build`
2. Copy files into vault plugin folder:
   - `main.js`
   - `manifest.json`
   - `styles.css`
3. Reload plugin (disable/enable) or restart Obsidian.

## "Failed to load plugin"

Possible causes:

- syntax/runtime error in built `main.js`
- missing required file in plugin folder
- broken `manifest.json`

Quick checks:

1. Run `npm run build` and confirm no errors.
2. Verify plugin folder has `main.js`, `manifest.json`, `styles.css`.
3. Open Obsidian developer console for exact error trace.

## Build Succeeds But `main.js` Size Looks Different

This can be normal when using bundling:

- output includes code from all `src/*.js`
- bundler adds module-runtime wrapper code

Size difference alone is not a bug.

## Graph Looks Chaotic Or Never Settles

Try:

1. Lower `Link strength` and `Center strength`
2. Raise `Damping`
3. Reduce aggressive per-node multipliers
4. Clear search/filter mode if active

If autosave is on and graph never settles, autosave may not trigger.

## Save Layout Is Blocked

If search row is active, save is intentionally blocked.

Fix:

- clear search row and try save again

## Node Commands Do Nothing

Commands with `under cursor` require:

- active GraphFrontier view
- cursor currently over a node

Otherwise command exits with notice.

## Related Docs

- Installation: `installation.md`
- Usage: `usage.md`
- Physics: `physics.md`
