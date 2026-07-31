import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectTrunk, initPreflight, readLocalStacks } from '../src/init.ts';
import { initArgs } from '../src/plan.ts';

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
