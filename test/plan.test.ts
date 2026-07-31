import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseStack } from '../src/parse.ts';
import { computePlan } from '../src/plan.ts';
import type { CandidateBranch } from '../src/model.ts';

/** Captured from a real `gh stack view --json` run (gh-stack v0.1.0). */
const fixture = readFileSync(new URL('../fixtures/stack-no-prs.json', import.meta.url), 'utf8');

test('parses the real gh-stack v0.1.0 payload', () => {
  const stack = parseStack(fixture);
  assert.equal(stack.trunk, 'main');
  assert.equal(stack.currentBranch, 'feat/ui');
  assert.deepEqual(
    stack.branches.map((b) => b.name),
    ['feat/auth', 'feat/api', 'feat/ui'],
  );
  // base is a resolved SHA, not a ref name.
  assert.match(stack.branches[0].base, /^[0-9a-f]{40}$/);
  assert.equal(stack.branches[2].isCurrent, true);
});

test('accepts a {stacks:[...]} envelope', () => {
  const wrapped = JSON.stringify({ stacks: [JSON.parse(fixture)] });
  assert.deepEqual(
    parseStack(wrapped).branches.map((b) => b.name),
    ['feat/auth', 'feat/api', 'feat/ui'],
  );
});

test('tolerates unknown/missing fields but keeps named branches', () => {
  const stack = parseStack(JSON.stringify({ trunk: 'develop', branches: [{ name: 'solo' }, {}] }));
  assert.equal(stack.branches.length, 1);
  assert.equal(stack.branches[0].name, 'solo');
  assert.equal(stack.branches[0].base, '');
  assert.equal(stack.branches[0].needsRebase, false);
});

test('rejects payloads with no branch list', () => {
  assert.throws(() => parseStack('{"trunk":"main"}'), /No branches/);
  assert.throws(() => parseStack('not json'), /valid JSON/);
});

test('unchanged order is a no-op with no steps', () => {
  const stack = parseStack(fixture);
  const plan = computePlan(stack, ['feat/auth', 'feat/api', 'feat/ui']);
  assert.equal(plan.isNoop, true);
  assert.equal(plan.steps.length, 0);
});

test('swapping the top two branches rebases both, using recorded SHAs', () => {
  const stack = parseStack(fixture);
  const [auth, api, ui] = stack.branches;

  // Proposed: auth -> ui -> api  (ui and api swap)
  const plan = computePlan(stack, ['feat/auth', 'feat/ui', 'feat/api']);
  assert.equal(plan.isNoop, false);

  const rebases = plan.steps.filter((s) => s.kind === 'rebase');
  assert.deepEqual(rebases.map((s) => s.branch), ['feat/ui', 'feat/api']);

  // feat/ui moves down onto auth, replaying commits after ITS OWN old base.
  assert.equal(rebases[0].command, `git rebase --onto feat/auth ${ui.base} feat/ui`);
  // feat/api moves up onto ui, still anchored to its own recorded base SHA —
  // not to the rewritten feat/ui ref.
  assert.equal(rebases[1].command, `git rebase --onto feat/ui ${api.base} feat/api`);

  // Anchors are distinct and are the pre-rebase SHAs.
  assert.notEqual(ui.base, api.base);
  assert.equal(auth.base.length, 40);
});

test('moving the bottom branch to the top replays the whole stack', () => {
  const stack = parseStack(fixture);
  const [auth, api, ui] = stack.branches;
  const plan = computePlan(stack, ['feat/api', 'feat/ui', 'feat/auth']);
  const rebases = plan.steps.filter((s) => s.kind === 'rebase');
  assert.deepEqual(rebases.map((s) => s.branch), ['feat/api', 'feat/ui', 'feat/auth']);

  // Verified against a real repo: executing exactly these three commands
  // yields api / api+ui / api+ui+auth, one commit per branch.
  //
  // The name-based variant of this same reorder is what breaks. Running
  // `git rebase --onto feat/api feat/api feat/ui` for step 2 replays the
  // wrong range and leaves feat/ui carrying auth's commit as well. Anchoring
  // to each branch's own recorded pre-rebase SHA is what prevents that.
  assert.equal(rebases[0].command, `git rebase --onto main ${api.base} feat/api`);
  assert.equal(rebases[1].command, `git rebase --onto feat/api ${ui.base} feat/ui`);
  assert.equal(rebases[2].command, `git rebase --onto feat/ui ${auth.base} feat/auth`);

  // Every anchor is a distinct pre-rebase SHA, never a ref name.
  const anchors = rebases.map((s) => s.command.split(' ')[4]);
  assert.equal(new Set(anchors).size, 3);
  anchors.forEach((a) => assert.match(a, /^[0-9a-f]{40}$/));
});

