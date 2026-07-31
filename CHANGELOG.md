# Changelog

## 0.2.0

### Added

- **Create a stack from the empty state.** A repo with no stack used to show
  `Not on a stack` and a Retry button. It now shows a builder: pick a trunk,
  drag local branches in bottom-first, name a branch that does not exist yet,
  and run the `gh stack init` command previewed above the button. Preview and
  execution share one `initArgs`, so they cannot drift.
- **Rebase stack**, offered when gh-stack reports drift. `gh stack init` adopts
  branches without rebasing them, which used to leave a freshly created stack
  showing ⚠ markers and "Drag a branch to see the plan" — a dead end, because
  the planner only emitted steps when the *order* changed. `computePlan` now
  takes `{ force: true }`, replaying drifted branches and everything above them
  onto their recorded bases, through the usual plan → apply path with its
  snapshot, conflict pause, and undo.
- Standing outside a stack is distinguished from having none. `gh stack view`
  reports the same error either way, so Restack reads `.git/gh-stack` directly:
  when stacks exist, they are listed with **Check out** rather than only an
  offer to create another.
- Init is guarded by a preflight. Notably it refuses on a dirty working tree:
  `gh stack init` writes its metadata *before* checking out the top branch, so a
  checkout blocked by a dirty file leaves a half-created stack.

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
