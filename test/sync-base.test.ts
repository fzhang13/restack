import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { preflight } from '../src/apply.ts';
import { changeBasePlan, computePlan, syncPlan } from '../src/plan.ts';
import type { Stack } from '../src/model.ts';
import {
  ORDER,
  colleague,
  collect,
  commit,
  commitsOn,
  git,
  makeAdoptedRepo,
  makeRemoteRepo,
  makeRepo,
  metadataOrder,
  readStackFrom,
} from './support/repo.ts';

/**
 * The three plans that move a stack without reordering it: the forced rebase
 * that builds what an init only recorded, the sync that follows a trunk which
 * moved, and the base change that lifts the whole stack onto another branch.
 */

test('a forced plan builds the stack an init only recorded', async (t) => {
  const cwd = makeAdoptedRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const stack = readStackFrom(cwd);
  // gh-stack's own drift signal, which is what the UI offers the action on.
  const drifted = { ...stack, branches: stack.branches.map((b) => ({ ...b, needsRebase: true })) };
  const order = ORDER;
  const plan = computePlan(drifted, order, [], { force: true });

  assert.equal(plan.isNoop, false);
  assert.equal(await preflight(cwd, drifted, 'local', order), undefined);

  const { runner, states } = collect();
  await runner.start(cwd, 'gh', drifted, plan, order, 'local');

  const final = states.at(-1)!;
  assert.equal(final.phase, 'done');
  assert.equal(final.localComplete, true);

  // The point of the exercise: each branch now actually contains the work of
  // everything below it, which is what "stacked" means.
  assert.deepEqual(commitsOn(cwd, 'feat/auth'), ['feat: feat/auth']);
  assert.deepEqual(commitsOn(cwd, 'feat/api'), ['feat: feat/api', 'feat: feat/auth']);
  assert.deepEqual(commitsOn(cwd, 'feat/ui'), [
    'feat: feat/ui',
    'feat: feat/api',
    'feat: feat/auth',
  ]);

  // Each branch is an ancestor of the one above it — the invariant gh-stack's
  // ⚠ marker was complaining about.
  for (const [below, above] of [['feat/auth', 'feat/api'], ['feat/api', 'feat/ui']]) {
    assert.doesNotThrow(
      () => git(cwd, 'merge-base', '--is-ancestor', below, above),
      `${below} should be an ancestor of ${above}`,
    );
  }

  // And the recorded bases agree with where the refs actually are.
  assert.deepEqual(metadataOrder(cwd), order);
  const meta = JSON.parse(readFileSync(join(cwd, '.git', 'gh-stack'), 'utf8'));
  assert.equal(meta.stacks[0].branches[0].base, git(cwd, 'rev-parse', 'main'));
  assert.equal(meta.stacks[0].branches[1].base, git(cwd, 'rev-parse', 'feat/auth'));
  assert.equal(meta.stacks[0].branches[2].base, git(cwd, 'rev-parse', 'feat/api'));
});

test('syncing a moved trunk replays the stack onto it without absorbing its commits', async (t) => {
  const { cwd, origin } = makeRemoteRepo();
  const them = colleague(origin);
  t.after(() => [cwd, origin, them].forEach((d) => rmSync(d, { recursive: true, force: true })));

  // Two commits land on the trunk while we were working.
  git(them, 'checkout', 'main');
  commit(them, 'trunk-a.txt', 'a\n', 'chore: trunk a');
  commit(them, 'trunk-b.txt', 'b\n', 'chore: trunk b');
  git(them, 'push', 'origin', 'main');

  git(cwd, 'fetch', 'origin');
  const stack = readStackFrom(cwd);
  // HEAD is on feat/ui, so the trunk is not checked out: the fetch-refspec
  // form of the fast-forward.
  const plan = syncPlan(stack, 'origin', false);
  assert.equal(plan.steps[0].command, 'git fetch origin main:main');

  assert.equal(await preflight(cwd, stack, 'local', ORDER), undefined);

  const { runner, states } = collect();
  await runner.start(cwd, 'gh', stack, plan, ORDER, 'local');

  assert.equal(states.at(-1)!.phase, 'done');
  assert.equal(git(cwd, 'rev-parse', 'main'), git(cwd, 'rev-parse', 'origin/main'));

  // The whole point. Each branch carries its own work plus everything below
  // it — and *not* the trunk's two commits, which are now behind main and so
  // no longer show up in `main..branch` at all.
  assert.deepEqual(commitsOn(cwd, 'feat/auth'), ['feat: add auth layer']);
  assert.deepEqual(commitsOn(cwd, 'feat/api'), [
    'feat: add api routes',
    'feat: add auth layer',
  ]);
  assert.deepEqual(commitsOn(cwd, 'feat/ui'), [
    'feat: add ui components',
    'feat: add api routes',
    'feat: add auth layer',
  ]);
  // And the trunk's commits really are in there, rather than having been
  // skipped over by a rebase anchored to the wrong SHA.
  assert.doesNotThrow(() => git(cwd, 'merge-base', '--is-ancestor', 'main', 'feat/auth'));

  const meta = JSON.parse(readFileSync(join(cwd, '.git', 'gh-stack'), 'utf8'));
  assert.equal(meta.stacks[0].branches[0].base, git(cwd, 'rev-parse', 'main'));
});

