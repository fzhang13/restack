import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MIN_AUTO_FETCH_SECONDS,
  autoFetchInterval,
  branchesBehind,
  ensureBaseBranch,
  detectRemote,
  listRemoteBranches,
  listRemotes,
  localNameFor,
  readAllTracking,
  readRemoteState,
} from '../src/remote.ts';
import type { Stack } from '../src/model.ts';

/**
 * Real repositories again, and for a sharper reason than the other suites:
 * every function here is a claim about what a specific git format string emits.
 * `%(upstream:track,nobracket)` produces `ahead 2, behind 1` on git 2.50 and is
 * not documented to keep producing exactly that — a mocked git would only ever
 * confirm the string this file already assumes.
 */

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

function configure(cwd: string, who: string): void {
  git(cwd, 'config', 'user.email', `${who}@example.com`);
  git(cwd, 'config', 'user.name', who);
  git(cwd, 'config', 'commit.gpgsign', 'false');
}

/**
 * A bare origin with `main` and `feat/x` on it, and a clone tracking both.
 * `them` is a second clone standing in for anyone else pushing.
 */
function makeClones(): { cwd: string; origin: string; them: string } {
  const origin = mkdtempSync(join(tmpdir(), 'restack-origin-'));
  git(origin, 'init', '--bare', '-b', 'main');

  const seed = mkdtempSync(join(tmpdir(), 'restack-seed-'));
  git(seed, 'init', '-b', 'main');
  configure(seed, 'seed');
  commit(seed, 'README.md', 'base\n', 'init');
  git(seed, 'checkout', '-b', 'feat/x');
  commit(seed, 'x.txt', 'x\n', 'feat: x');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', 'origin', 'main', 'feat/x');
  rmSync(seed, { recursive: true, force: true });

  const cwd = mkdtempSync(join(tmpdir(), 'restack-us-'));
  git(cwd, 'clone', origin, cwd);
  configure(cwd, 'us');
  git(cwd, 'checkout', 'feat/x');

  const them = mkdtempSync(join(tmpdir(), 'restack-them-'));
  git(them, 'clone', origin, them);
  configure(them, 'them');

  return { cwd, origin, them };
}

function cleanup(...dirs: string[]): void {
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
}

test('a level branch reports neither ahead nor behind', async (t) => {
  const { cwd, origin, them } = makeClones();
  t.after(() => cleanup(cwd, origin, them));

  const tracking = await readAllTracking(cwd);
  assert.deepEqual(tracking.get('feat/x'), {
    branch: 'feat/x',
    upstream: 'origin/feat/x',
    ahead: 0,
    behind: 0,
    gone: false,
  });
});

test('ahead, behind, and diverged are each counted', async (t) => {
  const { cwd, origin, them } = makeClones();
  t.after(() => cleanup(cwd, origin, them));

  // Ahead: two local commits nobody has seen.
  commit(cwd, 'a.txt', 'a\n', 'feat: a');
  commit(cwd, 'b.txt', 'b\n', 'feat: b');
  let tracking = await readAllTracking(cwd);
  assert.equal(tracking.get('feat/x')!.ahead, 2);
  assert.equal(tracking.get('feat/x')!.behind, 0);

  // Diverged: they push one of their own on top of the original tip.
  git(them, 'checkout', 'feat/x');
  commit(them, 'theirs.txt', 'theirs\n', 'feat: theirs');
  git(them, 'push', 'origin', 'feat/x');
  git(cwd, 'fetch', 'origin');

  tracking = await readAllTracking(cwd);
  // The parse has to survive `ahead 2, behind 1` — one field, two numbers.
  assert.equal(tracking.get('feat/x')!.ahead, 2);
  assert.equal(tracking.get('feat/x')!.behind, 1);

  // Behind alone: main never moved locally.
  git(them, 'checkout', 'main');
  commit(them, 'trunk.txt', 't\n', 'chore: trunk');
  git(them, 'push', 'origin', 'main');
  git(cwd, 'fetch', 'origin');

  tracking = await readAllTracking(cwd);
  assert.equal(tracking.get('main')!.ahead, 0);
  assert.equal(tracking.get('main')!.behind, 1);
});

test('a branch with no upstream is distinguishable from a level one', async (t) => {
  const { cwd, origin, them } = makeClones();
  t.after(() => cleanup(cwd, origin, them));

  git(cwd, 'checkout', '-b', 'local-only');
  commit(cwd, 'local.txt', 'l\n', 'feat: local');

  const tracking = await readAllTracking(cwd);
  const local = tracking.get('local-only')!;
  // Both zero, like a level branch — the missing upstream is the whole signal,
  // which is why the badge keys off it and not the counts.
  assert.equal(local.upstream, undefined);
  assert.equal(local.ahead, 0);
  assert.equal(local.behind, 0);
  assert.equal(local.gone, false);
});

