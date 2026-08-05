import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyGraph } from '../src/github.ts';
import { readStack } from '../src/stack.ts';
import {
  computeDivergence,
  matchRemoteStack,
  readPullRequests,
  readStackSummaries,
  remoteOnlyStacks,
  topBranchOf,
} from '../src/stacks.ts';
import type { BranchPr, GithubGraph, RemoteStack } from '../src/model.ts';

/**
 * Real repositories, for init.test.ts's reason: readStackSummaries reads
 * `.git/gh-stack` and `git for-each-ref` together, and a mocked git could only
 * agree with whatever this file assumed about them.
 *
 * `readPullRequests` is exercised through a fake `gh` — a shell script on a
 * temp path — rather than the real one, which would need auth and a network.
 * What matters there is the parsing, and specifically that every way the call
 * can go wrong degrades to an empty index instead of throwing.
 */

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_EDITOR: 'true' },
  }).trim();
}

function commit(cwd: string, file: string, body: string, message: string): void {
  writeFileSync(join(cwd, file), body);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-m', message);
}

/** A repo on `main` with one commit and no stack. */
function makeRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'restack-stacks-'));
  git(cwd, 'init', '-b', 'main');
  git(cwd, 'config', 'user.email', 'test@example.com');
  git(cwd, 'config', 'user.name', 'Restack Test');
  git(cwd, 'config', 'commit.gpgsign', 'false');
  commit(cwd, 'README.md', 'base\n', 'init');
  return cwd;
}

/** A branch off `from` with one commit of its own; leaves HEAD on main. */
function branch(cwd: string, name: string, from = 'main'): void {
  git(cwd, 'checkout', from);
  git(cwd, 'checkout', '-b', name);
  commit(cwd, `${name.replace(/\//g, '-')}.txt`, `${name}\n`, `feat: ${name}`);
  git(cwd, 'checkout', 'main');
}

/** `.git/gh-stack` in gh-stack v0.1.0's shape: bases are not read here. */
function writeMetadata(cwd: string, stacks: { trunk: string; branches: string[] }[]): void {
  writeFileSync(
    join(cwd, '.git', 'gh-stack'),
    JSON.stringify(
      {
        schemaVersion: 1,
        repository: '',
        stacks: stacks.map((s) => ({
          trunk: { branch: s.trunk, head: git(cwd, 'rev-parse', s.trunk) },
          branches: s.branches.map((b) => ({ branch: b, base: git(cwd, 'rev-parse', s.trunk) })),
        })),
      },
      null,
      2,
    ),
  );
}

/**
 * A `gh` stand-in that prints `output` and exits `code`.
 *
 * `stream` matters for the failure cases: the real gh writes its errors to
 * stderr, and readStack reads that first. Successful JSON output goes to
 * stdout, which is the default.
 */
function fakeGh(output: string, code = 0, stream: 'stdout' | 'stderr' = 'stdout'): string {
  const dir = mkdtempSync(join(tmpdir(), 'restack-gh-'));
  const path = join(dir, 'gh');
  const redirect = stream === 'stderr' ? ' >&2' : '';
  writeFileSync(path, `#!/bin/sh\ncat <<'EOF'${redirect}\n${output}\nEOF\nexit ${code}\n`, {
    mode: 0o755,
  });
  return path;
}

test('two stacks get positional indices and exactly one is active', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  branch(cwd, 'feat/auth');
  branch(cwd, 'feat/api', 'feat/auth');
  branch(cwd, 'db/schema');
  branch(cwd, 'db/seed', 'db/schema');
  writeMetadata(cwd, [
    { trunk: 'main', branches: ['feat/auth', 'feat/api'] },
    { trunk: 'main', branches: ['db/schema', 'db/seed'] },
  ]);

  const summaries = await readStackSummaries(cwd, ['db/schema', 'db/seed']);

  assert.deepEqual(
    summaries.map((s) => s.index),
    [1, 2],
  );
  assert.deepEqual(
    summaries.map((s) => s.isActive),
    [false, true],
  );
  assert.deepEqual(summaries[0].branches, ['feat/auth', 'feat/api']);
});

test('HEAD outside every stack leaves none active', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  branch(cwd, 'feat/auth');
  writeMetadata(cwd, [{ trunk: 'main', branches: ['feat/auth'] }]);

  // `gh stack view` reported nothing, so the active branch list is empty. An
  // empty set must not match a stack — every stack would be active.
  const summaries = await readStackSummaries(cwd, []);

  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].isActive, false);
});

