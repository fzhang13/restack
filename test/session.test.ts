import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApplyRunner } from '../src/apply.ts';
import { computePlan } from '../src/plan.ts';
import type { ApplyProgress } from '../src/model.ts';
import type { PersistedSession } from '../src/apply.ts';
import { stashPush, stashRestore } from '../src/stash.ts';
import { collect, git, makeRepo, readStackFrom } from './support/repo.ts';

/**
 * The apply session as a thing with a lifetime: replayed to a reconnecting
 * webview, persisted across a window reload, cleared when it ends, and the
 * publish-only variant that has no local half to undo.
 */

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

  await runner.dismiss();
  assert.equal(runner.active, false);
  assert.equal(runner.current, undefined);
  assert.equal(runner.currentPlan, undefined);
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

  await runner.dismiss();
  // Otherwise the next window would restore a session that is already over and
  // reject every later apply as "already in progress".
  assert.equal(saved, undefined);
});

test('publishOnly runs push, submit, and link with no reorder and no undo', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const { runner, states } = collect();
  // `gh` is not resolvable here, so the push step fails — which is the point:
  // it proves the steps ran standalone, with no plan behind them.
  await runner.publishOnly(cwd, 'gh-does-not-exist', readStackFrom(cwd));

  const final = states.at(-1)!;
  // The standalone action links too. Without it the button opens the pull
  // requests and leaves them unconnected on GitHub, which is the whole bug.
  assert.deepEqual(runner.currentPlan?.steps.map((s) => s.command) ?? [], [
    'gh stack push',
    'gh stack submit --auto',
    'gh stack link --base main feat/auth feat/api feat/ui',
  ]);
  assert.equal(final.phase, 'failed');
  // Nothing local was rewritten, so there is nothing to roll back.
  assert.equal(final.canUndo, false);
  assert.equal(final.localComplete, true);
});

// The panel renders Roll back from `phase: 'failed'` plus `canUndo`, and abort
// emits exactly that pair on its way out. Left true, it offers the button a
// second time for a session it has just cleared, and the click comes back
// "No apply in progress." — a failure notice for a rollback that worked.
test('a completed rollback stops offering to roll back', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const stack = readStackFrom(cwd);
  const next = ['feat/api', 'feat/ui', 'feat/auth'];

  const { runner, states } = collect();
  await runner.start(cwd, 'gh', stack, computePlan(stack, next), next, 'local');
  assert.equal(states.at(-1)!.canUndo, true, 'undoable while the session is live');

  await runner.abort();

  const final = states.at(-1)!;
  assert.match(final.message ?? '', /Rolled back/);
  assert.equal(final.canUndo, false);
  assert.equal(runner.active, false);
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
 * The stash an apply is handed, as a thing with the same lifetime as the
 * session that owns it. The hazard these pin down is ordering: a stash popped
 * while the panel is still offering Roll back would be sitting in the working
 * tree when abort() reaches its snapshot through `git checkout --force`.
 */
function stashingRunner(): {
  runner: ApplyRunner;
  states: ApplyProgress[];
  restored: string[];
  reported: string[];
} {
  const states: ApplyProgress[] = [];
  const restored: string[] = [];
  const reported: string[] = [];
  const runner = new ApplyRunner((p) => states.push(p), {
    restoreStash: async (cwd, sha) => {
      restored.push(sha);
      await stashRestore(cwd, sha);
    },
    reportStash: async (_cwd, sha) => {
      reported.push(sha);
    },
  });
  return { runner, states, restored, reported };
}

async function stashDirty(cwd: string): Promise<string> {
  writeFileSync(join(cwd, 'README.md'), 'uncommitted\n');
  const pushed = await stashPush(cwd, 'restack: test apply');
  assert.equal(pushed.kind, 'stashed');
  return pushed.kind === 'stashed' ? pushed.sha : '';
}

test('a stash is held, not popped, while a finished apply can still be rolled back', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const stack = readStackFrom(cwd);
  const next = ['feat/api', 'feat/ui', 'feat/auth'];
  const sha = await stashDirty(cwd);

  const { runner, states, restored } = stashingRunner();
  await runner.start(cwd, 'gh', stack, computePlan(stack, next), next, 'local', sha);

  // Roll back is still on offer, and it gets there via `git checkout --force`.
  // Anything popped now would be destroyed by pressing it.
  assert.deepEqual(restored, []);
  assert.equal(readFileSync(join(cwd, 'README.md'), 'utf8'), 'base\n');
  assert.match(states.at(-1)!.message ?? '', /still stashed/);
});

