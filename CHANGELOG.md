# Changelog

## 0.8.0

### Added

- **A dirty working tree is now an offer rather than only a refusal.** Every
  operation that moves HEAD needs a clean tree, and Restack's answer was a
  message ending "commit or stash them first" — the two commands spelled out
  for you to go and run somewhere else, then come back and start again. The
  second of those is now a button.

  Check out a branch, add or remove one, initialize a stack, apply a reorder,
  rebase, sync, or change the base with uncommitted changes, and Restack names
  the files and offers **Stash and continue**. It runs `git stash push` before
  the operation and `git stash pop` after it. Decline, and you get exactly the
  refusal you got before — nothing changes unless you say yes.

  Two details are deliberate. **Untracked files are left alone** (no `-u`),
  which matches every dirty check in Restack, all of which pass
  `--untracked-files=no` — so a stash never carries off a file the refusal was
  not about. And **the stash is identified by commit SHA, never `stash@{0}`**:
  the stash is a stack and you have a terminal, so pushing another one while a
  reorder runs must not make Restack pop the wrong entry.

  For an apply the stash is held for the whole session rather than popped the
  moment the rebases land. A finished local apply still offers **Roll back**,
  which reaches its snapshot through `git checkout --force` — restoring your
  changes in front of that would put them exactly where that command destroys
  them. So the stash comes back on whichever of publish, roll back, or dismiss
  happens first, the panel says so while it waits, and it survives a window
  reload along with the rest of the session. Dismissing an apply paused on a
  conflict is the one case where nothing is popped, because the tree cannot
  take it; you are told the `stash@{N}` to pop yourself. Same for a pop that
  conflicts — nothing is dropped until you drop it.

- **Optional background fetch, off by default.** Everything Restack shows about
  the remote — the ahead/behind pills, the sync banner, the clobber warning —
  is read from local refs, so it is only ever as fresh as your last fetch. The
  Fetch button makes it fresh, but only if you remember to press it, and a
  stale banner is worse than no banner.

  `restack.autoFetch` is a number of seconds; `0` is the default and means off,
  so Restack still makes no network call you did not ask for. Values below 60
  are treated as 60, because the setting is a free-form number box and a
  mistyped `5` should not put a network call in front of you twelve times a
  minute.

  The timer is deliberately quieter than the button. It pauses while the
  Restack view is hidden — an editor left open overnight with the sidebar
  collapsed makes no network calls at all — and while an apply is running. It
  never shows a spinner, because a spinner would claim you asked for this, and
  never shows an error popup, because a laptop off the network would raise one
  every interval until it reconnected. Failures go to the **Restack** output
  channel instead.

  **Restack: Background Fetch…** in the view's ⋯ menu turns it on and off with
  presets, which is how you find a setting that defaults to off.

- **Multi-root workspaces read the right folder.** Restack read
  `workspaceFolders[0]` — whichever folder happened to be added first, which is
  routinely the docs or the config and not the repository with the stack in it.

  It now resolves in the cheapest order that can be right: one folder answers
  itself, then a choice you have already made in this workspace, then a check of
  each folder for a `.git/gh-stack` — a local file read, no `gh` and no network
  — which picks the folder automatically when exactly one has stacks. Only a
  genuine ambiguity, several folders with stacks or none at all, puts a list on
  screen and asks. Your answer is remembered.

  A single-root window is unchanged and pays nothing: no probe, no stored value,
  no question. **Restack: Select Folder…** shows the list again with the current
  folder marked, and appears in the view's ⋯ menu when there is more than one
  folder. Switching is refused while an apply is in flight — the session holds a
  working directory, a branch snapshot, and possibly a stash, all belonging to
  one repository — and switching clears everything cached about the folder being
  left, so no PR badge or commit count crosses over.

### Changed