test('a deleted upstream reads as gone, not as level', async (t) => {
  const { cwd, origin, them } = makeClones();
  t.after(() => cleanup(cwd, origin, them));

  git(them, 'push', 'origin', '--delete', 'feat/x');
  // --prune is what makes this visible; without it the stale remote-tracking
  // ref survives and the branch reads as level forever.
  git(cwd, 'fetch', '--prune', 'origin');

  const tracking = await readAllTracking(cwd);
  const x = tracking.get('feat/x')!;
  assert.equal(x.gone, true);
  assert.equal(x.upstream, 'origin/feat/x');
});

test('branchesBehind picks only the branches a force-push would clobber', () => {
  const tracking = new Map(
    [
      { branch: 'level', upstream: 'origin/level', ahead: 0, behind: 0, gone: false },
      { branch: 'ahead', upstream: 'origin/ahead', ahead: 3, behind: 0, gone: false },
      { branch: 'behind', upstream: 'origin/behind', ahead: 0, behind: 2, gone: false },
      { branch: 'diverged', upstream: 'origin/diverged', ahead: 1, behind: 1, gone: false },
      { branch: 'gone', upstream: 'origin/gone', ahead: 0, behind: 4, gone: true },
      { branch: 'unpushed', ahead: 0, behind: 0, gone: false },
    ].map((t) => [t.branch, t] as const),
  );
  const names = ['level', 'ahead', 'behind', 'diverged', 'gone', 'unpushed', 'unknown'];

  // Behind is the signal, whether or not we are also ahead. `gone` is excluded
  // deliberately: a branch deleted after its PR merged has nothing to clobber,
  // and refusing there would block every stack that had ever landed anything.
  assert.deepEqual(
    branchesBehind(tracking, names).map((t) => t.branch),
    ['behind', 'diverged'],
  );

  // A name not in the map at all — a branch about to be created — is not a
  // hazard either.
  assert.deepEqual(branchesBehind(tracking, ['unknown']), []);
});

test('readRemoteState lines the branches up with the stack', async (t) => {
  const { cwd, origin, them } = makeClones();
  t.after(() => cleanup(cwd, origin, them));

  git(them, 'checkout', 'main');
  commit(them, 'trunk.txt', 't\n', 'chore: trunk');
  git(them, 'push', 'origin', 'main');
  git(cwd, 'fetch', 'origin');
  git(cwd, 'checkout', '-b', 'feat/y', 'feat/x');
  commit(cwd, 'y.txt', 'y\n', 'feat: y');

  const stack: Stack = {
    trunk: 'main',
    branches: [
      { name: 'feat/x', base: '', isCurrent: false, isMerged: false, isQueued: false, needsRebase: false },
      { name: 'feat/y', base: '', isCurrent: true, isMerged: false, isQueued: false, needsRebase: false },
    ],
  };

  const state = await readRemoteState(cwd, stack);
  assert.equal(state.remote, 'origin');
  assert.equal(state.trunk.behind, 1);
  // Parallel to stack.branches, in the same order, so the view can zip them.
  assert.deepEqual(state.branches.map((b) => b.branch), ['feat/x', 'feat/y']);
  assert.equal(state.branches[0].upstream, 'origin/feat/x');
  assert.equal(state.branches[1].upstream, undefined);
  // A fetch happened above, so this is set — it is what the "as of" is read from.
  assert.ok(typeof state.lastFetched === 'number');
});

test('readRemoteState degrades rather than failing without a remote', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'restack-bare-'));
  t.after(() => cleanup(cwd));
  git(cwd, 'init', '-b', 'main');
  configure(cwd, 'us');
  commit(cwd, 'README.md', 'base\n', 'init');

  const state = await readRemoteState(cwd, { trunk: 'main', branches: [] });
  // undefined `remote` is what disables the Fetch button; the rest is empty
  // rather than absent, so the view has something to render either way.
  assert.equal(state.remote, undefined);
  assert.equal(state.lastFetched, undefined);
  assert.equal(state.trunk.branch, 'main');
  assert.equal(state.trunk.upstream, undefined);
  assert.equal(state.trunk.ahead, 0);
  assert.equal(state.trunk.behind, 0);
  assert.equal(state.trunk.gone, false);
});

