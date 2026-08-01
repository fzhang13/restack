import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { preflight } from '../src/apply.ts';
import { computePlan } from '../src/plan.ts';
import {
  ORDER,
  addLooseBranch,
  collect,
  commitsOn,
  git,
  makeRepo,
  metadataOrder,
  readStackFrom,
} from './support/repo.ts';

/**
 * Applying a plan: what git actually does to the refs, what lands in
 * `.git/gh-stack`, and how a conflict pauses and unwinds. Run against real
 * repositories on disk — see test/support/repo.ts.
 *
 * Session persistence lives in session.test.ts, the preflight refusals in
 * preflight.test.ts, and sync/change-base in sync-base.test.ts.
 */

test('applying a reorder rewrites branches and the gh-stack metadata together', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const stack = readStackFrom(cwd);
  const next = ['feat/api', 'feat/ui', 'feat/auth'];
  const plan = computePlan(stack, next);

  assert.equal(await preflight(cwd, stack, 'local'), undefined);

  const { runner, states } = collect();
  await runner.start(cwd, 'gh', stack, plan, next, 'local');

  const final = states.at(-1)!;
  assert.equal(final.phase, 'done');
  assert.equal(final.localComplete, true);

  // One commit per branch, cumulative bottom-to-top. The failure this guards
  // against is a branch silently absorbing the commit below it.
  assert.deepEqual(commitsOn(cwd, 'feat/api'), ['feat: add api routes']);
  assert.deepEqual(commitsOn(cwd, 'feat/ui'), [
    'feat: add ui components',
    'feat: add api routes',
  ]);
  assert.deepEqual(commitsOn(cwd, 'feat/auth'), [
    'feat: add auth layer',
    'feat: add ui components',
    'feat: add api routes',
  ]);

  // Metadata must agree with the refs, or `gh stack submit` retargets from
  // stale data — the whole reason Restack writes this file.
  assert.deepEqual(metadataOrder(cwd), next);
  const meta = JSON.parse(readFileSync(join(cwd, '.git', 'gh-stack'), 'utf8'));
  assert.equal(meta.stacks[0].branches[0].base, git(cwd, 'rev-parse', 'main'));
  assert.equal(meta.stacks[0].branches[1].base, git(cwd, 'rev-parse', 'feat/api'));
  assert.equal(meta.stacks[0].branches[2].base, git(cwd, 'rev-parse', 'feat/ui'));

  // Rebasing checks out each branch in turn; the user gets theirs back.
  assert.equal(git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feat/ui');
});

test('local scope stops before push and submit', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const stack = readStackFrom(cwd);
  const next = ['feat/api', 'feat/ui', 'feat/auth'];
  const plan = computePlan(stack, next);

  const { runner, states } = collect();
  await runner.start(cwd, 'gh', stack, plan, next, 'local');

  const statuses = states.at(-1)!.statuses;
  const kinds = plan.steps.map((s) => s.kind);
  // There is no remote here; a push that ran would have failed loudly.
  assert.equal(statuses[kinds.indexOf('push')], 'skipped');
  assert.equal(statuses[kinds.indexOf('submit')], 'skipped');
  assert.equal(statuses[kinds.indexOf('metadata')], 'done');
});

test('a conflicting rebase pauses instead of unwinding', async (t) => {
  const cwd = makeRepo({ sharedFile: true });
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const stack = readStackFrom(cwd);
  const next = ['feat/ui', 'feat/auth', 'feat/api'];
  const plan = computePlan(stack, next);

  const { runner, states } = collect();
  await runner.start(cwd, 'gh', stack, plan, next, 'local');

  const final = states.at(-1)!;
  assert.equal(final.phase, 'conflict');
  assert.deepEqual(final.conflictFiles, ['shared.txt']);
  // Paused mid-plan, not rolled back: the user resolves and continues.
  assert.equal(final.localComplete, false);
  assert.ok(final.message?.includes('Resolve'));
});

