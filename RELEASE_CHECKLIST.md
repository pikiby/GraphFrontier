# GraphFrontier Release Checklist

## 1) Repository files

- [ ] `manifest.json` exists in repo root
- [ ] `main.js` exists in repo root
- [ ] `styles.css` exists in repo root (if used)
- [ ] `versions.json` exists in repo root
- [ ] `README.md` describes plugin and install flow
- [ ] `LICENSE` added

## 2) Manifest sanity

- [ ] `id` is unique and stable (`graphfrontier`)
- [ ] `name` is final (`GraphFrontier`)
- [ ] `version` follows `x.y.z`
- [ ] `minAppVersion` is correct
- [ ] `author` is final (not placeholder)
- [ ] `description` is clear
- [ ] `main` points to `main.js`

## 3) Versions mapping

- [ ] `versions.json` contains current version mapping
- [ ] Example: `"0.1.0": "1.4.0"`

## 4) Build and release assets

- [ ] Release tag equals `manifest.json.version` exactly
- [ ] Attach these files to GitHub Release:
  - [ ] `main.js`
  - [ ] `manifest.json`
  - [ ] `styles.css` (if used)

## 5) Community Plugins submission

- [ ] Public repo is available: `https://github.com/pikiby/GraphFrontier`
- [ ] Open PR to `obsidianmd/obsidian-releases`
- [ ] Add plugin entry into `community-plugins.json`:
  - `id`: `graphfrontier`
  - `name`: `GraphFrontier`
  - `author`: your public author name
  - `description`: short plugin description
  - `repo`: `pikiby/GraphFrontier`

## 6) After merge

- [ ] Wait for index refresh in Obsidian ecosystem
- [ ] Verify plugin can be installed from Community Plugins search
- [ ] For each new release: update `manifest.json.version`, `versions.json`, publish new GitHub Release

## 7) Recommended quick checks before every release

- [ ] Plugin loads with no console errors
- [ ] Settings panel opens correctly
- [ ] Main commands work from Command Palette
- [ ] No local-only files are included (for example `data.json`)

