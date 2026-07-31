# Changelog

## 0.3.1

### Fixed

- **A force-push could silently destroy a colleague's commits.** Nothing checked
  whether a stack branch was behind its own upstream. Reorder locally, then
  `gh stack push`, and `--force-with-lease` compares against the
  *remote-tracking* ref — which is the stale one. The lease passes, and commits
  someone else pushed to your branch are overwritten with no error and nothing
  to warn you.

  `preflight` now refuses the apply outright, naming the branches and why. There
  is no safe automatic answer once both sides have moved, so it stops rather
  than guessing. `gone` is deliberately not refused: a branch deleted after its
  PR merged has nothing left to clobber, and refusing there would block every
  stack that had ever landed anything.

### Added

- **Basing a stack on someone else's branch.** `gh stack init --base` has always
  taken any branch, but the Trunk dropdown only listed *local* ones — so a
  colleague's branch existing solely as `origin/their-work` could not be picked,
  and the case the flag exists for was unreachable. The dropdown now has a
  second group of remote-tracking branches, and picking one creates the local
  branch first, because gh-stack records a trunk by *name* and needs it to
  resolve.

  Creating it is only correct the first time. On the second init the branch
  already exists locally, at whatever commit it was created at, while its owner
  has pushed since — so Restack fetches, then fast-forwards it, and says by how
  many commits. A local copy carrying commits of its own is neither adopted nor
  rewritten: someone else's branch is not ours to rebase, so the drift is named
  and the init stops.

- **Change base…** on the trunk row, the other half of that story: once their
  branch merges into `main`, the stack should sit on `main`, and before this
  there was no way there short of unstacking and starting over. It replays the
  bottom branch onto the new base and cascades everything above — an ordinary
  apply, with the plan shown first, conflicts pausing, and undo available. The
  metadata write records the new trunk, which is what makes the next
  `gh stack submit` retarget the bottom PR; the confirmation says so, because
  that is the part that reaches GitHub.

  No new rebase arithmetic. It is `{...stack, trunk: newBase}` handed to the
  same `computePlan`, and the bottom branch's *recorded* base still anchors its
  replay — so it takes its own commits and not the new base's.

- **Remote state, and one button that fetches.** Restack knew nothing about the
  remote: no counts, no staleness, no way to tell that the branch under your
  stack had moved. Rows now carry `↑2` / `↓3` / `unpushed` / `gone` pills, and
  the trunk row carries the same, so "3 behind `origin/main`" is visible without
  opening a plan.

  Every one of those counts is read from local refs — one `git for-each-ref` —
  which is what makes it safe on the `.git/HEAD` watcher path, and also the
  catch: they are only as fresh as the last fetch. **Fetch** is the only control
  that reaches the network, and its tooltip says how long ago that was. Nothing
  polls in the background.

- **Sync stack**, offered when the trunk has moved under you. Fetches first —
  always, since a plan built from stale refs would fast-forward to a commit that
  is no longer the tip — then fast-forwards the trunk and replays the stack on
  top. The fast-forward has two forms because git does: `git fetch <remote>
  <trunk>:<trunk>` when the trunk is not checked out, `git merge --ff-only`
  when it is. Both refuse anything that is not a fast-forward, so the safety is
  git's rather than ours. Trunk here means whatever the stack sits on, so this
  works the same on a colleague's branch as on `main`.

### Changed

- Picking a *local* branch as a new base does not fetch, so it may be well
  behind its own upstream while the stack is about to land on it. The
  confirmation now says so. A note and not a refusal — basing on an older commit
  deliberately is legitimate, and Sync stack is the fix if it was not.
- `runCommand` and friends moved from `apply.ts` into a new `git.ts`. `apply.ts`
  needs `remote.ts`'s tracking reads for the clobber guard above, and the two
  importing each other would be a cycle. The alternative was a second exec path,
  which would be a second thing to keep logging and would drift.

## 0.3.0

### Added

- **A "you are here" indicator.** The stack view rendered every branch
  identically, so the one you were actually standing on was indistinguishable
  from the rest — on a three-branch stack you had to run `git branch` to find
  out. The data was always there (`gh stack view --json` reports
  `currentBranch` and per-branch `isCurrent`); it was just spent on a bold name
  and a faint ring. Now the current row carries a **HEAD** pill and a filled
  node, and a line above the columns reads `You are on feat/api — 2nd of 3 in
  the stack.`

  Standing on the trunk is a position too, not the no-stack case: `gh stack
  view --json` still returns the whole stack with `currentBranch: "main"`, so
  the trunk row gets the same treatment and the line reads `the trunk this
  stack sits on`. Standing on a branch gh-stack does not list is the one case
  rendered as a warning, since it means nothing you drag will affect where you
  are.