test('abort restores every branch and the metadata byte for byte', async (t) => {
  const cwd = makeRepo({ sharedFile: true });
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const before = {
    auth: git(cwd, 'rev-parse', 'feat/auth'),
    api: git(cwd, 'rev-parse', 'feat/api'),
    ui: git(cwd, 'rev-parse', 'feat/ui'),
    metadata: readFileSync(join(cwd, '.git', 'gh-stack'), 'utf8'),
    head: git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD'),
  };

  const stack = readStackFrom(cwd);
  const next = ['feat/ui', 'feat/auth', 'feat/api'];
  const { runner, states } = collect();
  await runner.start(cwd, 'gh', stack, computePlan(stack, next), next, 'local');
  assert.equal(states.at(-1)!.phase, 'conflict');

  await runner.abort();

  assert.equal(git(cwd, 'rev-parse', 'feat/auth'), before.auth);
  assert.equal(git(cwd, 'rev-parse', 'feat/api'), before.api);
  assert.equal(git(cwd, 'rev-parse', 'feat/ui'), before.ui);
  assert.equal(readFileSync(join(cwd, '.git', 'gh-stack'), 'utf8'), before.metadata);
  assert.equal(git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), before.head);
  assert.equal(git(cwd, 'status', '--porcelain'), '');
  assert.equal(runner.active, false);
});

// The abort above unwinds a plan that stopped at a conflict, so the metadata
// write never ran and the recorded order was never the new one. Undo after a
// *clean* apply is the other path: the order on disk really did change, and
// putting it back is the whole point of the button.
//
// Covers the restore only. Whether the view then re-reads it is the provider's
// refresh, which has no automated coverage — see the F5 pass on sandbox/.
test('undoing a completed apply puts the recorded order back', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const before = metadataOrder(cwd);
  const stack = readStackFrom(cwd);
  const next = ['feat/api', 'feat/ui', 'feat/auth'];

  const { runner, states } = collect();
  await runner.start(cwd, 'gh', stack, computePlan(stack, next), next, 'local');

  // The apply landed, so the reorder is real before it is taken back.
  assert.equal(states.at(-1)!.phase, 'done');
  assert.deepEqual(metadataOrder(cwd), next);

  await runner.abort();

  assert.deepEqual(metadataOrder(cwd), before);
  // And the stack a fresh read reports, which is what the view renders from.
  assert.deepEqual(readStackFrom(cwd).branches.map((b) => b.name), before);
  assert.equal(runner.active, false);
});

test('resolving a conflict and continuing finishes the plan', async (t) => {
  const cwd = makeRepo({ sharedFile: true });
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const stack = readStackFrom(cwd);
  const next = ['feat/ui', 'feat/auth', 'feat/api'];
  const { runner, states } = collect();
  await runner.start(cwd, 'gh', stack, computePlan(stack, next), next, 'local');
  assert.equal(states.at(-1)!.phase, 'conflict');

  // Continuing with the conflict still unresolved must not push the plan
  // forward on a half-rebased tree.
  await runner.resume();
  assert.equal(states.at(-1)!.phase, 'conflict');
  assert.match(states.at(-1)!.message!, /Still unresolved/);

  // Resolve the way a user would, then continue for real.
  while (true) {
    const unmerged = git(cwd, 'diff', '--name-only', '--diff-filter=U');
    if (!unmerged) break;
    writeFileSync(join(cwd, 'shared.txt'), 'resolved\n');
    git(cwd, 'add', 'shared.txt');
    await runner.resume();
    if (states.at(-1)!.phase !== 'conflict') break;
  }

  const final = states.at(-1)!;
  assert.equal(final.phase, 'done');
  assert.equal(final.localComplete, true);
  assert.deepEqual(metadataOrder(cwd), next);
  assert.equal(git(cwd, 'status', '--porcelain'), '');
});