test('syncing with the trunk checked out merges rather than fetching onto it', async (t) => {
  const { cwd, origin } = makeRemoteRepo();
  const them = colleague(origin);
  t.after(() => [cwd, origin, them].forEach((d) => rmSync(d, { recursive: true, force: true })));

  git(them, 'checkout', 'main');
  commit(them, 'trunk-a.txt', 'a\n', 'chore: trunk a');
  git(them, 'push', 'origin', 'main');

  git(cwd, 'checkout', 'main');
  git(cwd, 'fetch', 'origin');

  const stack = readStackFrom(cwd);
  const plan = syncPlan(stack, 'origin', true);
  assert.equal(plan.steps[0].command, 'git merge --ff-only origin/main');

  const { runner, states } = collect();
  await runner.start(cwd, 'gh', stack, plan, ORDER, 'local');

  // git refuses `fetch origin main:main` while main is checked out; the merge
  // form is what makes this work at all.
  assert.equal(states.at(-1)!.phase, 'done');
  assert.equal(git(cwd, 'rev-parse', 'main'), git(cwd, 'rev-parse', 'origin/main'));
  assert.deepEqual(commitsOn(cwd, 'feat/auth'), ['feat: add auth layer']);
});

test('changing the base moves the stack and records the new trunk', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  // A colleague's branch, sitting on main with a commit of its own.
  git(cwd, 'checkout', '-b', 'theirs', 'main');
  commit(cwd, 'theirs.txt', 'theirs\n', 'feat: their groundwork');
  git(cwd, 'checkout', 'feat/ui');

  const stack = readStackFrom(cwd);
  const rebased: Stack = { ...stack, trunk: 'theirs' };
  const plan = changeBasePlan(stack, 'theirs');

  assert.equal(await preflight(cwd, rebased, 'local', ORDER), undefined);

  const { runner, states } = collect();
  // The *modified* stack: this is what writeMetadata reads the trunk from.
  await runner.start(cwd, 'gh', rebased, plan, ORDER, 'local');

  assert.equal(states.at(-1)!.phase, 'done');

  // The bottom branch now sits on theirs, and carries its commit.
  assert.doesNotThrow(() => git(cwd, 'merge-base', '--is-ancestor', 'theirs', 'feat/auth'));
  assert.deepEqual(commitsOn(cwd, 'feat/auth'), [
    'feat: add auth layer',
    'feat: their groundwork',
  ]);
  // Each branch still holds exactly its own work relative to the one below.
  assert.equal(git(cwd, 'log', '--format=%s', 'feat/auth..feat/api'), 'feat: add api routes');
  assert.equal(git(cwd, 'log', '--format=%s', 'feat/api..feat/ui'), 'feat: add ui components');

  // Without this, `gh stack submit` retargets the bottom PR from stale data
  // and points it back at main.
  const meta = JSON.parse(readFileSync(join(cwd, '.git', 'gh-stack'), 'utf8'));
  assert.equal(meta.stacks[0].trunk.branch, 'theirs');
  assert.equal(meta.stacks[0].trunk.head, git(cwd, 'rev-parse', 'theirs'));
  assert.equal(meta.stacks[0].branches[0].base, git(cwd, 'rev-parse', 'theirs'));
});

test('undoing a base change puts every branch and the trunk record back', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  git(cwd, 'checkout', '-b', 'theirs', 'main');
  commit(cwd, 'theirs.txt', 'theirs\n', 'feat: their groundwork');
  git(cwd, 'checkout', 'feat/ui');

  const before = Object.fromEntries(ORDER.map((b) => [b, git(cwd, 'rev-parse', b)]));
  const stack = readStackFrom(cwd);
  const rebased: Stack = { ...stack, trunk: 'theirs' };

  const { runner } = collect();
  await runner.start(cwd, 'gh', rebased, changeBasePlan(stack, 'theirs'), ORDER, 'local');
  await runner.abort();

  for (const branch of ORDER) {
    assert.equal(git(cwd, 'rev-parse', branch), before[branch], `${branch} restored`);
  }
  // The metadata is part of what the snapshot covers, or an undo would leave
  // the refs on main and the record claiming theirs.
  const meta = JSON.parse(readFileSync(join(cwd, '.git', 'gh-stack'), 'utf8'));
  assert.equal(meta.stacks[0].trunk.branch, 'main');
});
