import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApplyRunner, hasOrigin, preflight } from '../src/apply.ts';
import { computePlan } from '../src/plan.ts';
import type { ApplyProgress, Stack } from '../src/model.ts';

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