// Staging happens outside Restack — in the merge editor, the SCM view, or a
// terminal. Without this the panel shows one stale snapshot and Continue can
// only be tried and rejected.
test('refreshConflict tracks staging without advancing the plan', async (t) => {
  const cwd = makeRepo({ sharedFile: true });
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const stack = readStackFrom(cwd);
  const next = ['feat/ui', 'feat/auth', 'feat/api'];
  const { runner, states } = collect();
  await runner.start(cwd, 'gh', stack, computePlan(stack, next), next, 'local');

  const paused = states.at(-1)!;
  assert.equal(paused.phase, 'conflict');
  assert.deepEqual(paused.conflictFiles, ['shared.txt']);
  assert.deepEqual(paused.unresolvedFiles, ['shared.txt']);
  const cursor = paused.stepIndex;

  // An index event with nothing actually staged must not move anything.
  await runner.refreshConflict();
  assert.deepEqual(states.at(-1)!.unresolvedFiles, ['shared.txt']);
  assert.equal(states.at(-1)!.stepIndex, cursor);

  // Resolve and stage the way the merge editor's "Complete Merge" does.
  writeFileSync(join(cwd, 'shared.txt'), 'resolved\n');
  git(cwd, 'add', 'shared.txt');
  await runner.refreshConflict();

  const tracked = states.at(-1)!;
  assert.equal(tracked.phase, 'conflict', 'still paused — refresh does not continue the rebase');
  assert.equal(tracked.stepIndex, cursor);
  assert.deepEqual(tracked.unresolvedFiles, []);
  // The resolved file stays listed, or the record of resolving it is lost.
  assert.deepEqual(tracked.conflictFiles, ['shared.txt']);
  assert.match(tracked.message!, /resolved/);

  // And Continue, now that the UI would enable it, actually proceeds. Every
  // branch here rewrites the same line, so the cascade walks into the next
  // conflict rather than finishing — what matters is that it moved at all,
  // and that it was not refused.
  await runner.resume();
  const after = states.at(-1)!;
  assert.doesNotMatch(after.message ?? '', /Still unresolved/);
  assert.ok(
    after.phase !== 'conflict' || after.stepIndex > cursor,
    'resume should advance the plan once everything is staged',
  );
});

test('refreshConflict is inert outside a paused conflict', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const idle = collect();
  // No session at all: the watcher can outlive one by a debounce interval.
  await idle.runner.refreshConflict();
  assert.deepEqual(idle.states, []);

  const stack = readStackFrom(cwd);
  const next = ['feat/api', 'feat/ui', 'feat/auth'];
  const { runner, states } = collect();
  await runner.start(cwd, 'gh', stack, computePlan(stack, next), next, 'local');
  assert.equal(states.at(-1)!.phase, 'done');

  // A finished session still holds its snapshot for Undo, and the index moves
  // constantly. Nothing here should re-open a conflict that is over.
  const count = states.length;
  await runner.refreshConflict();
  assert.equal(states.length, count);
});