test('a shared branch does not make two stacks active', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  branch(cwd, 'feat/auth');
  branch(cwd, 'feat/api', 'feat/auth');

  // The second stack is stacked *on* the first's top branch — the ordinary way
  // a repository grows a second stack, and the case that makes a subset test
  // wrong: `['feat/api']` is contained in stack 1 and equal to stack 2.
  writeMetadata(cwd, [
    { trunk: 'main', branches: ['feat/auth', 'feat/api'] },
    { trunk: 'feat/auth', branches: ['feat/api'] },
  ]);

  const summaries = await readStackSummaries(cwd, ['feat/api']);

  assert.deepEqual(
    summaries.map((s) => s.isActive),
    [false, true],
  );
});

test('no metadata file yields no stacks rather than an error', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  assert.deepEqual(await readStackSummaries(cwd, []), []);
});

test('PRs are matched to branches by head ref', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  branch(cwd, 'feat/auth');
  branch(cwd, 'feat/api', 'feat/auth');
  writeMetadata(cwd, [{ trunk: 'main', branches: ['feat/auth', 'feat/api'] }]);

  const gh = fakeGh(
    JSON.stringify([
      { number: 7, headRefName: 'feat/auth', state: 'MERGED', title: 'auth', url: 'u7', isDraft: false },
      { number: 8, headRefName: 'feat/api', state: 'OPEN', title: 'api', url: 'u8', isDraft: true },
      { number: 9, headRefName: 'unrelated', state: 'OPEN', title: 'x', url: 'u9', isDraft: false },
    ]),
  );

  const prs = await readPullRequests(cwd, gh);
  const [stack] = await readStackSummaries(cwd, [], { ...emptyGraph(), prs });

  // gh reports states uppercase; the webview keys CSS off them lowercased.
  assert.equal(stack.prs['feat/auth'].state, 'merged');
  assert.equal(stack.prs['feat/api'].number, 8);
  assert.equal(stack.prs['feat/api'].isDraft, true);
  // A PR on a branch outside the stack is not the stack's business.
  assert.equal(stack.prs.unrelated, undefined);
});

test('the newest PR wins when a branch has had several', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  // `gh pr list` returns newest first, and `--state all` means a branch that
  // was closed and reopened appears twice.
  const gh = fakeGh(
    JSON.stringify([
      { number: 12, headRefName: 'feat/auth', state: 'OPEN', title: 'again', url: 'u12', isDraft: false },
      { number: 3, headRefName: 'feat/auth', state: 'CLOSED', title: 'first try', url: 'u3', isDraft: false },
    ]),
  );

  const prs = await readPullRequests(cwd, gh);

  assert.equal(prs.get('feat/auth')?.number, 12);
});

test('`no git remotes found` on stdout is not JSON and not an error', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  // The real exit-0-with-plain-text case: a repository with no remote.
  const prs = await readPullRequests(cwd, fakeGh('no git remotes found'));

  assert.equal(prs.size, 0);
});

test('a failing gh yields an empty index rather than throwing', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const prs = await readPullRequests(cwd, fakeGh('not authenticated', 1));

  assert.equal(prs.size, 0);
});

test('PR entries missing a branch or number are skipped, not thrown on', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const gh = fakeGh(
    JSON.stringify([
      null,
      { headRefName: 'feat/auth' },
      { number: 4 },
      { number: 5, headRefName: 'feat/api', state: 'OPEN' },
    ]),
  );

  const prs = await readPullRequests(cwd, gh);

  assert.equal(prs.size, 1);
  assert.equal(prs.get('feat/api')?.number, 5);
  // Absent optional fields become empty strings, not undefined — the webview
  // renders them directly.
  assert.equal(prs.get('feat/api')?.url, '');
});

test('a branch in several stacks is no-stack, not an error', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  // gh-stack exits 6 with `branch %q belongs to multiple stacks` — its own code,
  // distinct from the 2 it uses for "not in a stack". A shared trunk hits this
  // the moment a repository has two stacks based on it, which makes standing on
  // `main` the normal resting position that must not render a failure screen.
  const gh = fakeGh('✗ branch "main" belongs to multiple stacks; checkout a non-trunk branch first', 6);

  const result = await readStack(cwd, gh);

  assert.equal(result.kind, 'no-stack');
});