- **Typecheck and tests now run on every push to `main` and every pull
  request.** Nothing ran between releases: the checks lived in the tag-triggered
  release workflow, so a type error or a broken test was found at the moment it
  was least welcome. The new workflow builds and ships nothing — packaging still
  belongs to the release — and pins the same Node 22 the release job uses, so CI
  cannot pass on a version that would fail there.

## 0.7.0

### Added

- **Branches in the Current column now open, and show what is inside them.**
  Reordering a stack is a decision about content — whether this branch's changes
  really do sit under that one — and until now the panel showed only names.
  Answering "what is actually in `feat/api`?" meant leaving the view for a
  terminal or the Source Control panel, and coming back to a decision you had
  lost the context for.

  Every branch row now carries a commit count and a twisty. Opening one shows:

  - **The working tree**, on the branch you are standing on and only there —
    staged, unstaged, and untracked, in the three groups git reports them in. It
    is live: saving a file or staging a hunk updates it without a refresh.
    Untracked files are listed but not clickable; there is no committed side to
    put beside them.
  - **The branch's own files** — everything that differs between its base and
    its tip, so a rename is one entry showing both paths rather than a delete
    and an add.
  - **Its commits**, newest first, each of which opens in turn to the files that
    one commit touched.

  Clicking any file opens a real VS Code diff. The left-hand side comes from a
  read-only `restack:` document backed by the git object, so nothing on disk is
  touched and the editor cannot write back to a commit — and a file git calls
  binary opens as a single pane instead of a diff of bytes. A file listed under
  the branch is diffed across the whole base-to-tip range; a file listed under a
  commit is diffed against that commit's parent, so both answer the question
  they were clicked under.

  Counts and trees hang off *Current* only. The Proposed column stays a plain
  list of names, because it describes an order that does not exist yet.

## 0.6.1

### Fixed

- **Push & submit now joins the pull requests into a stack on GitHub.** Apply
  & Publish and the standalone Push & submit button already ran `gh stack push`
  and `gh stack submit --auto`, which opens or updates a PR per branch and
  retargets each base. Submit also *tries* to create the GitHub stack object
  that groups those PRs — but gh-stack v0.1.0 reports a failure there as a
  warning and still exits 0. Restack treated that as success, so the panel
  said the stack was published while GitHub showed a row of unrelated PRs.

  The remote half now ends with `gh stack link --base <trunk> …`, which is the
  dedicated, idempotent path for that grouping. It is skipped below two
  linkable PRs (a stack needs two), and merged branches are left out because
  their PRs are closed. If link still cannot create the stack, Restack now
  fails the step instead of ignoring the warning, and says the PRs are on
  GitHub but not joined — retrying Push & submit is safe.

## 0.6.0

### Added

- **Restack says when gh-stack is missing, and offers to install it.** Restack
  is a UI over the `gh stack` CLI, so without that extension it can do nothing —
  and what it did instead was close to nothing visible. `gh stack view` failing
  with `unknown command` and `gh` not being on the PATH at all collapsed onto
  one screen titled *gh CLI unavailable*, which is the wrong sentence for the
  first case: `gh` is right there, working. The screen had a Retry button and no
  other way forward, and nothing surfaced outside the view — the status bar hides
  when there is no stack, so a user who never opened the sidebar saw an
  extension that silently did nothing.

  They are now two screens with two different answers, because only one of them
  has a fix Restack can run:

  - **gh-stack is not installed** shows `gh extension install github/gh-stack`
    and an **Install gh-stack** button that runs it, with Copy and Retry beside
    it. The command goes through the same child-process path as every other
    command, so its argv, exit code, and both streams land in the Restack output
    channel, and it runs under a progress notification. On failure gh's own
    first line is the error, with the log opened; the command stays on screen to
    run by hand. On success the view re-reads the stack.
  - **gh CLI not found** offers a link to cli.github.com and a shortcut to the
    `restack.ghPath` setting — for a `gh` that is installed somewhere Restack
    did not look — but deliberately no install button. Installing the CLI would
    need the CLI.

  A one-time warning notification covers the user who never opens the view,
  carrying the same Install action plus Show Restack. It fires once per machine
  and only inside a git repository, so opening an unrelated folder does not
  mention stacking at all, and the flag clears on the first stack that reads
  successfully — so removing gh-stack later is mentioned again rather than
  passed over in silence.

  **Restack: Install gh-stack** is also in the command palette.

