# Restack

A VS Code extension that renders a `gh-stack` stack and lets you drag to reorder
it, showing the exact `git rebase` plan before running anything. Published to
both the VS Code Marketplace and Open VSX.

## Rules

- **Never commit or push on my behalf.** Stage nothing, run no `git commit`, no
  `git push`, no `git tag`. Make the edits and stop; I run the git commands.
  This holds even when I've asked for something whose obvious last step is a
  commit — finish the work, then tell me what to run.
- **Never add yourself as a commit co-author.** No `Co-Authored-By: Claude`
  trailer, no `🤖 Generated with` line. If I ask you to draft a commit message,
  give me the text without those.
- Don't delete or re-cut published releases and tags without me naming the
  specific one. A published Marketplace version can never be unpublished.

The first two are enforced by `.claude/hooks/block-git-writes.sh`, a
`PreToolUse` hook on `Bash` wired up in `.claude/settings.json`. It denies
`commit`, `push`, and tag writes — including behind `sh -c`, `rtk`, `git -C`,
and after `&&`. Reads (`git status`, `git log`, `git tag -l`) pass through.

It splits on quotes to catch `sh -c "…"`, so a git write quoted inside an
otherwise inert command is refused too — grepping for the literal string
`git push` gets denied. Switching quote style doesn't help; use a regex
(`git.push`), a hyphen, or the Grep tool. That's the deliberate direction: a
false refusal costs a rephrase, a false allow costs a push.

## Layout

Two bundles, built by `esbuild.mjs`, no compile step in between:

- **Extension host** (`src/*.ts`) — Node, CJS, `vscode` external. Runs git and
  `gh`, owns all state.
- **Webview** (`src/webview/`) — browser, IIFE, React bundled in. Pure render;
  it has no repository access and reaches the host only by `postMessage`.

`tsc` is `--noEmit` — typecheck only. esbuild strips types without checking
them, so a type error will still build and ship unless `npm run typecheck` runs.
That's why `vscode:prepublish` chains typecheck, test, and build.

Inside `src/`:

- `plan.ts` / `stack.ts` / `parse.ts` / `model.ts` — pure logic and types, no
  I/O. The test harness bundles these into a browser page, so keep them free of
  Node imports.
- `git.ts` — the one logged place a child process spawns. `candidates.ts` keeps
  its own unlogged helper on purpose: it runs a merge-base per branch on every
  refresh, and that volume would bury the commands a user wants to read in the
  output channel.
- `view/provider.ts` + `view/operations/*` — the nine stack operations. They
  reach the provider through the narrow `Host` interface (`view/host.ts`) rather
  than taking six arguments each.
- `webview/components/`, `views/`, `hooks/`, `lib/` — `App.tsx` is only the
  loading and error gates.

`Host`'s `stack`/`plan`/`order` are **getters, not values**. Several operations
deliberately re-read them after `await refresh()`, so passing a snapshot at call
time breaks them subtly.

`webview/styles.css` is nine `@import`s, cut on line boundaries rather than by
concern. `.badge--new`, `.badge--pr-base`, and `.trunk--current` depend on their
position in the cascade — reordering the imports changes rendering.

## Commands

```bash
npm run typecheck     # tsc --noEmit; esbuild does not typecheck
npm test              # node --test, 156 tests, real git in temp repos
npm run build         # or `watch`
npm run package       # -> restack-<version>.vsix (runs prepublish first)
npx vsce ls --tree    # exactly what would ship
```

Tests use Node's built-in runner with `--experimental-strip-types` on `.ts`
directly — no build step, and they need Node 22+. They shell out to **real git**
in temp repos (`test/support/repo.ts` sets its own `user.email`/`user.name`) but
never to `gh`, so they run anywhere git exists.

`test/harness/index.html` renders the webview in a plain browser with no
extension host. `?view=` reaches states a single fixture can't be in at once:
`init`, `outside`, `drift`, `trunk`, `away`, `multi`, `github`, `conflict`.
Rebuild it with `node test/harness/build-driver.mjs` — it bundles the real
`plan.ts`, so the page computes plans with the same code the extension runs.

The `sandbox*/` directories are scratch repos with their own `.git`, gitignored,
for manual testing. Recreate with `test/make-conflict-sandbox.sh` and
`test/make-multi-stack-sandbox.sh`.

