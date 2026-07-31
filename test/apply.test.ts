import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApplyRunner, hasOrigin, preflight } from '../src/apply.ts';
import { changeBasePlan, computePlan, syncPlan } from '../src/plan.ts';
import type { ApplyProgress, CandidateBranch, Stack } from '../src/model.ts';
import type { PersistedSession } from '../src/apply.ts';

/**
 * These run against real repositories on disk. The whole point of apply.ts is
 * what git actually does with a mid-stack rebase, and a mocked git would only
 * ever confirm what we already believed.
 */

const ORDER = ['feat/auth', 'feat/api', 'feat/ui'];

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

/**
 * A three-branch stack on main, with the `.git/gh-stack` file gh-stack would
 * have written. `sharedFile` puts every branch on the same file so their
 * commits collide when reordered.
 */
function makeRepo(options: { sharedFile?: boolean } = {}): string {
  const cwd = mkdtempSync(join(tmpdir(), 'restack-'));
  git(cwd, 'init', '-b', 'main');
  git(cwd, 'config', 'user.email', 'test@example.com');
  git(cwd, 'config', 'user.name', 'Restack Test');
  git(cwd, 'config', 'commit.gpgsign', 'false');

  commit(cwd, 'README.md', 'base\n', 'init');
  const trunkHead = git(cwd, 'rev-parse', 'HEAD');

  const target = (n: string) => (options.sharedFile ? 'shared.txt' : `${n}.txt`);

  git(cwd, 'checkout', '-b', 'feat/auth');
  commit(cwd, target('auth'), 'auth\n', 'feat: add auth layer');
  const authTip = git(cwd, 'rev-parse', 'HEAD');

  git(cwd, 'checkout', '-b', 'feat/api');
  commit(cwd, target('api'), 'api\n', 'feat: add api routes');
  const apiTip = git(cwd, 'rev-parse', 'HEAD');

  git(cwd, 'checkout', '-b', 'feat/ui');
  commit(cwd, target('ui'), 'ui\n', 'feat: add ui components');

  writeFileSync(
    join(cwd, '.git', 'gh-stack'),
    JSON.stringify(
      {
        schemaVersion: 1,
        repository: '',
        stacks: [
          {
            trunk: { branch: 'main', head: trunkHead },
            branches: [
              { branch: 'feat/auth', base: trunkHead },
              { branch: 'feat/api', base: authTip },
              { branch: 'feat/ui', base: apiTip },
            ],
          },
        ],
      },
      null,
      2,
    ),
  );

  git(cwd, 'checkout', 'feat/ui');
  return cwd;
}

/** The Stack shape `gh stack view --json` would produce for makeRepo(). */
function readStackFrom(cwd: string): Stack {
  const meta = JSON.parse(readFileSync(join(cwd, '.git', 'gh-stack'), 'utf8'));
  const entries = meta.stacks[0].branches as Array<{ branch: string; base: string }>;
  return {
    trunk: 'main',
    currentBranch: git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD'),
    branches: entries.map((e) => ({
      name: e.branch,
      base: e.base,
      isCurrent: false,
      isMerged: false,
      isQueued: false,
      needsRebase: false,
    })),
  };
}

function metadataOrder(cwd: string): string[] {
  const meta = JSON.parse(readFileSync(join(cwd, '.git', 'gh-stack'), 'utf8'));
  return meta.stacks[0].branches.map((b: { branch: string }) => b.branch);
}

/** Commits unique to `branch`, oldest last, as `git log --oneline main..branch`. */
function commitsOn(cwd: string, branch: string): string[] {
  const out = git(cwd, 'log', '--format=%s', `main..${branch}`);
  return out ? out.split('\n') : [];
}

function collect(): { runner: ApplyRunner; states: ApplyProgress[] } {
  const states: ApplyProgress[] = [];
  return { runner: new ApplyRunner((p) => states.push(p)), states };
}

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