### Changed

- **Releasing is now two workflows with an approval gate between them.**
  Pushing a `v*` tag typechecks, tests, packages, and cuts the GitHub release
  with the matching changelog section as its notes. Publishing to the
  Marketplace and Open VSX is a separate, hand-started workflow: neither
  registry lets a version be unpublished, so a tag push must never be able to
  ship one. Its first job has no side effects — it downloads the `.vsix` the
  release actually offers, checks the version inside the artifact against the
  tag, looks for stray files, and asks both registries whether the version is
  already live — and only then does the gate ask for approval. The tokens are
  verified with `vsce verify-pat` and `ovsx verify-pat` as the publish job's
  first step, which catches a PAT scoped to the wrong Azure DevOps organization
  rather than only an empty one.

- **The release procedure moved out of `README.md`** into `docs/RELEASING.md`.
  The README renders as the Marketplace and Open VSX storefront page, where
  maintainer instructions are noise.

### Fixed

- **v0.5.1 shipped a stray `extension/release-notes.md`.** The release workflow
  wrote its notes to the repository root before `vsce package` ran, so the file
  was bundled into the `.vsix`. Notes now go to `$RUNNER_TEMP`, and
  `.vscodeignore` excludes the name as a second layer.

## 0.5.1

### Changed

- **Four oversized files split into modules.** No behaviour change — every
  function kept its name, its signature, and the comment explaining it. This is
  purely about being able to find things: `App.tsx` was 2034 lines and eighteen
  components, so reaching `ApplyPanel` meant scrolling past nine others, and
  `extension.ts` was 1897 lines of which ~1500 were one class, so adding a stack
  operation meant landing in the middle of it.

  - `src/webview/App.tsx` → **62 lines**, now only the loading and error gates.
    The eighteen components moved to `components/`, the two full-screen views to
    `views/`, the `useState` block and its message listener to
    `hooks/useHostState.ts`, and the pure helpers to `lib/`.
  - `src/extension.ts` → **36 lines**, now `activate`/`deactivate` and the
    command registrations. `StackViewProvider` moved to `src/view/provider.ts`
    and the nine stack operations to `src/view/operations/`, alongside the
    confirmation modals, the QuickPick builders, and the git helpers.
  - `src/webview/styles.css` → an index of nine `@import`s. Cut on line
    boundaries rather than by concern: the source interleaves them, and
    `.badge--new`, `.badge--pr-base`, and `.trunk--current` all depend on where
    they sit in the cascade rather than on what they are named. esbuild inlines
    the imports, so the emitted `dist/webview.css` is byte-identical.
  - `test/apply.test.ts` → four suites (apply, session, preflight, sync-base)
    over a shared `test/support/repo.ts`. Every test name is verbatim, so a
    failure report still points at the same thing. 154 tests before and after.

  The operations reach back into the provider through one narrow `Host`
  interface rather than six arguments each, and the `lastX` fields stay private
  behind getters — several operations deliberately re-read them after an
  `await refresh()`, so they have to be live reads and not values captured at
  call time. The "an apply is in progress" warning, previously copy-pasted eight
  times, collapsed to one `blockedByApply` helper; both of its wordings survive,
  since the one shown next to the plan panel points at buttons the other cannot
  assume are on screen.

  The bare `execFile` git helper moved as-is and was deliberately *not* switched
  to `git.ts`'s logged `run()` — that would put every checkout in the output
  channel and change the child environment, which is a behaviour change and not
  this one.

### Fixed

