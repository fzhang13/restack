import assert from 'node:assert/strict';
import { test } from 'node:test';
import { amendPlan, branchAbove, PARKED_REF } from '../src/amend.ts';
import type { Stack } from '../src/model.ts';

/** Three branches on main, the shape makeRepo() builds, with no repository. */
function fixture(): Stack {
  return {
    trunk: 'main',
    currentBranch: 'feat/api',
    branches: [
      { name: 'feat/auth', base: 'aaa0000', isCurrent: false, isMerged: false, isQueued: false, needsRebase: false },
      { name: 'feat/api', base: 'bbb0000', isCurrent: true, isMerged: false, isQueued: false, needsRebase: false },
      { name: 'feat/ui', base: 'ccc0000', isCurrent: false, isMerged: false, isQueued: false, needsRebase: false },
    ],
  };
}

const TARGET = { branch: 'feat/api', sha: 'dddddddddddd', subject: 'feat: add api routes' };

/** The `command` string of every step, which is what the panel renders. */
function commands(stack: Stack, target = TARGET, options = {}): string[] {
  return amendPlan(stack, target, { staged: true, unstaged: false, head: 'feat/api', ...options })
    .steps.map((s) => s.command);
}

test('branchAbove finds the branch that inherits a rewrite', () => {
  assert.equal(branchAbove(fixture(), 'feat/auth'), 'feat/api');
  assert.equal(branchAbove(fixture(), 'feat/api'), 'feat/ui');
  assert.equal(branchAbove(fixture(), 'feat/ui'), undefined);
});

test('in-branch amend: fixup, park, autosquash, then cascade', () => {
  assert.deepEqual(commands(fixture()), [
    'git commit --fixup=dddddddddddd',
    `git update-ref ${PARKED_REF} HEAD`,
    'git rebase -i --autosquash bbb0000',
    'git rebase --onto feat/api ccc0000 feat/ui',
    '# Restack rewrites .git/gh-stack: branch order + recorded base SHAs',
    'gh stack push',
    'gh stack submit --auto',
    'gh stack link --base main feat/auth feat/api feat/ui',
  ]);
});

test('unstaged tracked changes are staged first; already-staged ones are not', () => {
  const staged = commands(fixture(), TARGET, { staged: true, unstaged: false });
  assert.ok(!staged.includes('git add -u'));

  const unstaged = commands(fixture(), TARGET, { staged: false, unstaged: true });
  assert.equal(unstaged[0], 'git add -u');
  assert.equal(unstaged[1], 'git commit --fixup=dddddddddddd');
});

test('amending the top branch needs no cascade and no metadata write', () => {
  const top = { branch: 'feat/ui', sha: 'eeeeeeeeeeee', subject: 'feat: add ui components' };
  assert.deepEqual(commands(fixture(), top, { head: 'feat/ui' }), [
    'git commit --fixup=eeeeeeeeeeee',
    `git update-ref ${PARKED_REF} HEAD`,
    'git rebase -i --autosquash ccc0000',
    'gh stack push',
    'gh stack submit --auto',
    'gh stack link --base main feat/auth feat/api feat/ui',
  ]);
});

test('the plan carries what undo needs', () => {
  const plan = amendPlan(fixture(), TARGET, { staged: true, unstaged: false, head: 'feat/api' });
  assert.deepEqual(plan.amend, {
    targetBranch: 'feat/api',
    targetSha: 'dddddddddddd',
    parked: true,
  });
  assert.equal(plan.isNoop, false);
});

test('carry: park the fixup, rewind the head branch, cherry-pick it across', () => {
  assert.deepEqual(
    commands(fixture(), { branch: 'feat/auth', sha: 'fff0000000', subject: 'feat: add auth layer' }, {
      head: 'feat/ui',
      headTip: '9999999999',
      staged: true,
      unstaged: false,
    }),
    [
      'git commit --fixup=fff0000000',
      `git update-ref ${PARKED_REF} HEAD`,
      'git checkout --detach',
      'git update-ref refs/heads/feat/ui 9999999999',
      'git checkout feat/auth',
      `git cherry-pick ${PARKED_REF}`,
      'git rebase -i --autosquash aaa0000',
      'git rebase --onto feat/auth bbb0000 feat/api',
      'git rebase --onto feat/api ccc0000 feat/ui',
      '# Restack rewrites .git/gh-stack: branch order + recorded base SHAs',
      'gh stack push',
      'gh stack submit --auto',
      'gh stack link --base main feat/auth feat/api feat/ui',
    ],
  );
});

test('from outside the stack: check the target out first', () => {
  const steps = commands(fixture(), TARGET, {
    head: 'main',
    headTip: '1111111111',
    staged: true,
    unstaged: false,
  });
  assert.equal(steps[0], 'git checkout feat/api');
  assert.equal(steps[1], 'git commit --fixup=dddddddddddd');
  assert.ok(!steps.includes('git checkout --detach'), 'no carry from outside the stack');
});

test('detached HEAD checks the target out rather than carrying', () => {
  const steps = commands(fixture(), TARGET, { head: undefined, staged: true, unstaged: false });
  assert.equal(steps[0], 'git checkout feat/api');
});

test('reword: an empty amend! commit, no park, content untouched', () => {
  const plan = amendPlan(fixture(), TARGET, {
    head: 'feat/api',
    staged: false,
    unstaged: false,
    message: 'feat: add api routes and their tests',
  });

  assert.deepEqual(plan.steps.slice(0, 2).map((s) => s.command), [
    'git commit --only --allow-empty -m amend! feat: add api routes -m feat: add api routes and their tests',
    'git rebase -i --autosquash bbb0000',
  ]);
  assert.equal(plan.amend?.parked, false, 'an empty commit cannot be cherry-picked back');
  assert.deepEqual(plan.steps[0].exec?.args, [
    'commit',
    '--only',
    '--allow-empty',
    '-m',
    'amend! feat: add api routes',
    '-m',
    'feat: add api routes and their tests',
  ]);
});

test('reword with content folds and rewords in one commit', () => {
  const plan = amendPlan(fixture(), TARGET, {
    head: 'feat/api',
    staged: true,
    unstaged: false,
    message: 'feat: add api routes and their tests',
  });

  assert.deepEqual(plan.steps[0].exec?.args, [
    'commit',
    '-m',
    'amend! feat: add api routes',
    '-m',
    'feat: add api routes and their tests',
  ]);
  assert.equal(plan.amend?.parked, true);
});

test('a merged branch anywhere is reported, so the preflight can judge it', () => {
  const stack = fixture();
  stack.branches[0].isMerged = true;
  assert.deepEqual(amendPlan(stack, TARGET, { staged: true, unstaged: false, head: 'feat/api' }).mergedBranches, [
    'feat/auth',
  ]);
});