// A webview rebuilt mid-apply asks the host what is going on. If the host
// cannot answer, ApplyPanel never renders, Dismiss is unreachable, and the
// session wedges every later Apply as "already in progress".
test('a paused session can be replayed to a reconnecting webview', async (t) => {
  const cwd = makeRepo({ sharedFile: true });
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const stack = readStackFrom(cwd);
  const next = ['feat/ui', 'feat/auth', 'feat/api'];
  const plan = computePlan(stack, next);

  const { runner, states } = collect();
  await runner.start(cwd, 'gh', stack, plan, next, 'local');

  assert.equal(runner.active, true);
  assert.deepEqual(runner.current, states.at(-1));
  assert.equal(runner.current?.phase, 'conflict');
  assert.deepEqual(runner.currentPlan, plan);

  runner.dismiss();
  assert.equal(runner.active, false);
  assert.equal(runner.current, undefined);
  assert.equal(runner.currentPlan, undefined);
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

test('preflight refuses a dirty tree', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  writeFileSync(join(cwd, 'README.md'), 'uncommitted edit\n');
  const blocked = await preflight(cwd, readStackFrom(cwd), 'local');
  // Rebasing over uncommitted work can destroy changes no snapshot holds.
  assert.match(blocked ?? '', /uncommitted changes/);
});

test('preflight refuses a merged branch and a missing remote', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const stack = readStackFrom(cwd);
  assert.match((await preflight(cwd, stack, 'publish')) ?? '', /No `origin` remote/);

  stack.branches[0].isMerged = true;
  assert.match((await preflight(cwd, stack, 'local')) ?? '', /merged branches/);
});

// The UI hides "Apply & Publish" on this answer, so a false negative would
// strand a user with a real remote on local-only applies.
test('hasOrigin distinguishes a remote-less repo from one with origin', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  assert.equal(await hasOrigin(cwd), false);

  execFileSync('git', ['remote', 'add', 'origin', 'https://example.invalid/x.git'], { cwd });
  assert.equal(await hasOrigin(cwd), true);
});

test('preflight refuses when gh-stack metadata is absent', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const stack = readStackFrom(cwd);
  rmSync(join(cwd, '.git', 'gh-stack'));

  // Without it, rebasing would leave the stack describing an order the refs
  // no longer have, and nothing could put that right.
  const blocked = await preflight(cwd, stack, 'local');
  assert.match(blocked ?? '', /No \.git\/gh-stack/);
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

/** Branch off trunk with one commit, as a tray candidate would be. */
function addLooseBranch(cwd: string, name: string, file: string): CandidateBranch {
  const head = git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD');
  git(cwd, 'checkout', 'main');
  git(cwd, 'checkout', '-b', name);
  commit(cwd, file, `${name}\n`, `feat: add ${name}`);
  git(cwd, 'checkout', head);
  return {
    name,
    base: git(cwd, 'merge-base', name, 'main'),
    commitCount: 1,
  };
}

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

test('preflight refuses a branch that does not exist or is unrelated', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const stack = readStackFrom(cwd);

  // A missing ref would otherwise fail mid-cascade, after earlier branches
  // had already been rewritten.
  assert.match(
    (await preflight(cwd, stack, 'local', [...ORDER, 'ghost'])) ?? '',
    /ghost does not exist locally/,
  );

  // An orphan shares no history with trunk, so there is nothing to replay.
  git(cwd, 'checkout', '--orphan', 'orphan');
  git(cwd, 'rm', '-rf', '--cached', '.');
  commit(cwd, 'orphan.txt', 'orphan\n', 'orphan root');
  // `rm --cached` left the stack's files untracked, which would block the way
  // back out of the orphan branch.
  git(cwd, 'clean', '-fd');
  git(cwd, 'checkout', 'feat/ui');
  assert.match(
    (await preflight(cwd, stack, 'local', [...ORDER, 'orphan'])) ?? '',
    /shares no history/,
  );
});

// A window reload throws away the extension host. Without persistence the
// repository is left mid-plan with the snapshot — and so Undo — gone.
test('a session is persisted and can be restored after a reload', async (t) => {
  const cwd = makeRepo({ sharedFile: true });
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const before = {
    auth: git(cwd, 'rev-parse', 'feat/auth'),
    api: git(cwd, 'rev-parse', 'feat/api'),
    ui: git(cwd, 'rev-parse', 'feat/ui'),
    metadata: readFileSync(join(cwd, '.git', 'gh-stack'), 'utf8'),
  };

  const stack = readStackFrom(cwd);
  const next = ['feat/ui', 'feat/auth', 'feat/api'];

  let saved: PersistedSession | undefined;
  const first = new ApplyRunner(() => {}, { persist: (s) => { saved = s; } });
  await first.start(cwd, 'gh', stack, computePlan(stack, next), next, 'local');
  assert.equal(first.current?.phase, 'conflict');

  // Survives a JSON round trip, as workspaceState would impose.
  const wire = JSON.parse(JSON.stringify(saved)) as PersistedSession;
  assert.equal(wire.cwd, cwd);
  assert.equal(wire.refs.length, 3);

  // The host is gone; a fresh one adopts the session.
  const states: ApplyProgress[] = [];
  const second = new ApplyRunner((p) => states.push(p));
  second.restore(wire);

  assert.equal(second.active, true);
  assert.equal(second.current?.phase, 'conflict');
  assert.deepEqual(second.currentPlan?.proposedOrder, next);

  // And Undo still reaches the pre-apply state through the restored snapshot.
  await second.abort();
  assert.equal(git(cwd, 'rev-parse', 'feat/auth'), before.auth);
  assert.equal(git(cwd, 'rev-parse', 'feat/api'), before.api);
  assert.equal(git(cwd, 'rev-parse', 'feat/ui'), before.ui);
  assert.equal(readFileSync(join(cwd, '.git', 'gh-stack'), 'utf8'), before.metadata);
});

