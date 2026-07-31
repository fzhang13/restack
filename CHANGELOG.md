# Changelog

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