test('detectRemote follows the trunk config before falling back to origin', async (t) => {
  const { cwd, origin, them } = makeClones();
  t.after(() => cleanup(cwd, origin, them));

  assert.equal(await detectRemote(cwd, 'main'), 'origin');

  // A stack based on a colleague's branch may well track a fork.
  git(cwd, 'remote', 'add', 'fork', origin);
  git(cwd, 'config', 'branch.main.remote', 'fork');
  assert.equal(await detectRemote(cwd, 'main'), 'fork');

  // A branch with no config of its own still gets the fallback.
  git(cwd, 'checkout', '-b', 'orphan');
  assert.equal(await detectRemote(cwd, 'orphan'), 'origin');
});

test('listRemoteBranches drops the HEAD symref', async (t) => {
  const { cwd, origin, them } = makeClones();
  t.after(() => cleanup(cwd, origin, them));

  const branches = await listRemoteBranches(cwd);
  // origin/HEAD is a pointer at the default branch, not something a stack can
  // be based on — offering it would produce a local branch named `HEAD`.
  assert.deepEqual(branches.sort(), ['origin/feat/x', 'origin/main']);
});

test('localNameFor strips only an actual remote prefix', async () => {
  assert.equal(localNameFor('origin/feat/x', ['origin']), 'feat/x');
  assert.equal(localNameFor('fork/feat/x', ['origin', 'fork']), 'feat/x');
  // A local branch genuinely called `origin/thing` when there is no `origin`
  // remote is left alone rather than silently renamed.
  assert.equal(localNameFor('origin/thing', ['upstream']), 'origin/thing');
  assert.equal(localNameFor('feat/x', []), 'feat/x');
});

test('listRemotes reports every configured remote', async (t) => {
  const { cwd, origin, them } = makeClones();
  t.after(() => cleanup(cwd, origin, them));

  git(cwd, 'remote', 'add', 'fork', origin);
  assert.deepEqual((await listRemotes(cwd)).sort(), ['fork', 'origin']);
});

test('ensureBaseBranch makes a local branch that tracks the remote one', async (t) => {
  const { cwd, origin, them } = makeClones();
  t.after(() => cleanup(cwd, origin, them));

  git(them, 'checkout', '-b', 'their-work', 'main');
  commit(them, 'w.txt', 'w\n', 'feat: their work');
  git(them, 'push', 'origin', 'their-work');
  git(cwd, 'fetch', 'origin');

  assert.deepEqual(await ensureBaseBranch(cwd, 'their-work', 'origin/their-work'), {
    kind: 'created',
  });

  // Resolvable locally, which is what initPreflight and gh-stack both require.
  assert.equal(
    git(cwd, 'rev-parse', 'their-work'),
    git(cwd, 'rev-parse', 'origin/their-work'),
  );
  const tracking = await readAllTracking(cwd);
  assert.equal(tracking.get('their-work')!.upstream, 'origin/their-work');
});

test('ensureBaseBranch reports an existing branch that is already current', async (t) => {
  const { cwd, origin, them } = makeClones();
  t.after(() => cleanup(cwd, origin, them));

  const before = git(cwd, 'rev-parse', 'feat/x');
  // `git branch --track` would exit non-zero here. Adopting the existing branch
  // is the right answer: it is already the branch the user picked, at the right
  // commit.
  assert.deepEqual(await ensureBaseBranch(cwd, 'feat/x', 'origin/feat/x'), { kind: 'current' });
  assert.equal(git(cwd, 'rev-parse', 'feat/x'), before);
});

test('ensureBaseBranch catches up a stale local branch instead of adopting it', async (t) => {
  const { cwd, origin, them } = makeClones();
  t.after(() => cleanup(cwd, origin, them));

  // The second-time-through case, and the whole reason this is not just
  // `git branch --track`: the branch exists locally from an earlier init, and
  // its owner has pushed twice since. Adopting it silently would replay the
  // stack onto a commit two behind.
  git(them, 'checkout', '-b', 'their-work', 'main');
  commit(them, 'w.txt', 'w\n', 'feat: their work');
  git(them, 'push', 'origin', 'their-work');
  git(cwd, 'fetch', 'origin');
  git(cwd, 'branch', '--track', 'their-work', 'origin/their-work');

  commit(them, 'w2.txt', 'w2\n', 'feat: more');
  commit(them, 'w3.txt', 'w3\n', 'feat: more still');
  git(them, 'push', 'origin', 'their-work');
  git(cwd, 'fetch', 'origin');

  assert.deepEqual(await ensureBaseBranch(cwd, 'their-work', 'origin/their-work'), {
    kind: 'fastForwarded',
    by: 2,
  });
  assert.equal(
    git(cwd, 'rev-parse', 'their-work'),
    git(cwd, 'rev-parse', 'origin/their-work'),
  );
  // The fetch-into-a-ref form must not cost the branch its upstream, or every
  // ahead/behind count for it afterwards would come back empty.
  assert.equal((await readAllTracking(cwd)).get('their-work')!.upstream, 'origin/their-work');
});

