# Releasing

Maintainer notes. Nothing here is needed to *use* Restack — see the
[README](../README.md) for that.

## Two registries

Cursor cannot install from the VS Code Marketplace: its terms restrict it to
Microsoft products, so Cursor and the other forks pull from
[Open VSX](https://open-vsx.org). Publishing to only one leaves half the
audience on an old version, and the same `.vsix` goes to both.

`vscode:prepublish` runs typecheck, the test suite, and a production build, so
`vsce package` cannot ship a bundle that does not compile or pass tests.

```bash
npm run package                 # -> restack-<version>.vsix, inspect before publishing
npx vsce ls --tree              # exactly what is inside it
```

## One-time setup

- **Marketplace** — create a publisher at
  [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage),
  then an Azure DevOps PAT scoped to *Marketplace → Manage*, all organizations.
  `npx vsce login felixzhang`.
- **Open VSX** — sign in at [open-vsx.org](https://open-vsx.org) with GitHub,
  sign the publisher agreement, and create an access token. Export it as
  `OVSX_PAT`.

The publisher name in both must match `publisher` in `package.json`.

## Cutting a release

Releasing is two halves. Pushing a `v*` tag runs
[`.github/workflows/release.yml`](../.github/workflows/release.yml), which
typechecks, tests, packages, and creates the GitHub release with the matching
`CHANGELOG.md` section as its notes and the `.vsix` attached. Sending that
release to the registries is a second, hand-started workflow — neither registry
lets you unpublish a version, so a tag push must never be able to ship one. A
bad tag can be deleted and re-cut; a bad publish is permanent.

```bash
# 1. CHANGELOG.md first: add a `## <version>` section. The workflow reads it,
#    and fails the release if it is missing.
npm version minor               # or patch; bumps package.json and tags
git push --follow-tags          # -> the workflow builds and cuts the release
```

The workflow refuses to run if the tag and `package.json` disagree, so a
hand-written tag cannot ship a `.vsix` labelled with a different version.

## Shipping it

Then **Actions → Publish → Run workflow**, with the tag. That runs
[`publish.yml`](../.github/workflows/publish.yml) in two jobs with an approval
gate between them. The first has no side effects: it downloads the `.vsix` the
release actually offers and runs
[`scripts/preflight-publish.mjs`](../scripts/preflight-publish.mjs), which
checks the artifact's internal version against the tag, looks for files that
should not ship, and asks both registries whether the version is already live.
The gate comes after, so approval is given against a summary that has already
been verified. Tick `dry_run` to stop there.

The tokens are checked on the *other* side of the gate, by
[`scripts/verify-pats.mjs`](../scripts/verify-pats.mjs) — the first step of the
publish job, before either registry is written to. They have to be: environment
secrets are only visible to a job that declares the environment, and such a job
asks for approval before it can run anything. It asks each registry whether the
token can actually publish, which a presence check cannot — an expired PAT, one
scoped to a single Azure DevOps organization, or one pasted with a stray
newline is a perfectly non-empty string that fails at upload time.

The gate requires a `publish` environment with required reviewers under
**Settings → Environments**, holding `VSCE_PAT` and `OVSX_PAT` as environment
secrets. Repository secrets will not do — the publish job reads them from the
environment. Without that environment the job runs unattended on the click
alone, and the workflow cannot detect this, so keep it in place.

## By hand

Same path, if the workflow is unavailable:

```bash
gh release download v<version>  # the CI-built .vsix
npm run publish -- restack-<version>.vsix
```

Publishing the packaged `.vsix` rather than letting each registry rebuild is
deliberate: both then serve bytes that were tested here, and CI's artifact is
the same file the release page offers. `npm run publish` with no argument
defaults to `restack-<package.json version>.vsix` in the working directory.
Marketplace goes first — if it rejects the version, Open VSX has not been
written to yet and the whole release can be retried after a bump.

## Packaging gotcha

Anything written to the repo root before `vsce package` gets bundled. v0.5.1
shipped a stray `extension/release-notes.md` that way; the release workflow now
writes notes to `$RUNNER_TEMP`, and `.vscodeignore` excludes the name as a
second layer. Check `npx vsce ls --tree` after changing anything about
packaging.
