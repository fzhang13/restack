# Restack

Visualize [GitHub stacked pull requests](https://github.blog/changelog/2026-07-30-stacked-pull-requests-are-now-in-public-preview/)
in VS Code or Cursor, drag branches into a new order, and see exactly which git
commands that reorder would require.

**v0 is preview-only.** Restack reads your stack and computes a plan. It does
not run git. You review the commands and run them yourself.

## Why

`gh stack modify` can reorder a stack, but it is TUI-only — its only flags are
`--abort` and `--continue`, so there is no way to hand it a plan headlessly.
Restack computes the plan itself and shows it to you before anything runs.

## How it works

1. Reads `gh stack view --json` in the workspace folder.
2. Renders the stack top-down (trunk at the bottom), matching `gh stack view`.
3. Dragging reorders a local copy only — nothing touches git.
4. Recomputes the plan on every drop.

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
npm test           # parser + plan unit tests
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

Not built yet (v1):

- Executing the plan
- The conflict pause/continue/abort state machine, persisted to `workspaceState`
  so it survives a window reload
- Dirty-worktree detection and stash offer
- Multi-root workspace support (v0 reads the first workspace folder only)

## Upstream ask

If `gh stack modify` gained a headless `--plan <json>` mode, the entire
execution layer would collapse into one CLI call. The binary already carries an
internal plan model (`BuildPlan`/`ApplyPlan`/`StateFile`). Worth requesting via
`gh stack feedback`.

## License

MIT