- **Add a branch to a stack that already exists.** The typed-in branch name was
  only ever offered by the builder, so it disappeared the moment there was a
  stack to add to — from then on, extending one meant a terminal. Dragging was
  not the answer either: a branch created a moment ago is fully merged into
  trunk, so `readCandidates` filters it out of the tray and it never appears to
  drag.

  **Add on top** under the tray runs `gh stack add <name>` — created if the
  name is new, adopted if it is not, with the resulting command previewed
  beside the field the way init's is. Top-only, because gh-stack refuses
  anywhere else (`can only add branches to the top of the stack`, exit 5), so
  the host checks the top branch out first instead of relaying that error.

  Not an apply: no commit is rewritten, so there is no plan and nothing to
  snapshot. An adopted branch lands flagged `needsRebase`, exactly as init
  leaves one, and the drift banner — reworded, since it named only `gh stack
  init` — offers the replay. Its own preflight refuses a dirty tree, which
  `gh stack add` does not: the guard is for the checkout in front of it.

- **Checkout without leaving the panel**, by three routes to the same guarded
  handler. A `⇣` button appears on each row and on the trunk row when the
  pointer is over it (and on keyboard focus, so it is not pointer-only); a
  status bar item shows `$(git-branch) feat/api 2/3` and opens a picker;
  `Restack: Check Out Branch in Stack` lists the stack top-down with trunk last
  and the current branch ticked.

  Checkout already existed — but only as a double-click on a row in the
  *Proposed* column, advertised nowhere but a tooltip. It also now refuses
  while a rebase is in progress, alongside the existing dirty-tree and
  apply-in-flight refusals: checking out mid-rebase abandons it.

### Changed

- **Rebase conflicts are resolved inside the extension.** A conflict used to
  hand you a static list of paths that opened as plain text, conflict markers
  and all. You resolved them in the SCM view, came back, and guessed whether
  *Continue* would take — the panel never noticed you had staged anything, and
  pressing it too early just reprinted "Still unresolved: …".

  Each conflicted file now has a **Resolve** button that opens VS Code's own
  three-way merge editor (`git.openMergeEditor`, which handles the rebase case
  by diffing `REBASE_HEAD` against `HEAD`). Its *Complete Merge* stages the
  file, which is exactly what *Continue* requires.

  The panel tracks that live. While paused, Restack watches `.git/index` and
  re-reads the unmerged paths on every write, so files flip to `✓ staged` as
  you go and *Continue* is disabled until none are left. The trigger is the
  index, not the merge editor, so `git add` in a terminal or the ➕ in the SCM
  view update the panel identically. Resolved files stay listed rather than
  vanishing — a list that shrank would erase the record of what you had already
  done.

  `ApplyProgress` gained `unresolvedFiles` alongside the now-frozen
  `conflictFiles`, and it persists like the rest of the session: a window
  reload mid-conflict comes back with the right counts. The button state is a
  hint only — `resume()` still re-reads the index as the authority.

## 0.2.1

### Added

- **Remove stack**, the counterpart 0.2.0's init never had. Once a stack existed
  there was no way out of it from the extension — no button, no command, only
  `gh stack unstack` in a terminal or hand-editing `.git/gh-stack`. Sharpest
  right after an init that adopted the wrong branches or the wrong trunk. The
  toolbar button now runs that command on the stack you are in, and the palette
  has `Restack: Remove Stack`.

  Not an apply: unstacking rewrites no commits and moves no branch refs, so there
  is no plan to show, no conflict to pause on, and nothing a snapshot could
  restore. The confirmation splits by reach the way apply does — **Remove
  Locally** stops at `.git/gh-stack`, **Remove & Unstack PRs** also detaches the
  pull requests on GitHub and is only offered when there are PRs and an origin.

  Guarded by its own preflight: no metadata file, a dirty tree (gh-stack's
  unstack path can check out a branch), or a rebase in progress all refuse. The
  rebase check runs *before* the dirty-tree check, since a conflicted rebase
  leaves unmerged files and would otherwise be reported as the symptom rather
  than the cause. And because GitHub leaves queued and auto-merge PRs stacked —
  keeping local tracking too, while still exiting zero — the stack is re-read
  afterwards instead of the exit code being trusted.

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