test('dismissing a finished apply gives the stash back', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const stack = readStackFrom(cwd);
  const next = ['feat/api', 'feat/ui', 'feat/auth'];
  const sha = await stashDirty(cwd);

  const { runner, restored } = stashingRunner();
  await runner.start(cwd, 'gh', stack, computePlan(stack, next), next, 'local', sha);
  await runner.dismiss();

  assert.deepEqual(restored, [sha]);
  assert.equal(readFileSync(join(cwd, 'README.md'), 'utf8'), 'uncommitted\n');
  assert.equal(git(cwd, 'stash', 'list'), '');
});

test('rolling back gives the stash back, after the branches are restored', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const stack = readStackFrom(cwd);
  const next = ['feat/api', 'feat/ui', 'feat/auth'];
  const authBefore = git(cwd, 'rev-parse', 'feat/auth');
  const sha = await stashDirty(cwd);

  const { runner, restored } = stashingRunner();
  await runner.start(cwd, 'gh', stack, computePlan(stack, next), next, 'local', sha);
  await runner.abort();

  assert.equal(git(cwd, 'rev-parse', 'feat/auth'), authBefore);
  assert.deepEqual(restored, [sha]);
  // The pop lands after `git checkout --force`, not before it.
  assert.equal(readFileSync(join(cwd, 'README.md'), 'utf8'), 'uncommitted\n');
});

test('a stash is settled once, even when finish and abort both run', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const stack = readStackFrom(cwd);
  const next = ['feat/api', 'feat/ui', 'feat/auth'];
  const sha = await stashDirty(cwd);

  const { runner, restored } = stashingRunner();
  await runner.start(cwd, 'gh', stack, computePlan(stack, next), next, 'local', sha);
  await runner.abort();
  // The session is over, but a second settle would pop whatever now sits in
  // the slot the entry used to occupy.
  await runner.dismiss().catch(() => {});

  assert.deepEqual(restored, [sha]);
});

test('dismissing mid-conflict leaves the stash alone and says where it is', async (t) => {
  const cwd = makeRepo({ sharedFile: true });
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const stack = readStackFrom(cwd);
  const next = ['feat/ui', 'feat/auth', 'feat/api'];
  writeFileSync(join(cwd, 'README.md'), 'uncommitted\n');
  const pushed = await stashPush(cwd, 'restack: test apply');
  const sha = pushed.kind === 'stashed' ? pushed.sha : '';

  const { runner, restored, reported } = stashingRunner();
  await runner.start(cwd, 'gh', stack, computePlan(stack, next), next, 'local', sha);
  assert.equal(runner.current?.phase, 'conflict');

  await runner.dismiss();

  // A tree with unmerged paths cannot take a pop, so the entry stays and the
  // user is told where it is rather than being handed a second conflict.
  assert.deepEqual(restored, []);
  assert.deepEqual(reported, [sha]);
  assert.match(git(cwd, 'stash', 'list'), /restack: test apply/);
});

test('the stash sha survives the reload a conflict can outlast', async (t) => {
  const cwd = makeRepo({ sharedFile: true });
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const stack = readStackFrom(cwd);
  const next = ['feat/ui', 'feat/auth', 'feat/api'];
  const sha = await stashDirty(cwd);

  let saved: PersistedSession | undefined;
  const first = new ApplyRunner(() => {}, { persist: (s) => { saved = s; } });
  await first.start(cwd, 'gh', stack, computePlan(stack, next), next, 'local', sha);
  assert.equal(first.current?.phase, 'conflict');

  const wire = JSON.parse(JSON.stringify(saved)) as PersistedSession;
  assert.equal(wire.stash, sha, 'a reload mid-conflict must not orphan the stash');

  const { runner, restored } = stashingRunner();
  runner.restore(wire);
  await runner.abort();

  assert.deepEqual(restored, [sha]);
  assert.equal(readFileSync(join(cwd, 'README.md'), 'utf8'), 'uncommitted\n');
});