test('persistence is cleared when the session ends', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const stack = readStackFrom(cwd);
  const next = ['feat/api', 'feat/ui', 'feat/auth'];

  let saved: PersistedSession | undefined;
  const runner = new ApplyRunner(() => {}, { persist: (s) => { saved = s; } });
  await runner.start(cwd, 'gh', stack, computePlan(stack, next), next, 'local');
  assert.ok(saved, 'a finished-but-undoable session stays persisted');

  runner.dismiss();
  // Otherwise the next window would restore a session that is already over and
  // reject every later apply as "already in progress".
  assert.equal(saved, undefined);
});

test('publishOnly runs push and submit with no reorder and no undo', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const { runner, states } = collect();
  // `gh` is not resolvable here, so the push step fails — which is the point:
  // it proves the two steps ran standalone, with no plan behind them.
  await runner.publishOnly(cwd, 'gh-does-not-exist', readStackFrom(cwd));

  const final = states.at(-1)!;
  assert.deepEqual(runner.currentPlan?.steps.map((s) => s.command) ?? [], [
    'gh stack push',
    'gh stack submit --auto',
  ]);
  assert.equal(final.phase, 'failed');
  // Nothing local was rewritten, so there is nothing to roll back.
  assert.equal(final.canUndo, false);
  assert.equal(final.localComplete, true);
});

test('aborting a publish-only session touches nothing', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const before = readFileSync(join(cwd, '.git', 'gh-stack'), 'utf8');
  const uiBefore = git(cwd, 'rev-parse', 'feat/ui');
  const { runner, states } = collect();
  await runner.publishOnly(cwd, 'gh-does-not-exist', readStackFrom(cwd));

  // Its snapshot is empty and its metadataPath is '', so a naive rollback
  // would try to write to the repository root.
  await runner.abort();

  assert.match(states.at(-1)!.message ?? '', /Nothing to roll back/);
  assert.equal(readFileSync(join(cwd, '.git', 'gh-stack'), 'utf8'), before);
  assert.equal(git(cwd, 'rev-parse', 'feat/ui'), uiBefore);
  assert.equal(runner.active, false);
});

/**
 * The state `gh stack init` leaves behind when it adopts existing branches:
 * they are recorded in stack order, each based on trunk, but never rebased
 * onto each other. Verified against gh-stack v0.1.0, which reports the upper
 * branches as `needsRebase` and otherwise leaves them alone.
 */
function makeAdoptedRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'restack-adopt-'));
  git(cwd, 'init', '-b', 'main');
  git(cwd, 'config', 'user.email', 'test@example.com');
  git(cwd, 'config', 'user.name', 'Restack Test');
  git(cwd, 'config', 'commit.gpgsign', 'false');

  commit(cwd, 'README.md', 'base\n', 'init');
  const trunkHead = git(cwd, 'rev-parse', 'HEAD');

  // Every branch off trunk, in parallel — none is on the one below it.
  for (const name of ORDER) {
    git(cwd, 'checkout', 'main');
    git(cwd, 'checkout', '-b', name);
    commit(cwd, `${name.replace(/\//g, '-')}.txt`, `${name}\n`, `feat: ${name}`);
  }

  writeFileSync(
    join(cwd, '.git', 'gh-stack'),
    JSON.stringify(
      {
        schemaVersion: 1,
        repository: '',
        stacks: [
          {
            trunk: { branch: 'main', head: trunkHead },
            branches: ORDER.map((branch) => ({ branch, base: trunkHead })),
          },
        ],
      },
      null,
      2,
    ),
  );

  git(cwd, 'checkout', ORDER.at(-1)!);
  return cwd;
}

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

