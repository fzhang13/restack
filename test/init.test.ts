import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addPreflight,
  detectTrunk,
  initPreflight,
  readLocalStacks,
  unstackPreflight,
} from '../src/init.ts';
import { addArgs, initArgs, installArgs, unstackArgs } from '../src/plan.ts';
import { ensureBaseBranch } from '../src/remote.ts';

/**
 * Like apply.test.ts, these run against real repositories. The whole job of
 * this module is deciding whether `gh stack init` is safe to run *here*, and a
 * mocked git could only ever agree with whatever we assumed.
 *
 * The one thing not exercised is `gh stack init` itself: it is another tool's
 * binary, may not be installed on CI, and would reach the network for the
 * repository lookup. What is tested is every guard in front of it.
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
  const cwd = mkdtempSync(join(tmpdir(), 'restack-init-'));
  git(cwd, 'init', '-b', 'main');
  git(cwd, 'config', 'user.email', 'test@example.com');
  git(cwd, 'config', 'user.name', 'Restack Test');
  git(cwd, 'config', 'commit.gpgsign', 'false');
  commit(cwd, 'README.md', 'base\n', 'init');
  return cwd;
}

/** A branch off main with one commit of its own. */
function branch(cwd: string, name: string): void {
  git(cwd, 'checkout', 'main');
  git(cwd, 'checkout', '-b', name);
  commit(cwd, `${name.replace(/\//g, '-')}.txt`, `${name}\n`, `feat: ${name}`);
  git(cwd, 'checkout', 'main');
}

function writeMetadata(cwd: string, stacks: unknown[]): void {
  writeFileSync(
    join(cwd, '.git', 'gh-stack'),
    JSON.stringify({ schemaVersion: 1, repository: '', stacks }, null, 2),
  );
}

test('initArgs builds the gh stack init command, branches bottom-to-top', () => {
  assert.deepEqual(initArgs('main', ['feat/auth', 'feat/api']), [
    'stack',
    'init',
    '--base',
    'main',
    'feat/auth',
    'feat/api',
  ]);
});

test('detectTrunk prefers the remote default branch', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  git(cwd, 'checkout', '-b', 'trunk');
  commit(cwd, 'trunk.txt', 'trunk\n', 'trunk');
  git(cwd, 'checkout', 'main');

  // Fake an origin/HEAD without a network remote.
  git(cwd, 'update-ref', 'refs/remotes/origin/trunk', git(cwd, 'rev-parse', 'trunk'));
  git(cwd, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');

  const info = await detectTrunk(cwd);
  assert.equal(info.trunk, 'trunk');
  assert.deepEqual(info.localBranches.sort(), ['main', 'trunk']);
});

test('detectTrunk falls back to main with no remote', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const info = await detectTrunk(cwd);
  assert.equal(info.trunk, 'main');
});

test('detectTrunk matches a trunk gh-stack already recorded', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  git(cwd, 'branch', 'develop');
  branch(cwd, 'feat/one');
  writeMetadata(cwd, [
    {
      trunk: { branch: 'develop', head: git(cwd, 'rev-parse', 'develop') },
      branches: [{ branch: 'feat/one', base: git(cwd, 'rev-parse', 'develop') }],
    },
  ]);

  // `main` exists and would otherwise win; matching what gh-stack recorded
  // beats guessing the conventional name.
  assert.equal((await detectTrunk(cwd)).trunk, 'develop');
});

test('readLocalStacks returns every recorded stack', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const head = git(cwd, 'rev-parse', 'main');
  writeMetadata(cwd, [
    {
      trunk: { branch: 'main', head },
      branches: [{ branch: 'feat/a', base: head }, { branch: 'feat/b', base: head }],
    },
    { trunk: { branch: 'main', head }, branches: [{ branch: 'solo', base: head }] },
  ]);

  const stacks = await readLocalStacks(cwd);
  assert.equal(stacks.length, 2);
  assert.deepEqual(stacks[0], { trunk: 'main', branches: ['feat/a', 'feat/b'] });
  assert.deepEqual(stacks[1], { trunk: 'main', branches: ['solo'] });
});

test('readLocalStacks degrades to empty rather than throwing', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  // No file at all: the ordinary case for a repo that has never stacked.
  assert.deepEqual(await readLocalStacks(cwd), []);

  writeFileSync(join(cwd, '.git', 'gh-stack'), 'not json {');
  assert.deepEqual(await readLocalStacks(cwd), []);

  writeFileSync(join(cwd, '.git', 'gh-stack'), JSON.stringify({ schemaVersion: 1 }));
  assert.deepEqual(await readLocalStacks(cwd), []);
});

test('initPreflight accepts a clean repository', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  branch(cwd, 'feat/one');

  assert.equal(await initPreflight(cwd, 'main', ['feat/one']), undefined);
  // A branch that does not exist yet is fine: gh-stack creates it.
  assert.equal(await initPreflight(cwd, 'main', ['feat/new']), undefined);
});