test('a gh that has never heard of `stack` is stack-missing, not gh-missing', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  // What gh 2.96 actually writes to stderr, exiting 1. Its own kind because
  // the fix differs: this one is a command Restack can offer to run, and
  // titling it "gh CLI unavailable" would be wrong — gh is right here.
  const gh = fakeGh('unknown command "stack" for "gh"', 1, 'stderr');

  const result = await readStack(cwd, gh);

  assert.equal(result.kind, 'stack-missing');
});

test('a gh that cannot be spawned at all is gh-missing', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  // ENOENT, the case Restack cannot fix for you: installing the CLI needs the
  // CLI. The message names the configured path, since a wrong
  // `restack.ghPath` lands here too.
  const result = await readStack(cwd, join(cwd, 'no-such-gh'));

  assert.equal(result.kind, 'gh-missing');
  assert.match(result.message, /no-such-gh/);
});

test('topBranchOf returns the top, which is the branch to check out', () => {
  assert.equal(topBranchOf({ branches: ['feat/auth', 'feat/api'] }), 'feat/api');
  assert.equal(topBranchOf({ branches: [] }), undefined);
});

/**
 * The GitHub half. Pure functions over data github.ts already parsed, so these
 * need neither a repository nor a fake `gh` — unlike the tests above, which are
 * claims about git's output and gh's exit codes.
 */

/** A PR index entry, with only the fields the matchers read. */
function pr(number: number, stackNumber?: number): BranchPr {
  return { number, url: '', title: '', state: 'open', isDraft: false, stackNumber };
}

function prIndex(entries: Record<string, BranchPr>): Map<string, BranchPr> {
  return new Map(Object.entries(entries));
}

/** A GitHub stack from `branch: state` pairs, numbered bottom-to-top. */
function remoteStack(
  number: number,
  branches: Array<[string, string]>,
  baseRefName = 'main',
): RemoteStack {
  return {
    number,
    size: branches.length,
    baseRefName,
    entries: branches.map(([headRefName, state], i) => ({
      position: i + 1,
      number: 100 + i,
      headRefName,
      state,
    })),
  };
}

test('a local stack whose PRs agree on one GitHub stack is matched to it', () => {
  const matched = matchRemoteStack(
    { trunk: 'main', branches: ['feat/auth', 'feat/api'] },
    prIndex({ 'feat/auth': pr(7, 42), 'feat/api': pr(8, 42) }),
  );

  assert.equal(matched, 42);
});

test('one submitted branch is enough to match — the top is often unsubmitted', () => {
  const matched = matchRemoteStack(
    { trunk: 'main', branches: ['feat/auth', 'feat/api'] },
    prIndex({ 'feat/auth': pr(7, 42) }),
  );

  assert.equal(matched, 42);
});

test('a stack with no PRs matches nothing', () => {
  assert.equal(
    matchRemoteStack({ trunk: 'main', branches: ['feat/auth'] }, prIndex({})),
    undefined,
  );
  // A PR that exists but belongs to no GitHub stack is the same answer: a
  // single unstacked PR is not a stack to badge.
  assert.equal(
    matchRemoteStack({ trunk: 'main', branches: ['feat/auth'] }, prIndex({ 'feat/auth': pr(7) })),
    undefined,
  );
});

test('branches pointing at two GitHub stacks match neither', () => {
  // The ambiguity gh-stack refuses locally with `belongs to multiple stacks`.
  // Picking one to badge would present a guess as a fact.
  const matched = matchRemoteStack(
    { trunk: 'main', branches: ['feat/auth', 'feat/api'] },
    prIndex({ 'feat/auth': pr(7, 42), 'feat/api': pr(8, 43) }),
  );

  assert.equal(matched, undefined);
});

test('a PR added to the stack on GitHub shows as onlyRemote', () => {
  const divergence = computeDivergence(
    ['feat/auth', 'feat/api'],
    remoteStack(42, [
      ['feat/auth', 'open'],
      ['feat/api', 'open'],
      ['feat/cache', 'open'],
    ]),
  );

  assert.deepEqual(divergence.onlyRemote, ['feat/cache']);
  assert.deepEqual(divergence.onlyLocal, []);
});

test('a branch not yet submitted shows as onlyLocal, which is ordinary', () => {
  const divergence = computeDivergence(
    ['feat/auth', 'feat/api'],
    remoteStack(42, [['feat/auth', 'open']]),
  );

  assert.deepEqual(divergence.onlyRemote, []);
  assert.deepEqual(divergence.onlyLocal, ['feat/api']);
});

