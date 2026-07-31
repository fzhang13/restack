import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseStack } from '../src/parse.ts';
import { changeBasePlan, computePlan, syncPlan } from '../src/plan.ts';
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

/**
 * `gh stack init` adopts divergent branches into stack order without rebasing
 * them, so the order is already right and the branches are not actually on
 * each other. A forced plan is what closes that gap.
 */
function withDrift(drifted: string[]) {
  const stack = parseStack(fixture);
  return {
    ...stack,
    branches: stack.branches.map((b) => ({ ...b, needsRebase: drifted.includes(b.name) })),
  };
}

test('a forced plan replays drifted branches the order alone would skip', () => {
  const stack = withDrift(['feat/api']);
  const order = stack.branches.map((b) => b.name);

  // Without force this is a no-op: nothing moved.
  assert.equal(computePlan(stack, order).isNoop, true);

  const plan = computePlan(stack, order, [], { force: true });
  assert.equal(plan.isNoop, false);

  const rebases = plan.steps.filter((s) => s.kind === 'rebase');
  // feat/auth is not drifted and sits below the one that is, so it is left
  // alone. feat/ui replays because its parent's tip is about to move.
  assert.deepEqual(rebases.map((s) => s.branch), ['feat/api', 'feat/ui']);

  const api = stack.branches.find((b) => b.name === 'feat/api')!;
  // Still anchored to the recorded SHA, exactly as a reorder would be.
  assert.equal(rebases[0].command, `git rebase --onto feat/auth ${api.base} feat/api`);
  // And the metadata write still comes along, or gh-stack keeps the stale bases.
  assert.ok(plan.steps.some((s) => s.kind === 'metadata'));
});

test('a forced plan with no drift is still a no-op', () => {
  const stack = parseStack(fixture);
  const order = stack.branches.map((b) => b.name);

  // isNoop gates the Apply button and the host's own staleness check, so
  // claiming work exists here would offer an apply that runs no rebases.
  assert.equal(computePlan(stack, order, [], { force: true }).isNoop, true);
});

test('force does not change what a reorder plans', () => {
  const stack = withDrift(['feat/api']);
  const reordered = ['feat/api', 'feat/auth', 'feat/ui'];

  const plain = computePlan(stack, reordered);
  const forced = computePlan(stack, reordered, [], { force: true });

  assert.deepEqual(
    forced.steps.map((s) => s.command),
    plain.steps.map((s) => s.command),
  );
});

test('supplemental drift replays a branch gh-stack has not flagged', () => {
  // The post-fetch case: the trunk moved, so the bottom branch is no longer on
  // it — but `gh stack view` ran before the fetch and reports needsRebase
  // false for everything.
  const stack = parseStack(fixture);
  const order = stack.branches.map((b) => b.name);
  const [auth, api, ui] = stack.branches;

  const plan = computePlan(stack, order, [], { force: true, drifted: ['feat/auth'] });
  assert.equal(plan.isNoop, false);

  const rebases = plan.steps.filter((s) => s.kind === 'rebase');
  // The named branch, and the cascade above it — the same rule needsRebase gets.
  assert.deepEqual(rebases.map((s) => s.branch), ['feat/auth', 'feat/api', 'feat/ui']);
  assert.equal(rebases[0].command, `git rebase --onto main ${auth.base} feat/auth`);
  assert.equal(rebases[1].command, `git rebase --onto feat/auth ${api.base} feat/api`);
  assert.equal(rebases[2].command, `git rebase --onto feat/api ${ui.base} feat/ui`);
});

test('drifted is inert without force', () => {
  // force is the switch; drifted only says which branches it should also cover.
  // A reorder must never quietly replay extra branches because the host passed
  // a list it computed for a different purpose.
  const stack = parseStack(fixture);
  const order = stack.branches.map((b) => b.name);
  assert.equal(computePlan(stack, order, [], { drifted: ['feat/auth'] }).isNoop, true);
});

test('syncPlan fast-forwards the trunk, then replays the whole stack', () => {
  const stack = parseStack(fixture);
  const [auth, api, ui] = stack.branches;

  const plan = syncPlan(stack, 'origin', false);
  assert.deepEqual(
    plan.steps.map((s) => s.kind),
    ['trunk', 'rebase', 'rebase', 'rebase', 'metadata', 'push', 'submit'],
  );

  // The trunk moves first: everything after it replays onto the new tip.
  assert.equal(plan.steps[0].command, 'git fetch origin main:main');

  const rebases = plan.steps.filter((s) => s.kind === 'rebase');
  assert.deepEqual(rebases.map((s) => s.branch), ['feat/auth', 'feat/api', 'feat/ui']);
  // The load-bearing part. feat/auth's anchor is its recorded base — the trunk
  // SHA from *before* the fast-forward — so the replay takes its own commits
  // and not the ones the trunk just gained. `--onto main main feat/auth` would
  // resolve both ends to the new tip and replay nothing.
  assert.equal(rebases[0].command, `git rebase --onto main ${auth.base} feat/auth`);
  assert.equal(rebases[1].command, `git rebase --onto feat/auth ${api.base} feat/api`);
  assert.equal(rebases[2].command, `git rebase --onto feat/api ${ui.base} feat/ui`);
});

test('syncPlan merges instead of fetching when the trunk is checked out', () => {
  // git refuses `fetch <remote> <branch>:<branch>` onto a checked-out branch,
  // so the same fast-forward has to be spelled differently.
  const plan = syncPlan(parseStack(fixture), 'upstream', true);
  assert.equal(plan.steps[0].command, 'git merge --ff-only upstream/main');
  assert.deepEqual(plan.steps[0].exec, {
    file: 'git',
    args: ['merge', '--ff-only', 'upstream/main'],
  });
});

test('syncPlan on an empty stack has nothing to fast-forward for', () => {
  const empty = { ...parseStack(fixture), branches: [] };
  const plan = syncPlan(empty, 'origin', false);
  assert.equal(plan.isNoop, true);
  // No trunk step either: moving the trunk is only worth doing as the first
  // half of a replay, and there is nothing to replay.
  assert.deepEqual(plan.steps, []);
});

test('changeBasePlan re-targets the bottom branch and cascades', () => {
  const stack = parseStack(fixture);
  const [auth, api, ui] = stack.branches;

  const plan = changeBasePlan(stack, 'release/2.0');
  const rebases = plan.steps.filter((s) => s.kind === 'rebase');
  assert.deepEqual(rebases.map((s) => s.branch), ['feat/auth', 'feat/api', 'feat/ui']);

  // Only the bottom branch's target changes; the ones above still stack on
  // their own parents, and every anchor is still the recorded pre-rebase SHA.
  assert.equal(rebases[0].command, `git rebase --onto release/2.0 ${auth.base} feat/auth`);
  assert.equal(rebases[1].command, `git rebase --onto feat/auth ${api.base} feat/api`);
  assert.equal(rebases[2].command, `git rebase --onto feat/api ${ui.base} feat/ui`);

  // No trunk step: the new base is a branch that already exists as it is.
  assert.ok(!plan.steps.some((s) => s.kind === 'trunk'));
  // The metadata write is what records the new trunk in .git/gh-stack.
  assert.ok(plan.steps.some((s) => s.kind === 'metadata'));
});