test('initPreflight refuses an empty branch list', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  // `gh stack init` with no arguments exits 5 asking for interactive input,
  // which a webview cannot supply.
  const message = await initPreflight(cwd, 'main', []);
  assert.match(message ?? '', /at least one branch/i);
});

test('initPreflight refuses a dirty working tree', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  branch(cwd, 'feat/one');

  writeFileSync(join(cwd, 'README.md'), 'edited\n');

  // The load-bearing guard: gh stack init writes .git/gh-stack *before*
  // checking out the top branch, so a dirty tree that blocks the checkout
  // leaves a stack half-created.
  const message = await initPreflight(cwd, 'main', ['feat/one']);
  assert.match(message ?? '', /uncommitted changes/i);
});

test('initPreflight refuses a trunk that does not exist', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  branch(cwd, 'feat/one');

  // gh-stack does not check this itself: --base nope succeeds and records a
  // trunk no branch matches.
  const message = await initPreflight(cwd, 'nope', ['feat/one']);
  assert.match(message ?? '', /does not exist/i);
});

test('initPreflight refuses the trunk as a stack member, and duplicates', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  branch(cwd, 'feat/one');

  assert.match((await initPreflight(cwd, 'main', ['main'])) ?? '', /trunk/i);
  assert.match(
    (await initPreflight(cwd, 'main', ['feat/one', 'feat/one'])) ?? '',
    /twice/i,
  );
});

test('initPreflight refuses an invalid branch name', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const message = await initPreflight(cwd, 'main', ['feat/../etc']);
  assert.match(message ?? '', /not a valid branch name/i);
});

test('initPreflight refuses outside a git repository', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'restack-init-bare-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  assert.match((await initPreflight(cwd, 'main', ['feat/one'])) ?? '', /not a git repository/i);
});

/**
 * Adding a branch to a stack that already exists. `gh stack add` itself is not
 * run, for the same reasons as init — what is covered is the guards, plus the
 * one thing gh-stack does *not* guard: a dirty tree.
 */

test('addArgs builds the gh stack add command', () => {
  assert.deepEqual(addArgs('feat/four'), ['stack', 'add', 'feat/four']);
});

test('addPreflight accepts a clean repository', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  branch(cwd, 'feat/one');

  // Both meanings of the command: a name to create, and one to adopt.
  assert.equal(await addPreflight(cwd, 'main', ['feat/one'], 'feat/new'), undefined);
  branch(cwd, 'feat/two');
  assert.equal(await addPreflight(cwd, 'main', ['feat/one'], 'feat/two'), undefined);
});

test('addPreflight refuses a branch already in the stack', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  branch(cwd, 'feat/one');

  const message = await addPreflight(cwd, 'main', ['feat/one'], 'feat/one');
  assert.match(message ?? '', /already in this stack/i);
});

test('addPreflight refuses the trunk, an empty name, and an invalid one', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  branch(cwd, 'feat/one');

  assert.match((await addPreflight(cwd, 'main', ['feat/one'], 'main')) ?? '', /trunk/i);
  assert.match((await addPreflight(cwd, 'main', ['feat/one'], '')) ?? '', /name the branch/i);
  assert.match(
    (await addPreflight(cwd, 'main', ['feat/one'], 'feat/../etc')) ?? '',
    /not a valid branch name/i,
  );
});

test('addPreflight refuses a dirty working tree', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  branch(cwd, 'feat/one');

  writeFileSync(join(cwd, 'README.md'), 'edited\n');

  // gh-stack does not refuse this itself — verified against v0.1.0, which
  // added a branch with uncommitted changes sitting in the tree. The guard is
  // for the checkout Restack does first, to reach the top of the stack.
  const message = await addPreflight(cwd, 'main', ['feat/one'], 'feat/new');
  assert.match(message ?? '', /uncommitted changes/i);
});

test('addPreflight refuses mid-rebase', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  git(cwd, 'checkout', '-b', 'feat/two');
  commit(cwd, 'clash.txt', 'theirs\n', 'feat: clash');
  git(cwd, 'checkout', 'main');
  commit(cwd, 'clash.txt', 'ours\n', 'main: clash');
  try {
    git(cwd, 'rebase', 'main', 'feat/two');
  } catch {
    // Expected: the rebase stops on the conflict, which is the state under test.
  }

  // Checked before the dirty-tree guard, as in unstackPreflight: a paused
  // rebase leaves unmerged files, and naming those would report the symptom.
  assert.match((await addPreflight(cwd, 'main', [], 'feat/new')) ?? '', /rebase is in progress/i);
});

test('addPreflight refuses outside a git repository', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'restack-add-bare-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  assert.match((await addPreflight(cwd, 'main', [], 'feat/new')) ?? '', /not a git repository/i);
});

/**
 * Removing a stack. As above, `gh stack unstack` itself is never run — these
 * cover the guards in front of it. A stack with one branch recorded is enough
 * for every case: the command takes no branch arguments, only the file's
 * presence matters.
 */
