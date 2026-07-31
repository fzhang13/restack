import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStack } from '../src/stack.ts';
import { readPullRequests, readStackSummaries, topBranchOf } from '../src/stacks.ts';

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

/** A `gh` stand-in that prints `stdout` and exits `code`. */
function fakeGh(stdout: string, code = 0): string {
  const dir = mkdtempSync(join(tmpdir(), 'restack-gh-'));
  const path = join(dir, 'gh');
  writeFileSync(path, `#!/bin/sh\ncat <<'EOF'\n${stdout}\nEOF\nexit ${code}\n`, { mode: 0o755 });
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
  const [stack] = await readStackSummaries(cwd, [], prs);

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

test('topBranchOf returns the top, which is the branch to check out', () => {
  assert.equal(topBranchOf({ branches: ['feat/auth', 'feat/api'] }), 'feat/api');
  assert.equal(topBranchOf({ branches: [] }), undefined);
});