- **Rolling back reported a failure for a rollback that worked.** The plan panel
  renders Roll back from `phase: 'failed'` plus `canUndo`, and the rollback
  emitted exactly that pair on its way out — so the button came back for a
  session it had just cleared, and pressing it a second time answered
  `Restack: No apply in progress.` Nothing had gone wrong; the panel was
  offering to undo an undo, and the honest answer to that read as an error. The
  final state now says `canUndo: false`, so a finished rollback offers Show log
  and Dismiss and nothing else.

- **The rows kept showing the order the apply produced, after undoing it.**
  Rolling back puts the branches and `.git/gh-stack` back exactly as they were
  — that part was always covered by tests — but nothing re-read them
  afterwards. Every other operation that moves refs refreshes; abort was the one
  that did not, so the repository was restored while the panel still rendered
  the change that had just been taken back, with no way to tell the undo had
  landed short of reloading the window. Abort now refreshes like the rest.

  The restore itself is covered by tests; whether the view then re-reads it is
  the provider's, which has no automated coverage — so that half was verified by
  hand against `sandbox/`.

## 0.5.0

### Added

- **Stacks read from GitHub, not just from this clone.** Everything Restack knew
  about stacks came from two local sources: `gh stack view`, which reports the
  stack HEAD is standing in, and `.git/gh-stack`, which records the stacks *this
  machine* has checked out. A stack that existed only on the server was
  invisible to both — a colleague's, your own from another laptop, or a pull
  request someone appended to your stack on GitHub while you were working.

  GitHub's GraphQL API now models stacks natively (`PullRequest.stack`, with its
  number, size, base, and ordered entries), so Restack asks for them in the call
  that already fetched PR badges. That call was already authenticated and
  already went out; it moved from `gh pr list --json` to `gh api graphql`, so
  this costs one request rather than two, and needs no scope `gh` does not
  already have. Three things come out of it:

  - A **`⧉1204` badge** on a switcher row whose PRs all report the same GitHub
    stack — the number everyone else sees, unlike the switcher's own index,
    which is this clone's position in `.git/gh-stack` and means nothing to
    anyone else. When the branches report *two* stacks the badge is omitted
    rather than guessed at; that is the same ambiguity gh-stack refuses locally
    with `branch %q belongs to multiple stacks`.
  - A **`+1 on GitHub` warning** when a matched stack holds an open PR this
    clone has no branch for, naming the branches and pointing at `gh stack
    sync`. The reverse — a local branch not yet submitted — is ordinary and is
    mentioned in the tooltip rather than coloured. Merged and closed entries
    count as neither: the normal end of a stack's life is not drift, the same
    reason a `gone` upstream is excluded everywhere else.
  - An **"On GitHub only" list** of stacks sharing no branch with anything here,
    each with a Check out button running `gh stack checkout <pr>`. Fully merged
    stacks are dropped, and the button targets the bottom-most *open* PR, since
    a merged one may have had its branch deleted. It renders nothing when the
    list is empty, so the common repository pays no chrome for it.

- **A `PR base` badge when a pull request targets the wrong branch.** gh-stack
  records each branch's base as a **SHA** and never reads the PR's own
  `baseRefName`, so a base retargeted on the server — by a colleague, by a merge
  queue, or by GitHub itself when a parent PR closes — left the local view
  complete and wrong. The Current column now says so, on the row whose PR would
  otherwise merge somewhere other than the branch beneath it.

- **`restack.readRemoteStacks`** (default on) turns the whole path off. Restack
  then falls back to the `gh pr list` call it always made, so the PR badges stay
  and only the surfaces above disappear. The same fallback happens automatically
  on a GitHub Enterprise Server old enough to have no `stack` field: the API
  answers `undefinedField`, which Restack reads as "ask the old way" rather than
  as an error.

  Freshness follows the existing rule rather than adding a new one. The read
  happens once when the view first loads, then on Fetch and on a stack switch,
  and is cached in between — so the `.git/HEAD` watcher, which fires once per
  rebase step during an apply, stays network-free. The first read is deferred
  and not awaited: it lands after first paint rather than delaying it. Nothing
  polls on a timer.