function makeStackedRepo(): string {
  const cwd = makeRepo();
  branch(cwd, 'feat/one');
  writeMetadata(cwd, [
    {
      trunk: { branch: 'main', head: git(cwd, 'rev-parse', 'main') },
      branches: [{ branch: 'feat/one', base: git(cwd, 'rev-parse', 'main') }],
    },
  ]);
  return cwd;
}

test('unstackArgs builds the gh stack unstack command for each scope', () => {
  assert.deepEqual(unstackArgs(true), ['stack', 'unstack', '--local']);
  assert.deepEqual(unstackArgs(false), ['stack', 'unstack']);
});

test('installArgs builds the gh extension install command', () => {
  // The setup screen previews this string and the host runs this argv, so a
  // change to either has to be a change to both.
  assert.deepEqual(installArgs(), ['extension', 'install', 'github/gh-stack']);
});

test('unstackPreflight accepts a clean repository with a stack', async (t) => {
  const cwd = makeStackedRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  assert.equal(await unstackPreflight(cwd, 'local'), undefined);
});

test('unstackPreflight refuses with no .git/gh-stack to remove', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  assert.match((await unstackPreflight(cwd, 'local')) ?? '', /no stack to remove/i);
});

test('unstackPreflight refuses a dirty working tree', async (t) => {
  const cwd = makeStackedRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  writeFileSync(join(cwd, 'README.md'), 'edited\n');

  // gh-stack's unstack path can check out a branch, and its failure modes
  // include one blocked partway.
  assert.match((await unstackPreflight(cwd, 'local')) ?? '', /uncommitted changes/i);
});

test('unstackPreflight refuses mid-rebase', async (t) => {
  const cwd = makeStackedRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  // A real conflicted rebase: feat/two and main both touch the same file.
  git(cwd, 'checkout', '-b', 'feat/two');
  commit(cwd, 'clash.txt', 'theirs\n', 'feat: clash');
  git(cwd, 'checkout', 'main');
  commit(cwd, 'clash.txt', 'ours\n', 'main: clash');
  try {
    git(cwd, 'rebase', 'main', 'feat/two');
  } catch {
    // Expected: the rebase stops on the conflict, which is the state under test.
  }

  assert.match((await unstackPreflight(cwd, 'local')) ?? '', /rebase is in progress/i);
});

test('unstackPreflight refuses a remote removal with no origin', async (t) => {
  const cwd = makeStackedRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  // Local is fine without a remote; only unstacking the PRs needs one.
  assert.equal(await unstackPreflight(cwd, 'local'), undefined);
  assert.match((await unstackPreflight(cwd, 'remote')) ?? '', /no `?origin`? remote/i);
});

test('unstackPreflight refuses outside a git repository', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'restack-unstack-bare-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  assert.match((await unstackPreflight(cwd, 'local')) ?? '', /not a git repository/i);
});

test('detectTrunk reports remote-only branches as candidate bases', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  // A colleague's branch that exists only on the remote — the case the base
  // picker is for, and the one a local-branches-only list cannot offer.
  branch(cwd, 'theirs');
  git(cwd, 'update-ref', 'refs/remotes/origin/theirs', git(cwd, 'rev-parse', 'theirs'));
  git(cwd, 'update-ref', 'refs/remotes/origin/main', git(cwd, 'rev-parse', 'main'));
  git(cwd, 'branch', '-D', 'theirs');
  git(cwd, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');

  const info = await detectTrunk(cwd);
  assert.equal(info.trunk, 'main');
  assert.deepEqual(info.localBranches, ['main']);
  // Qualified, and without the HEAD symref — which shortens to bare `origin`
  // and would otherwise show up as a branch you could base a stack on.
  assert.deepEqual(info.remoteBranches.sort(), ['origin/main', 'origin/theirs']);
});

test('detectTrunk reports no remote branches when there is no remote', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  assert.deepEqual((await detectTrunk(cwd)).remoteBranches, []);
});

test('a tracking branch created from a remote ref passes initPreflight', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  branch(cwd, 'feat/mine');
  branch(cwd, 'theirs');
  git(cwd, 'update-ref', 'refs/remotes/origin/theirs', git(cwd, 'rev-parse', 'theirs'));
  git(cwd, 'branch', '-D', 'theirs');
  // A configured remote, not just the refs: `git branch --track` resolves the
  // starting point through the fetch refspec and refuses without one.
  git(cwd, 'remote', 'add', 'origin', 'https://example.invalid/repo.git');

  // Before the local branch exists, gh-stack would record a trunk that does
  // not resolve — `gh stack init --base` does not validate it, so this guard
  // is the only thing standing between a typo and a broken stack.
  assert.match(
    (await initPreflight(cwd, 'theirs', ['feat/mine'])) ?? '',
    /Trunk theirs does not exist locally/,
  );

  assert.deepEqual(await ensureBaseBranch(cwd, 'theirs', 'origin/theirs'), { kind: 'created' });
  assert.equal(await initPreflight(cwd, 'theirs', ['feat/mine']), undefined);
});