## Releasing

The maintainer-facing version of this lives in `docs/RELEASING.md`; keep the two
in step. It is deliberately *not* in `README.md`, which renders as the
Marketplace and Open VSX storefront page.

Two halves, deliberately. Pushing a `v*` tag runs
`.github/workflows/release.yml`, which typechecks, tests, packages, and creates
the GitHub release with the matching `CHANGELOG.md` section as its notes and the
`.vsix` attached. Publishing to the registries is a **separate, hand-started**
workflow: neither the Marketplace nor Open VSX lets you unpublish a version, so
a tag push must never be able to ship one.

```bash
# 1. CHANGELOG.md first — add a `## <version>` section.
npm version patch            # or minor; bumps package.json and tags
git push --follow-tags       # the workflow builds and cuts the release

# 2. Actions -> Publish -> Run workflow -> tag: v<version>
#    Then approve the `publish` environment when it asks.
```

The release workflow rejects a tag whose version disagrees with `package.json`,
and a version with no changelog section — both **before** packaging, so a
forgotten entry costs seconds rather than a full build.

`.github/workflows/publish.yml` is `workflow_dispatch` only, in two jobs with an
approval gate between them. `verify` has no side effects: it confirms the
release exists, downloads the `.vsix` it actually offers, and runs
`scripts/preflight-publish.mjs` — which checks the artifact's internal version
against the tag, looks for stray files, and asks both registries whether the
version is already live. Only then does the gate ask for approval, so what you
approve has already been checked.

The tokens can't be checked there. `VSCE_PAT` and `OVSX_PAT` are **environment
secrets on `publish`**, and GitHub only exposes those to a job declaring
`environment:` — which is the gated job. A pre-gate job sees empty strings, so
`scripts/verify-pats.mjs` runs as the publish job's first step instead, calling
`vsce verify-pat` and `ovsx verify-pat` before either registry is written to.
That's a stronger check than the presence test it replaced: a PAT scoped to one
Azure DevOps organization instead of all of them is non-empty and still can't
publish.

The gate depends on a `publish` **environment with required reviewers**
existing in repo settings. Without it the job runs unattended on the click
alone — the workflow cannot detect this, so don't remove the environment.
`VSCE_PAT` and `OVSX_PAT` are environment secrets on it, scoped to that job.

`dry_run: true` runs `verify` and stops, which is the safe way to exercise any
change to this workflow.

Publishing by hand still works and takes the same path —
`gh release download v<version> && npm run publish -- restack-<version>.vsix`.

`npm run publish` (`scripts/publish.mjs`) sends the same `.vsix` to both
registries with `--packagePath`, which skips `vscode:prepublish` so neither
rebuilds. What ships is what was packaged and tested, and it matches the bytes
on the release page. Marketplace goes first: if it rejects the version, Open VSX
hasn't been written to yet and the whole release can be retried after a bump.

Both registries matter — Cursor and the other forks can't install from the
Marketplace (its terms restrict it to Microsoft products), so they pull from
Open VSX. Shipping to one leaves half the audience on an old version.

Anything written to the repo root before `vsce package` gets bundled. v0.5.1
shipped a stray `extension/release-notes.md` that way; the workflow now writes
notes to `$RUNNER_TEMP`, and `.vscodeignore` excludes the name as a second
layer. Check `npx vsce ls --tree` after changing anything about packaging.

## Constraints

- **`gh-stack` v0.1.0** is the target, and its `.git/gh-stack` schema is pre-1.0
  and will drift. `metadata.ts` and the fixtures encode what that version does.
- Metadata must agree with the refs after any operation, or `gh stack submit`
  retargets pull requests to the wrong base. Tests assert both together.
- Every child process runs with `GIT_EDITOR=true` and `GIT_TERMINAL_PROMPT=0`.
  There's no terminal attached to an extension host, so `git rebase --continue`
  or a credential prompt would block forever on a pipe nobody reads.
- Reordering is refused when the stack has merged branches — `gh-stack` rejects
  it.
- `restack.ghPath` is `scope: machine` on purpose. It's an executable path run
  at startup, so a workspace must not be able to override it.
- The extension declares `untrustedWorkspaces: false` — it runs git and `gh`
  against the open repo on startup.
