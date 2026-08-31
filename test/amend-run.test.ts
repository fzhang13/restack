import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { amendPlan } from '../src/amend.ts';
import { collect, commitsOn, git, makeRepo, readStackFrom } from './support/repo.ts';

/** The commit at the tip of `branch`, as amendPlan's target. */
function tipOf(cwd: string, branch: string) {
  return {
    branch,
    sha: git(cwd, 'rev-parse', branch),
    subject: git(cwd, 'log', '-1', '--format=%s', branch),
  };
}

test('amend folds into the target rather than appending, and the branch above inherits it', async () => {
  const cwd = makeRepo();
  const stack = readStackFrom(cwd);

  git(cwd, 'checkout', 'feat/api');
  const target = tipOf(cwd, 'feat/api');
  const before = commitsOn(cwd, 'feat/api').length;

  writeFileSync(join(cwd, 'api.txt'), 'api\nreview feedback\n');
  git(cwd, 'add', 'api.txt');

  const plan = amendPlan(stack, target, { head: 'feat/api', staged: true, unstaged: false });
  const { runner } = collect();
  await runner.start(cwd, 'gh', stack, plan, stack.branches.map((b) => b.name), 'local');

  assert.equal(commitsOn(cwd, 'feat/api').length, before, 'folded, not appended');
  assert.equal(git(cwd, 'show', 'feat/api:api.txt'), 'api\nreview feedback');
  assert.equal(git(cwd, 'show', 'feat/ui:api.txt'), 'api\nreview feedback', 'inherited above');
  assert.deepEqual(commitsOn(cwd, 'feat/ui'), [
    'feat: add ui components',
    'feat: add api routes',
    'feat: add auth layer',
  ]);
  assert.equal(git(cwd, 'status', '--porcelain'), '', 'tree clean at the end');
});

test('carry: amend a branch below the one HEAD is on', async () => {
  const cwd = makeRepo();
  const stack = readStackFrom(cwd);

  // HEAD is on feat/ui; the change belongs in feat/auth, two branches down.
  const target = tipOf(cwd, 'feat/auth');
  const headTip = git(cwd, 'rev-parse', 'feat/ui');
  writeFileSync(join(cwd, 'auth.txt'), 'auth\nfix\n');
  git(cwd, 'add', 'auth.txt');

  const plan = amendPlan(stack, target, {
    head: 'feat/ui',
    headTip,
    staged: true,
    unstaged: false,
  });
  const { runner } = collect();
  await runner.start(cwd, 'gh', stack, plan, stack.branches.map((b) => b.name), 'local');

  assert.equal(git(cwd, 'show', 'feat/auth:auth.txt'), 'auth\nfix');
  assert.equal(git(cwd, 'show', 'feat/ui:auth.txt'), 'auth\nfix', 'inherited');
  assert.deepEqual(commitsOn(cwd, 'feat/ui'), [
    'feat: add ui components',
    'feat: add api routes',
    'feat: add auth layer',
  ]);
  assert.equal(commitsOn(cwd, 'feat/auth').length, 1, 'feat/auth still has one commit');
  assert.equal(git(cwd, 'status', '--porcelain'), '', 'tree clean at the end');
});

test('reword replaces the message and leaves the content alone', async () => {
  const cwd = makeRepo();
  const stack = readStackFrom(cwd);
  git(cwd, 'checkout', 'feat/api');
  const target = tipOf(cwd, 'feat/api');
  // `commitsOn` is `main..branch`, so feat/api legitimately holds feat/auth's
  // commit too. What matters is that the empty `amend!` commit is folded away
  // rather than left behind, so the count is compared, not asserted at 1.
  const before = commitsOn(cwd, 'feat/api').length;

  const plan = amendPlan(stack, target, {
    head: 'feat/api',
    staged: false,
    unstaged: false,
    message: 'feat: add api routes and their tests',
  });
  const { runner } = collect();
  await runner.start(cwd, 'gh', stack, plan, stack.branches.map((b) => b.name), 'local');

  assert.equal(git(cwd, 'log', '-1', '--format=%s', 'feat/api'), 'feat: add api routes and their tests');
  assert.equal(git(cwd, 'show', 'feat/api:api.txt'), 'api');
  assert.equal(commitsOn(cwd, 'feat/api').length, before, 'the empty amend! commit is folded away');
});

test('rolling back an amend puts the change back staged, with HEAD unmoved', async () => {
  const cwd = makeRepo();
  const stack = readStackFrom(cwd);
  git(cwd, 'checkout', 'feat/api');
  const target = tipOf(cwd, 'feat/api');
  const apiBefore = git(cwd, 'rev-parse', 'feat/api');
  const uiBefore = git(cwd, 'rev-parse', 'feat/ui');

  writeFileSync(join(cwd, 'api.txt'), 'api\nreview feedback\n');
  git(cwd, 'add', 'api.txt');

  const plan = amendPlan(stack, target, { head: 'feat/api', staged: true, unstaged: false });
  const { runner } = collect();
  await runner.start(cwd, 'gh', stack, plan, stack.branches.map((b) => b.name), 'local');
  await runner.abort();

  assert.equal(git(cwd, 'rev-parse', 'feat/api'), apiBefore, 'refs restored');
  assert.equal(git(cwd, 'rev-parse', 'feat/ui'), uiBefore);
  assert.equal(git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feat/api', 'HEAD unmoved');
  assert.equal(git(cwd, 'diff', '--cached', '--name-only'), 'api.txt', 'change is back, staged');
  assert.equal(git(cwd, 'show', 'HEAD:api.txt'), 'api', 'and is not committed');
});

test('a cherry-pick conflict pauses, resolves, and resumes', async () => {
  const cwd = makeRepo({ sharedFile: true });
  const stack = readStackFrom(cwd);

  const target = tipOf(cwd, 'feat/auth');
  const headTip = git(cwd, 'rev-parse', 'feat/ui');
  writeFileSync(join(cwd, 'shared.txt'), 'ui\nconflicting edit\n');
  git(cwd, 'add', 'shared.txt');

  const plan = amendPlan(stack, target, {
    head: 'feat/ui',
    headTip,
    staged: true,
    unstaged: false,
  });
  const { runner, states } = collect();
  await runner.start(cwd, 'gh', stack, plan, stack.branches.map((b) => b.name), 'local');

  const paused = states.at(-1)!;
  assert.equal(paused.phase, 'conflict');
  assert.deepEqual(paused.conflictFiles, ['shared.txt']);
  assert.equal(
    plan.steps[paused.stepIndex].kind,
    'pick',
    'the cherry-pick is what paused, not the rebase after it',
  );

  writeFileSync(join(cwd, 'shared.txt'), 'auth\nresolved\n');
  git(cwd, 'add', 'shared.txt');
  await runner.resume();

  // `cherry-pick --continue`, not `rebase --continue`, which is the whole point
  // — the latter fails outright against an open pick and the plan would stall
  // here forever. The cascade pausing again further up is expected: with
  // `sharedFile` every branch edits shared.txt, so replaying feat/api onto the
  // rewritten feat/auth conflicts for real. What matters is that it got past
  // the pick.
  const after = states.at(-1)!;
  assert.ok(after.stepIndex > paused.stepIndex, 'the pick was completed and the plan moved on');
  assert.equal(after.statuses[paused.stepIndex], 'done');
});
