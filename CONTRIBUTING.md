# Contributing

Report reproducible bugs in [Issues](https://github.com/pikiby/GraphFrontier/issues)
and discuss feature ideas in [Discussions](https://github.com/pikiby/GraphFrontier/discussions).

Include plugin and Obsidian versions, operating system, reproduction steps,
expected behavior and actual behavior. Use a small synthetic vault when possible.
Do not upload private notes, layouts, MCP tokens or `mcp.json`.

Use Node.js 20 and `npm ci` in a checkout. Before proposing a change, run:

```bash
npm run format:check
npm run lint
npm test
npm run build
npm run check:release
```

Test in a separate vault. Preserve compatibility with existing layouts, pin
constraints and the separation between layout state and global sidebar state.
Keep mobile code paths free of eager Node.js/Electron imports. Behavior changes
should include regression tests and matching documentation.

Describe what changed, why, and which checks you actually ran in your pull request.
Distinguish automated tests from manual Obsidian/device tests. Do not include
`dist/`, local vault data or credentials in the pull request.