test('plan ends with metadata, push, then submit', () => {
  const stack = parseStack(fixture);
  const plan = computePlan(stack, ['feat/auth', 'feat/ui', 'feat/api']);
  const kinds = plan.steps.map((s) => s.kind);
  assert.deepEqual(kinds.slice(-3), ['metadata', 'push', 'submit']);

  // `gh stack push` does per-branch --force-with-lease itself and skips merged
  // and queued branches — rules a hand-rolled `git push` would have to
  // reproduce and would drift from.
  assert.equal(plan.steps.at(-2)!.command, 'gh stack push');
  // --auto is required: the interactive editor cannot run from a webview.
  assert.equal(plan.steps.at(-1)!.command, 'gh stack submit --auto');

  // Push must follow the metadata write: gh-stack reads its branch list from
  // that file, so pushing first would push the pre-reorder set.
  const metadata = kinds.indexOf('metadata');
  assert.ok(metadata < kinds.indexOf('push'));
});

test('the metadata step is a shell comment, so copied plans stay pasteable', () => {
  const stack = parseStack(fixture);
  const plan = computePlan(stack, ['feat/auth', 'feat/ui', 'feat/api']);
  const step = plan.steps.find((s) => s.kind === 'metadata')!;

  assert.match(step.command, /^#/);
  // No exec: Restack writes this file itself, gh-stack exposes no command for it.
  assert.equal(step.exec, undefined);
  // It must land after every rebase — the bases it records are post-rebase tips.
  const lastRebase = plan.steps.map((s) => s.kind).lastIndexOf('rebase');
  assert.ok(plan.steps.indexOf(step) > lastRebase);
});

test('every executable step carries argv matching its displayed command', () => {
  const stack = parseStack(fixture);
  const plan = computePlan(stack, ['feat/api', 'feat/ui', 'feat/auth']);

  for (const step of plan.steps) {
    if (!step.exec) {
      continue;
    }
    // Display is derived from argv, so a drift here means apply would run
    // something other than what the panel showed.
    assert.equal(step.command, `${step.exec.file} ${step.exec.args.join(' ')}`);
  }

  assert.ok(plan.steps.filter((s) => s.exec).length >= 4);
});

test('reports merged branches so the UI can refuse to reorder them', () => {
  const stack = parseStack(fixture);
  stack.branches[0].isMerged = true;
  const plan = computePlan(stack, ['feat/auth', 'feat/ui', 'feat/api']);
  assert.deepEqual(plan.mergedBranches, ['feat/auth']);
});

/** A branch outside the stack, as candidates.ts would report it. */
const SPIKE: CandidateBranch = {
  name: 'spike',
  base: 'f'.repeat(40),
  commitCount: 2,
};

test('inserting a branch anchors it to its merge-base with trunk', () => {
  const stack = parseStack(fixture);
  const [auth, api, ui] = stack.branches;

  // spike slots between auth and api.
  const plan = computePlan(stack, ['feat/auth', 'spike', 'feat/api', 'feat/ui'], [SPIKE]);

  assert.equal(plan.isNoop, false);
  assert.deepEqual(plan.insertedBranches, ['spike']);
  assert.deepEqual(plan.removedBranches, []);

  const rebases = plan.steps.filter((s) => s.kind === 'rebase');
  // auth is untouched: it still sits on trunk with nothing moved beneath it.
  assert.deepEqual(rebases.map((s) => s.branch), ['spike', 'feat/api', 'feat/ui']);

  // The candidate's merge-base stands in for a gh-stack recorded base, and is
  // used exactly the same way — as the upstream anchor.
  assert.equal(rebases[0].command, `git rebase --onto feat/auth ${SPIKE.base} spike`);
  // Everything above the insertion replays from its OWN recorded SHA, not from
  // the rewritten ref below it.
  assert.equal(rebases[1].command, `git rebase --onto spike ${api.base} feat/api`);
  assert.equal(rebases[2].command, `git rebase --onto feat/api ${ui.base} feat/ui`);
  assert.notEqual(auth.base, api.base);
});

test('inserting at the bottom rebases the new branch onto trunk', () => {
  const stack = parseStack(fixture);
  const plan = computePlan(stack, ['spike', 'feat/auth', 'feat/api', 'feat/ui'], [SPIKE]);
  const rebases = plan.steps.filter((s) => s.kind === 'rebase');

  assert.equal(rebases[0].command, `git rebase --onto main ${SPIKE.base} spike`);
  // The whole stack sits on spike now, so every branch replays.
  assert.deepEqual(rebases.map((s) => s.branch), ['spike', 'feat/auth', 'feat/api', 'feat/ui']);
});

test('removing a branch replays it onto trunk and closes the gap', () => {
  const stack = parseStack(fixture);
  const [auth, api, ui] = stack.branches;

  // feat/api leaves; auth and ui stay in order.
  const plan = computePlan(stack, ['feat/auth', 'feat/ui']);

  assert.equal(plan.isNoop, false);
  assert.deepEqual(plan.removedBranches, ['feat/api']);
  assert.deepEqual(plan.insertedBranches, []);

  const rebases = plan.steps.filter((s) => s.kind === 'rebase');
  // The removal comes first, so the cascade runs against a stack already
  // missing the departing branch.
  assert.equal(rebases[0].command, `git rebase --onto main ${api.base} feat/api`);
  // feat/ui closes the gap onto auth. Its anchor is still its own recorded SHA.
  assert.equal(rebases.at(-1)!.command, `git rebase --onto feat/auth ${ui.base} feat/ui`);
  // Its commits are kept, not dropped — that has to be legible in the UI.
  assert.match(rebases[0].note!, /commits are kept/i);
  assert.equal(auth.base.length, 40);
});

test('a branch above a removal replays even though its parent name is unchanged', () => {
  const stack = parseStack(fixture);
  // Drop the top branch. auth and api keep both their order and their parents.
  const plan = computePlan(stack, ['feat/auth', 'feat/api']);
  const rebases = plan.steps.filter((s) => s.kind === 'rebase');

  // Only the departing branch needs rewriting here; the survivors are already
  // sitting exactly where the proposed order puts them.
  assert.deepEqual(rebases.map((s) => s.branch), ['feat/ui']);
  assert.deepEqual(plan.removedBranches, ['feat/ui']);
});

test('membership changes count as changes even when the shared order matches', () => {
  const stack = parseStack(fixture);
  const same = ['feat/auth', 'feat/api', 'feat/ui'];

  assert.equal(computePlan(stack, same).isNoop, true);
  // Appending or dropping a branch is a real change, though every branch the
  // two orders share is still in the same relative position.
  assert.equal(computePlan(stack, [...same, 'spike'], [SPIKE]).isNoop, false);
  assert.equal(computePlan(stack, same.slice(0, 2)).isNoop, false);
});

test('a branch with no known base is skipped rather than rebased blindly', () => {
  const stack = parseStack(fixture);
  // 'ghost' is in neither the stack nor the candidate list, so there is no
  // recorded SHA to anchor it — emitting a rebase would guess at the range.
  const plan = computePlan(stack, ['feat/auth', 'ghost', 'feat/api', 'feat/ui']);
  const rebases = plan.steps.filter((s) => s.kind === 'rebase');

  assert.ok(!rebases.some((s) => s.branch === 'ghost'));
  assert.deepEqual(plan.insertedBranches, ['ghost']);
});
