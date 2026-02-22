# Manual Build and Release Guide

This is the full manual flow for GraphFrontier.

## 1) Local setup

1. Open terminal in project root:
   - `cd /home/boris/Documents/GraphFrontier`
2. Install dependencies:
   - `npm install`

## 2) Build

1. Run:
   - `npm run build`
2. Build output appears in `dist/`:
   - `dist/main.js`
   - `dist/manifest.json`
   - `dist/styles.css`
   - `dist/versions.json`

## 3) Checks before release

Run all checks:

1. `npm run format:check`
2. `npm run lint`
3. `npm run build`

## 4) Version update (source of truth)

Versioned plugin files are stored in `src/static/`.

Before release, update:

1. `src/static/manifest.json` -> `"version": "X.Y.Z"`
2. `src/static/versions.json` -> add `"X.Y.Z": "<minAppVersion>"`
3. `package.json` -> `"version": "X.Y.Z"`

Rule:

- git tag must be `vX.Y.Z` and must match `src/static/manifest.json.version`.

## 5) Publish release by tag

1. Commit:
   - `git add .`
   - `git commit -m "chore(release): vX.Y.Z"`
2. Push branch and tag:
   - `git push`
   - `git tag vX.Y.Z`
   - `git push origin vX.Y.Z`

## 6) What GitHub does automatically

`release.yml` starts on tag `v*`:

1. Checks tag version matches `src/static/manifest.json.version`.
2. Runs `npm ci`.
3. Runs `npm run build`.
4. Creates `graphfrontier-<version>.zip` from `dist/`.
5. Uploads release assets to GitHub Release.

## 7) Manual smoke test after release

1. Download release assets.
2. Copy files into vault plugin folder:
   - `.obsidian/plugins/graphfrontier/`
3. Enable plugin in Obsidian and verify open/load works.
