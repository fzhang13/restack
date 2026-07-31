# Changelog

## 0.1.1

### Fixed

- `Alt+↑` / `Alt+↓` did nothing. dnd-kit's drag listeners supply their own
  `onKeyDown`, and the spread that applies them sat after the handler here, so
  it silently replaced it. The handler now runs after the spread and forwards
  keys it does not consume, leaving dnd-kit's space-to-lift path intact.
- The marketplace icon was rendered into the corner of its canvas rather than
  filling it. `qlmanage` rasterizes an SVG as a *document*, letterboxing it;
  `media/build-icon.mjs` now uses headless Chrome at an exact viewport.

### Added

- A screenshot on the listing, plus an explanation of what stacked PRs are and
  an explicit statement that `gh` + gh-stack are required. `npm run media`
  regenerates both images from the real webview bundle.

## 0.1.0

First published release.

### Added

- Insert an unstacked local branch anywhere in the stack, and drag a stacked
  branch out to un-stack it. Branches gh-stack has never seen are anchored to
  `git merge-base <branch> <trunk>`, so they replay exactly like stacked ones.
- **Push & Submit** as a standalone toolbar button and command, independent of
  any apply session — the route to origin after dismissing the panel or
  reloading the window.
- Apply state persisted to `workspaceState`: a window reload mid-apply comes
  back with Continue / Abort / Undo live. A snapshot that no longer resolves is
  reported rather than silently resumed.
- Clickable PR links and conflicted file paths.
- `Alt+↑` / `Alt+↓` to move a focused row; double-click a row to check it out.
- A **Restack** output channel logging every command, exit code, and full
  stderr.

### Changed

- The remote half now runs `gh stack push` instead of a hand-rolled
  `git push --force-with-lease`, which picks up gh-stack's own per-branch lease
  and its merged/queued skip rules.

## 0.0.1

Unreleased. Stack rendering, drag-to-reorder, plan generation, apply with
conflict pause/continue/abort, and snapshot-based undo.