### Fixed

- **Switcher badges could break mid-word.** `.stacks__path` sets
  `word-break: break-all` so a long branch name wraps instead of overflowing the
  row, but that applied to the badges too — a PR badge could split after the
  `#`, leaving `#` and `27` on separate lines. Branch names still break
  anywhere; the badges no longer do.

## 0.4.0

### Added

- **Several stacks in one repository.** gh-stack has always allowed this —
  `.git/gh-stack` is an array of stacks, and `gh stack checkout` takes a stack
  number — but Restack could only ever see one. `gh stack view` reports the
  stack HEAD is in and nothing else, so from inside a stack every other stack in
  the repository was invisible: not listed, not reachable, and creating a second
  one meant knowing to check out the trunk from a terminal first.

  There is now a switcher above the toolbar listing every stack, with a PR badge
  per branch and `↓N` where the remote has commits that would block a rewrite.
  It stays collapsed to one line and disappears entirely below two stacks, so a
  one-stack repository is unchanged.

  Switching is a **checkout**, not a display mode: Restack checks out that
  stack's top branch and `gh stack view` reports it in full. The top rather than
  the trunk, because a stack's trunk is routinely another stack's branch, and
  standing on a shared branch is the ambiguity gh-stack refuses. This keeps one
  render path — everything below the switcher works identically whichever stack
  you are in, rather than a second, degraded view for stacks you are not
  standing in.

  **+ New stack** in the toolbar creates another. `gh stack init` refuses while
  HEAD is part of a stack, so it confirms and then checks out the trunk; the
  existing stack is untouched. `Restack: Switch Stack` and `Restack: New Stack`
  do the same from the command palette, and the status bar gains `· stack 2 of
  3` where it applies.

### Fixed

- **A branch could be dragged into two stacks at once.** The Available tray
  excluded the branches of the stack on screen, but not those of any *other*
  stack in the repository — so in a two-stack repo, the second stack's branches
  were offered as insertable, and dropping one in recorded it as a member of
  both. That is precisely what gh-stack refuses with `branch %q belongs to
  multiple stacks`, and it left `.git/gh-stack` in a state gh-stack itself would
  reject. The tray now excludes every branch claimed by any stack. The
  empty-state builder already did this correctly; only the in-stack view was
  affected.

- **Standing on a shared trunk showed a failure screen.** With two stacks based
  on `main`, `gh stack view` on `main` exits 6 with `branch "main" belongs to
  multiple stacks` — there is no single stack to report. Restack classified that
  as a hard error, so the most ordinary resting position in a multi-stack
  repository rendered "Could not read stack" in red. It is now the same
  no-stack screen as any unstacked branch, which is where the switcher lists
  the stacks to choose from.

## 0.3.2

### Security

- **A cloned repository could run code on startup.** `restack.ghPath` had no
  declared `scope`, so it defaulted to `window` — which meant a workspace's own
  `.vscode/settings.json` could set it. Restack activates on
  `onStartupFinished` and immediately runs `gh stack view --json` to read the
  stack, with the workspace as the working directory, so a *relative* path
  resolved inside the repository. Cloning a repo that shipped
  `{"restack.ghPath": "./payload.sh"}` and opening it was enough: no stack
  needed to exist, and no button had to be pressed.

  The setting is now `scope: "machine"`, so it lives in user settings and a
  workspace cannot override it — the same treatment VS Code gives `git.path`,
  for the same reason. If you set `ghPath` because `gh` is not on your `PATH`,
  it has to be in your user settings now; a workspace-level value is warned
  about once and then ignored.

  Reachable only in a trusted workspace, since an extension that declares no
  `capabilities` is disabled in Restricted Mode — but that was true by accident
  rather than by intent, so `untrustedWorkspaces.supported: false` is now
  declared outright. Restack runs git and `gh` against whatever repository is
  open, and that is not something to do on trust nobody granted.

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