test('merged and closed entries are not divergence', () => {
  // A PR that merged and had its branch deleted is the normal end of a stack's
  // life — the same reason `isTracked` ignores a `gone` upstream.
  const divergence = computeDivergence(
    ['feat/api'],
    remoteStack(42, [
      ['feat/auth', 'MERGED'],
      ['feat/old', 'closed'],
      ['feat/api', 'open'],
    ]),
  );

  assert.deepEqual(divergence.onlyRemote, []);
  assert.deepEqual(divergence.onlyLocal, []);
});

test('a stack with no local branches is offered for checkout', () => {
  const github: GithubGraph = {
    ...emptyGraph(),
    stacks: new Map([[42, remoteStack(42, [['their/one', 'open'], ['their/two', 'open']], 'trunk')]]),
  };

  const [only] = remoteOnlyStacks(github, [{ trunk: 'main', branches: ['mine'] }]);

  assert.equal(only.number, 42);
  assert.equal(only.baseRefName, 'trunk');
  // The bottom-most open PR: checkout resolves the stack from any of its PRs.
  assert.equal(only.checkoutPr, 100);
});

test('a stack sharing even one branch is not remote-only', () => {
  // Half checked out is a stack you already have; offering to check it out
  // again would be offering to redo work. Divergence covers it instead.
  const github: GithubGraph = {
    ...emptyGraph(),
    stacks: new Map([[42, remoteStack(42, [['feat/auth', 'open'], ['feat/api', 'open']])]]),
  };

  assert.deepEqual(remoteOnlyStacks(github, [{ trunk: 'main', branches: ['feat/auth'] }]), []);
});

test('a fully merged stack is dropped, as gh stack checkout drops it', () => {
  const github: GithubGraph = {
    ...emptyGraph(),
    stacks: new Map([[42, remoteStack(42, [['done/one', 'MERGED'], ['done/two', 'MERGED']])]]),
  };

  assert.deepEqual(remoteOnlyStacks(github, []), []);
});

test('checkoutPr skips a merged bottom whose branch may be gone', () => {
  const github: GithubGraph = {
    ...emptyGraph(),
    stacks: new Map([[42, remoteStack(42, [['done', 'MERGED'], ['live', 'open']])]]),
  };

  assert.equal(remoteOnlyStacks(github, [])[0].checkoutPr, 101);
});

test('a matched stack carries its GitHub number and divergence into the summary', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  branch(cwd, 'feat/auth');
  branch(cwd, 'feat/api', 'feat/auth');
  writeMetadata(cwd, [{ trunk: 'main', branches: ['feat/auth', 'feat/api'] }]);

  const github: GithubGraph = {
    ...emptyGraph(),
    prs: prIndex({ 'feat/auth': pr(7, 42), 'feat/api': pr(8, 42) }),
    stacks: new Map([
      [42, remoteStack(42, [['feat/auth', 'open'], ['feat/api', 'open'], ['feat/cache', 'open']])],
    ]),
  };

  const [summary] = await readStackSummaries(cwd, [], github);

  assert.equal(summary.remoteStackNumber, 42);
  assert.deepEqual(summary.divergence?.onlyRemote, ['feat/cache']);
});

test('a stack that agrees with GitHub carries no divergence at all', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  branch(cwd, 'feat/auth');
  writeMetadata(cwd, [{ trunk: 'main', branches: ['feat/auth'] }]);

  const github: GithubGraph = {
    ...emptyGraph(),
    prs: prIndex({ 'feat/auth': pr(7, 42) }),
    stacks: new Map([[42, remoteStack(42, [['feat/auth', 'open']])]]),
  };

  const [summary] = await readStackSummaries(cwd, [], github);

  // Undefined rather than a pair of empty arrays: the UI treats its presence
  // as the signal rather than having to look inside.
  assert.equal(summary.divergence, undefined);
  assert.equal(summary.remoteStackNumber, 42);
});

test('summaries built without GitHub carry no stack fields and still work', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  branch(cwd, 'feat/auth');
  writeMetadata(cwd, [{ trunk: 'main', branches: ['feat/auth'] }]);

  const [summary] = await readStackSummaries(cwd, []);

  assert.equal(summary.remoteStackNumber, undefined);
  assert.equal(summary.divergence, undefined);
});
