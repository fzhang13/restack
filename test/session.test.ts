import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ApplyRunner } from '../src/apply.ts';
import { computePlan } from '../src/plan.ts';
import type { ApplyProgress } from '../src/model.ts';
import type { PersistedSession } from '../src/apply.ts';
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

  runner.dismiss();
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
