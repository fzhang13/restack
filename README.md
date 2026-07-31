# Restack

Visualize [GitHub stacked pull requests](https://github.blog/changelog/2026-07-30-stacked-pull-requests-are-now-in-public-preview/)
in VS Code or Cursor, drag branches into a new order, and see exactly which git
commands that reorder would require.

Restack shows you the plan before anything runs, then runs it on your say-so.
Nothing executes until you confirm, and the local half is reversible.

## Why

`gh stack modify` can reorder a stack, but it is TUI-only — its only flags are
`--abort` and `--continue`, so there is no way to hand it a plan headlessly.
Restack computes the plan itself and shows it to you before anything runs.

## How it works

1. Reads `gh stack view --json` in the workspace folder.
2. Renders the stack top-down (trunk at the bottom), matching `gh stack view`.
3. Dragging reorders a local copy only — nothing touches git.
4. Recomputes the plan on every drop.
5. **Apply** runs the plan, pausing on conflicts.

### Applying

Apply is split in two, and the halves are not equally recoverable.

The **local half** is the rebases plus the `.git/gh-stack` write. Before the
first rebase, Restack records every branch SHA and the verbatim bytes of the
metadata file; *Undo* restores both. It refuses to start over a dirty worktree,
mid-rebase, or on a stack with merged branches.

The **remote half** is the force-push and `gh stack submit`. It takes its own
confirmation even if you chose "Apply & Publish" up front, and once it runs,
Undo is withdrawn rather than offered and quietly useless. Without an `origin`
remote that button is not offered at all — preflight refuses the *whole* apply
on an impossible scope, so offering it would cost you the local reorder too.

On a conflict the rebase pauses in place. Resolve the listed files, stage them,
and hit *Continue*; or *Abort* to roll everything back.

### Why Restack writes `.git/gh-stack`

Rebasing moves branch refs but leaves gh-stack's own state file alone. Verified
against v0.1.0: after reordering a stack by hand, `gh stack view` still printed
the **old** order with a drift marker, and the recorded base SHAs were
unchanged. Since `gh stack submit` retargets PR bases from that file, submitting
on top of it would point PRs at the wrong parents.

So Restack rewrites it — the reordered branch list, and each branch's new base
resolved *after* the rebases. Writing another tool's pre-1.0 data is a real
liability, so: the `schemaVersion` is checked and an unfamiliar one aborts,
every unrecognized key is carried through untouched, and the original bytes are
restored on abort. See `src/metadata.ts`.

This is also why the plan shows a `#`-commented metadata step. If you copy the
commands and run them yourself, you inherit the same problem — reorder that file
too, or use `gh stack modify`.

### The recorded-SHA detail

Each generated `git rebase --onto` passes the branch's **recorded base SHA** as
the upstream argument, captured before any rebase runs. gh-stack hands us that
SHA directly — its `base` field is already resolved, not a ref name.

Using a branch *name* as upstream is what breaks. Moving the bottom branch of
`auth → api → ui` to the top with name-based upstreams produces:

```
feat/ui: 070c59b feat: add ui components  144f76f feat: add auth layer  1b42e58 feat: add api routes
```

`feat/ui` has silently absorbed auth's commit. With recorded SHAs the same
reorder yields one commit per branch, correctly. Both outcomes were verified by
executing the commands against a real repository; see `test/plan.test.ts`.

## Requirements

- [`gh`](https://cli.github.com/) with the stack extension:
  `gh extension install github/gh-stack`
- Built against **gh-stack v0.1.0**. That schema is pre-1.0 and will drift —
  the parser is deliberately tolerant, but check here after a gh-stack upgrade.

## Development

```bash
npm install
npm run build      # or: npm run watch
npm test           # parser, plan, metadata + apply against real temp repos
npm run typecheck
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host.

### Sandbox

`sandbox/` (gitignored, has its own `.git`) is a throwaway repo with a
three-branch stack, used to capture real CLI output:

```bash
mkdir sandbox && cd sandbox && git init -b main
# ...commit three stacked branches...
gh stack init feat/auth feat/api feat/ui
gh stack view --json > ../fixtures/stack-no-prs.json
```

`sandbox-conflict/` (also gitignored) is a second throwaway stack whose three
commits all rewrite the same line, so reordering any pair conflicts — that is
the one to use when exercising the pause / continue / abort path. Applying
mutates it, so rebuild it between runs rather than unpicking the last attempt:

```bash
./test/make-conflict-sandbox.sh
```

Both are wired up in `.vscode/launch.json`; pick a config from the Run panel.

### Browser harness

`test/harness/` renders the real webview bundle in Chrome with the VS Code API
stubbed, driven by the same `parseStack`/`computePlan` the extension host uses,
fed by the captured fixture. This is how drag behavior is verified without
launching an Extension Development Host.

```bash
npm run build && node test/harness/build-driver.mjs
open test/harness/index.html
```

## Status

Working:

- Reads and renders the stack, with PR numbers, merged/queued/needs-rebase badges
- Drag to reorder, with moved rows highlighted
- Plan generation, verified against real git
- Distinct UI for: not on a stack, not a git repo, gh missing, parse failure
- Reordering disabled when the stack has merged branches — gh-stack rejects
  inserting next to one
- Executing the plan: rebases, the gh-stack metadata rewrite, force-push, submit
- Conflict pause / continue / abort, with snapshot-based rollback
- Dirty-worktree and mid-rebase refusal before anything runs

Not built yet:

- Apply state is held in the extension host, so it survives hiding the panel and
  is replayed to a webview that reconnects mid-apply — but a *window* reload
  discards it, stranding the repo mid-plan with no Undo. Persisting to
  `workspaceState` is the fix.
- No stash offer on a dirty worktree — Restack refuses and leaves it to you.
- Multi-root workspace support (reads the first workspace folder only).
- Push and submit are verified by unit tests and by hand, not end to end in CI —
  that needs a throwaway GitHub repo.

## Upstream ask

If `gh stack modify` gained a headless `--plan <json>` mode, the entire
execution layer would collapse into one CLI call. The binary already carries an
internal plan model (`BuildPlan`/`ApplyPlan`/`StateFile`). Worth requesting via
`gh stack feedback`.

## License

MIT