/**
 * The same stack, plus a bare origin every branch tracks.
 *
 * Returns both paths: the tests below simulate a colleague by committing
 * directly into a second clone and pushing, which is the only way to produce
 * the state that matters — a remote-tracking ref we are behind.
 */
function makeRemoteRepo(): { cwd: string; origin: string } {
  const cwd = makeRepo();
  const origin = mkdtempSync(join(tmpdir(), 'restack-origin-'));
  git(origin, 'init', '--bare', '-b', 'main');

  git(cwd, 'remote', 'add', 'origin', origin);
  git(cwd, 'push', '-u', 'origin', 'main', ...ORDER);
  return { cwd, origin };
}

/** A second clone, standing in for whoever else pushes to these branches. */
function colleague(origin: string): string {
  const cwd = mkdtempSync(join(tmpdir(), 'restack-them-'));
  git(cwd, 'clone', origin, cwd);
  git(cwd, 'config', 'user.email', 'them@example.com');
  git(cwd, 'config', 'user.name', 'Someone Else');
  git(cwd, 'config', 'commit.gpgsign', 'false');
  return cwd;
}

test('preflight refuses to rewrite a branch that is behind its upstream', async (t) => {
  const { cwd, origin } = makeRemoteRepo();
  const them = colleague(origin);
  t.after(() => [cwd, origin, them].forEach((d) => rmSync(d, { recursive: true, force: true })));

  // Someone else pushes to a branch in our stack.
  git(them, 'checkout', 'feat/api');
  commit(them, 'theirs.txt', 'theirs\n', 'feat: their work');
  git(them, 'push', 'origin', 'feat/api');

  // Until we fetch, nothing here knows: the remote-tracking ref is stale and
  // an apply would happily proceed.
  assert.equal(await preflight(cwd, readStackFrom(cwd), 'local'), undefined);

  git(cwd, 'fetch', 'origin');

  // Now it is refusable, and refused. `gh stack push` force-pushes with a
  // lease against that ref — once it is current, the lease is satisfied and
  // their commit is overwritten with no warning at all.
  const blocked = await preflight(cwd, readStackFrom(cwd), 'local');
  assert.match(blocked ?? '', /feat\/api is 1 behind origin\/feat\/api/);
  assert.match(blocked ?? '', /force-pushes/);
});

test('preflight allows a branch whose upstream was deleted', async (t) => {
  const { cwd, origin } = makeRemoteRepo();
  t.after(() => [cwd, origin].forEach((d) => rmSync(d, { recursive: true, force: true })));

  // The ordinary aftermath of a merged PR: the branch is gone from the remote
  // but the local upstream config remains. Refusing here would block every
  // stack that had ever landed a branch.
  git(cwd, 'push', 'origin', '--delete', 'feat/auth');
  git(cwd, 'fetch', '--prune', 'origin');

  assert.equal(await preflight(cwd, readStackFrom(cwd), 'local'), undefined);
});

test('preflight ignores branches outside the order being applied', async (t) => {
  const { cwd, origin } = makeRemoteRepo();
  const them = colleague(origin);
  t.after(() => [cwd, origin, them].forEach((d) => rmSync(d, { recursive: true, force: true })));

  // A branch that is behind but is *not* being rewritten is not a hazard —
  // only the branches this apply force-pushes matter.
  git(them, 'checkout', '-b', 'unrelated', 'main');
  commit(them, 'other.txt', 'other\n', 'chore: unrelated');
  git(them, 'push', 'origin', 'unrelated');
  git(cwd, 'fetch', 'origin');
  git(cwd, 'branch', '--track', 'unrelated', 'origin/unrelated');
  git(them, 'push', 'origin', 'HEAD:unrelated', '--force');
  commit(them, 'other.txt', 'more\n', 'chore: more');
  git(them, 'push', 'origin', 'unrelated');
  git(cwd, 'fetch', 'origin');

  assert.equal(await preflight(cwd, readStackFrom(cwd), 'local', ORDER), undefined);
  assert.match(
    (await preflight(cwd, readStackFrom(cwd), 'local', [...ORDER, 'unrelated'])) ?? '',
    /unrelated is 1 behind origin\/unrelated/,
  );
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
