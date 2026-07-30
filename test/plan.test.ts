import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseStack } from '../src/parse.ts';
import { computePlan } from '../src/plan.ts';

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

test('plan ends with force-with-lease push then submit', () => {
  const stack = parseStack(fixture);
  const plan = computePlan(stack, ['feat/auth', 'feat/ui', 'feat/api']);
  const kinds = plan.steps.map((s) => s.kind);
  assert.deepEqual(kinds.slice(-2), ['push', 'submit']);
  const push = plan.steps.at(-2)!;
  assert.match(push.command, /--force-with-lease/);
  assert.equal(plan.steps.at(-1)!.command, 'gh stack submit');
});

test('reports merged branches so the UI can refuse to reorder them', () => {
  const stack = parseStack(fixture);
  stack.branches[0].isMerged = true;
  const plan = computePlan(stack, ['feat/auth', 'feat/ui', 'feat/api']);
  assert.deepEqual(plan.mergedBranches, ['feat/auth']);
});