test('an unchanged order produces no steps to run', () => {
  const cwd = makeRepo();
  try {
    const plan = computePlan(readStackFrom(cwd), ORDER);
    assert.equal(plan.isNoop, true);
    assert.equal(plan.steps.length, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('inserting a branch mid-stack rewrites refs and metadata together', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const spike = addLooseBranch(cwd, 'spike', 'spike.txt');
  const stack = readStackFrom(cwd);
  const next = ['feat/auth', 'spike', 'feat/api', 'feat/ui'];
  const plan = computePlan(stack, next, [spike]);

  assert.equal(await preflight(cwd, stack, 'local', next), undefined);

  const { runner, states } = collect();
  await runner.start(cwd, 'gh', stack, plan, next, 'local');

  assert.equal(states.at(-1)!.phase, 'done');

  // One commit per branch, cumulative bottom-to-top. The failure this guards
  // against is a branch absorbing the commit below it — the same absorption
  // bug recorded SHAs exist to prevent, now across an inserted branch.
  assert.deepEqual(commitsOn(cwd, 'feat/auth'), ['feat: add auth layer']);
  assert.deepEqual(commitsOn(cwd, 'spike'), ['feat: add spike', 'feat: add auth layer']);
  assert.deepEqual(commitsOn(cwd, 'feat/api'), [
    'feat: add api routes',
    'feat: add spike',
    'feat: add auth layer',
  ]);
  assert.deepEqual(commitsOn(cwd, 'feat/ui'), [
    'feat: add ui components',
    'feat: add api routes',
    'feat: add spike',
    'feat: add auth layer',
  ]);

  // The metadata write had to find the stack by its OLD three-name set while
  // writing four; that is what MetadataUpdate.match exists for.
  assert.deepEqual(metadataOrder(cwd), next);
  const meta = JSON.parse(readFileSync(join(cwd, '.git', 'gh-stack'), 'utf8'));
  assert.equal(meta.stacks[0].branches[1].base, git(cwd, 'rev-parse', 'feat/auth'));
  assert.equal(meta.stacks[0].branches[2].base, git(cwd, 'rev-parse', 'spike'));
});

test('removing a branch replays it onto trunk and keeps its commits', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const stack = readStackFrom(cwd);
  const next = ['feat/auth', 'feat/ui'];
  const plan = computePlan(stack, next);
  assert.deepEqual(plan.removedBranches, ['feat/api']);

  const { runner, states } = collect();
  await runner.start(cwd, 'gh', stack, plan, next, 'local');
  assert.equal(states.at(-1)!.phase, 'done');

  // Un-stacked, not deleted: it sits directly on trunk with its own commit.
  assert.deepEqual(commitsOn(cwd, 'feat/api'), ['feat: add api routes']);
  assert.equal(git(cwd, 'rev-parse', 'feat/api^'), git(cwd, 'rev-parse', 'main'));

  // The survivors close the gap — ui no longer carries api's commit.
  assert.deepEqual(commitsOn(cwd, 'feat/ui'), [
    'feat: add ui components',
    'feat: add auth layer',
  ]);

  assert.deepEqual(metadataOrder(cwd), next);
});

test('undo after an insert restores the inserted branch too', async (t) => {
  const cwd = makeRepo({ sharedFile: true });
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  // Shares the conflicting file, so the apply pauses partway and undo has real
  // work to do.
  const spike = addLooseBranch(cwd, 'spike', 'shared.txt');

  const before = {
    auth: git(cwd, 'rev-parse', 'feat/auth'),
    api: git(cwd, 'rev-parse', 'feat/api'),
    ui: git(cwd, 'rev-parse', 'feat/ui'),
    spike: git(cwd, 'rev-parse', 'spike'),
    metadata: readFileSync(join(cwd, '.git', 'gh-stack'), 'utf8'),
    head: git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD'),
  };

  const stack = readStackFrom(cwd);
  const next = ['spike', 'feat/auth', 'feat/api', 'feat/ui'];
  const { runner } = collect();
  await runner.start(cwd, 'gh', stack, computePlan(stack, next, [spike]), next, 'local');

  await runner.abort();

  // spike is absent from stack.branches, so only the union snapshot could have
  // brought it back. Without it, undo would silently leave it rewritten.
  assert.equal(git(cwd, 'rev-parse', 'spike'), before.spike);
  assert.equal(git(cwd, 'rev-parse', 'feat/auth'), before.auth);
  assert.equal(git(cwd, 'rev-parse', 'feat/api'), before.api);
  assert.equal(git(cwd, 'rev-parse', 'feat/ui'), before.ui);
  assert.equal(readFileSync(join(cwd, '.git', 'gh-stack'), 'utf8'), before.metadata);
  assert.equal(git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), before.head);
  assert.equal(git(cwd, 'status', '--porcelain'), '');
});