test('ensureBaseBranch fast-forwards the branch it is standing on', async (t) => {
  const { cwd, origin, them } = makeClones();
  t.after(() => cleanup(cwd, origin, them));

  // git refuses `fetch . <ref>:<branch>` into a checked-out branch, so this
  // takes the merge --ff-only path instead. makeClones leaves us on feat/x.
  git(them, 'checkout', 'feat/x');
  commit(them, 'theirs.txt', 't\n', 'feat: theirs');
  git(them, 'push', 'origin', 'feat/x');
  git(cwd, 'fetch', 'origin');

  assert.deepEqual(await ensureBaseBranch(cwd, 'feat/x', 'origin/feat/x'), {
    kind: 'fastForwarded',
    by: 1,
  });
  assert.equal(git(cwd, 'rev-parse', 'feat/x'), git(cwd, 'rev-parse', 'origin/feat/x'));
  // The working tree came along, which is the point of the merge form.
  assert.equal(git(cwd, 'status', '--porcelain'), '');
});

test('ensureBaseBranch refuses a local branch that has diverged', async (t) => {
  const { cwd, origin, them } = makeClones();
  t.after(() => cleanup(cwd, origin, them));

  // Our own commit on someone else's branch, plus one of theirs. Fast-forward
  // is impossible and rewriting their branch is not ours to do.
  commit(cwd, 'ours.txt', 'o\n', 'feat: ours');
  git(them, 'checkout', 'feat/x');
  commit(them, 'theirs.txt', 't\n', 'feat: theirs');
  git(them, 'push', 'origin', 'feat/x');
  git(cwd, 'fetch', 'origin');

  assert.deepEqual(await ensureBaseBranch(cwd, 'feat/x', 'origin/feat/x'), {
    kind: 'diverged',
    ahead: 1,
    behind: 1,
  });

  // Ahead-only is refused too: there is nothing to fast-forward to, and the
  // commits are still ones the base's owner has never seen.
  git(cwd, 'checkout', '-b', 'solo', 'origin/main');
  commit(cwd, 'solo.txt', 's\n', 'feat: solo');
  assert.deepEqual(await ensureBaseBranch(cwd, 'solo', 'origin/main'), {
    kind: 'diverged',
    ahead: 1,
    behind: 0,
  });
});

test('ensureBaseBranch reports a remote ref that is not there', async (t) => {
  const { cwd, origin, them } = makeClones();
  t.after(() => cleanup(cwd, origin, them));

  const result = await ensureBaseBranch(cwd, 'nope', 'origin/nope');
  // Has to be a value, not a throw: the host aborts the init on it rather
  // than letting `gh stack init` record a trunk that does not resolve.
  assert.equal(result.kind, 'failed');
  assert.match(result.kind === 'failed' ? result.message : '', /nope/);
});

/**
 * The one part of background fetch that can be tested here. The timer and the
 * visibility gating live in provider.ts, which needs a `vscode` module this
 * runner has no way to supply — those are verified by hand in the sandboxes.
 */
test('autoFetchInterval reads the default as off', () => {
  assert.equal(autoFetchInterval(0), 0);
  assert.equal(autoFetchInterval(undefined), 0);
});

test('autoFetchInterval floors a too-eager interval instead of honouring it', () => {
  // The mistyped-`5` case: a free-form number box should not be able to
  // produce twelve network calls a minute.
  assert.equal(autoFetchInterval(5), MIN_AUTO_FETCH_SECONDS);
  assert.equal(autoFetchInterval(59), MIN_AUTO_FETCH_SECONDS);
  assert.equal(autoFetchInterval(60), 60);
  assert.equal(autoFetchInterval(180), 180);
});

test('autoFetchInterval reads a nonsense setting as off rather than guessing', () => {
  // settings.json is hand-editable, so none of these are hypothetical.
  assert.equal(autoFetchInterval(-1), 0);
  assert.equal(autoFetchInterval(Number.NaN), 0);
  assert.equal(autoFetchInterval(Number.POSITIVE_INFINITY), 0);
  assert.equal(autoFetchInterval('180'), 0);
  assert.equal(autoFetchInterval(null), 0);
});

test('autoFetchInterval rounds a fractional interval to whole seconds', () => {
  assert.equal(autoFetchInterval(180.6), 181);
});
