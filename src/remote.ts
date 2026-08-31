import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { runCommand, firstLine, gitCommonDir, hasOrigin } from './apply.ts';
import type { RemoteState, Stack, Tracking } from './model.ts';

/**
 * What the remote says, and the one command that goes and asks it.
 *
 * Everything except `fetchRemote` reads local refs only — `refs/remotes/*` and
 * the branch config — so `refresh()` can call `readRemoteState` on every
 * `.git/HEAD` change without touching the network. That split is the whole
 * design: the counts shown in the view are free and instant, and the network
 * is only reached when the user presses Fetch or Sync — or on the
 * `restack.autoFetch` timer, which is off unless they turn it on.
 *
 * Like candidates.ts, nothing here rejects. A repository with no remote, or one
 * git cannot enumerate, yields empty state rather than an error — the view then
 * simply has nothing to say about the remote, which is the truth.
 */

/** Where a branch stands against its upstream. */
export type { RemoteState, Tracking } from './model.ts';

/**
 * The remote a stack publishes to.
 *
 * Follows the trunk's own configuration first: a stack based on a colleague's
 * branch may well track a fork rather than `origin`, and `gh stack push`
 * auto-detects the same way. Falls back to `origin`, and to undefined when
 * there is no remote at all — which is what gates the Fetch button.
 */
export async function detectRemote(cwd: string, trunk: string): Promise<string | undefined> {
  const configured = await runCommand('git', ['config', '--get', `branch.${trunk}.remote`], cwd);
  const name = configured.code === 0 ? configured.stdout.trim() : '';
  if (name) {
    return name;
  }
  return (await hasOrigin(cwd)) ? 'origin' : undefined;
}

/**
 * Every local branch's position against its upstream, in one git call.
 *
 * `%(upstream:track,nobracket)` emits exactly the three cases that matter and
 * nothing else: `ahead N`, `behind N`, `ahead N, behind M`, or `gone`. An empty
 * field means level, and an empty `%(upstream:short)` means no upstream at all.
 * Verified against git 2.50.
 *
 * Doing this per-branch with `rev-list --left-right` would be N subprocesses
 * and would have to special-case a deleted upstream, which exits 128 in a way
 * indistinguishable from a typo.
 */
export async function readAllTracking(cwd: string): Promise<Map<string, Tracking>> {
  const result = await runCommand(
    'git',
    [
      'for-each-ref',
      '--format=%(refname:short)%09%(upstream:short)%09%(upstream:track,nobracket)',
      'refs/heads',
    ],
    cwd,
  );

  const tracking = new Map<string, Tracking>();
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    const [branch, upstream = '', track = ''] = line.split('\t');
    if (!branch) {
      continue;
    }
    tracking.set(branch, {
      branch,
      upstream: upstream || undefined,
      ahead: matchCount(track, 'ahead'),
      behind: matchCount(track, 'behind'),
      gone: track.trim() === 'gone',
    });
  }
  return tracking;
}

function matchCount(track: string, word: 'ahead' | 'behind'): number {
  const found = new RegExp(`${word} (\\d+)`).exec(track);
  return found ? Number.parseInt(found[1], 10) : 0;
}

/** A branch git knows nothing about: never pushed, or not a branch at all. */
function untracked(branch: string): Tracking {
  return { branch, ahead: 0, behind: 0, gone: false };
}

/**
 * The trunk and every stack branch, measured against their upstreams.
 *
 * Local reads only. `branches` is parallel to `stack.branches`, so the view can
 * zip them without a lookup.
 */
export async function readRemoteState(cwd: string, stack: Stack): Promise<RemoteState> {
  const [remote, tracking, lastFetched] = await Promise.all([
    detectRemote(cwd, stack.trunk),
    readAllTracking(cwd),
    readLastFetched(cwd),
  ]);

  return {
    remote,
    trunk: tracking.get(stack.trunk) ?? untracked(stack.trunk),
    branches: stack.branches.map((b) => tracking.get(b.name) ?? untracked(b.name)),
    lastFetched,
  };
}

/**
 * When the last fetch happened, from `.git/FETCH_HEAD`'s mtime.
 *
 * Approximate by construction — any fetch rewrites it, including ones Restack
 * did not run — but that is exactly the question being asked: how stale are
 * these counts. Absent before the first fetch in a fresh clone.
 */
async function readLastFetched(cwd: string): Promise<number | undefined> {
  try {
    return (await stat(join(await gitCommonDir(cwd), 'FETCH_HEAD'))).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Go and ask the remote. The only function here that touches the network.
 *
 * `--prune` is what makes `gone` mean anything: without it a branch deleted on
 * the remote keeps a stale `refs/remotes` entry and reads as level forever.
 * Goes through runCommand, so it inherits `GIT_TERMINAL_PROMPT=0` — a fetch
 * needing credentials fails rather than hanging on a prompt nobody can answer —
 * and the full output lands in the Restack channel.
 */
export async function fetchRemote(cwd: string, remote: string): Promise<string | undefined> {
  const result = await runCommand('git', ['fetch', '--prune', remote], cwd, 180_000);
  if (result.code === 0) {
    return undefined;
  }
  return (
    result.stderr.trim().split('\n').find((l) => l.trim())?.trim() ||
    `git fetch --prune ${remote} failed.`
  );
}

/**
 * The floor on `restack.autoFetch`, in seconds.
 *
 * The setting is a free-form number box, so a mistyped `5` would otherwise put
 * a network call in front of the user twelve times a minute. Sixty is low
 * enough that nobody who wants frequent fetches feels constrained, and high
 * enough that a typo cannot become a loop.
 */
export const MIN_AUTO_FETCH_SECONDS = 60;

/**
 * Read the `restack.autoFetch` setting into an interval, or 0 for off.
 *
 * Anything that is not a positive finite number reads as off, which covers the
 * default and every way a hand-edited settings.json can go wrong — a string, a
 * negative, a NaN. Off is the safe interpretation: the alternative to a
 * background fetch is the Fetch button, which still works.
 */
export function autoFetchInterval(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    return 0;
  }
  return Math.max(Math.round(raw), MIN_AUTO_FETCH_SECONDS);
}

/**
 * Remote-tracking branches, for the base picker.
 *
 * `<remote>/HEAD` is a symbolic ref pointing at the default branch, not a
 * branch you can base anything on, so it is dropped. It has to be recognised by
 * its *full* refname: `%(refname:short)` shortens `refs/remotes/origin/HEAD` all
 * the way to `origin`, so filtering the short name for a `/HEAD` suffix silently
 * matches nothing and offers a base called `origin` that is not a branch.
 *
 * Names are returned qualified (`origin/feat/x`), which is how they are shown
 * and how `git branch --track` wants them.
 */
export async function listRemoteBranches(cwd: string): Promise<string[]> {
  const result = await runCommand(
    'git',
    ['for-each-ref', '--format=%(refname)%09%(refname:short)', 'refs/remotes'],
    cwd,
  );

  const branches: string[] = [];
  for (const line of result.stdout.split('\n')) {
    const [full = '', short = ''] = line.trim().split('\t');
    if (short && !full.endsWith('/HEAD')) {
      branches.push(short);
    }
  }
  return branches;
}

/**
 * The local branch name a remote-tracking ref would become: `origin/feat/x` ->
 * `feat/x`. Only strips a leading segment that is actually a remote, so a local
 * branch genuinely called `origin/thing` is left alone.
 */
export function localNameFor(remoteBranch: string, remotes: string[]): string {
  for (const remote of remotes) {
    if (remoteBranch.startsWith(`${remote}/`)) {
      return remoteBranch.slice(remote.length + 1);
    }
  }
  return remoteBranch;
}

/** Every configured remote, for localNameFor. Empty when there are none. */
export async function listRemotes(cwd: string): Promise<string[]> {
  const result = await runCommand('git', ['remote'], cwd);
  return result.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

/**
 * What happened to the local branch a stack is about to sit on.
 *
 * Every case is distinct in what the user needs to be told, which is why this
 * is a variant and not a boolean: silently adopting a branch is the one outcome
 * that reads as success and is not.
 */
export type BaseBranchResult =
  | { kind: 'created' }
  | { kind: 'current' }
  | { kind: 'fastForwarded'; by: number }
  | { kind: 'diverged'; ahead: number; behind: number }
  | { kind: 'failed'; message: string };

/**
 * Make `local` exist and match `remoteBranch`, so a stack can be based on a
 * branch that belongs to someone else.
 *
 * gh-stack records a trunk by *name* and `initPreflight` refuses one that does
 * not resolve locally, so this has to happen before `gh stack init` runs — and
 * before any plan is built, since the whole stack is about to be replayed onto
 * whatever commit this branch is sitting on.
 *
 * The case worth spelling out is the second time you do this. The branch now
 * exists locally, at whatever commit it was at when you first created it, while
 * the colleague has pushed twice since. Creating it is only correct once;
 * afterwards it has to be caught up, or the stack lands on a stale base with
 * nothing on screen saying so. Being merely behind is fast-forwarded, which
 * cannot lose anything. Anything else is reported rather than resolved: local
 * commits on someone else's branch are not ours to rewrite.
 *
 * Compares against the ref the caller named rather than the branch's configured
 * upstream, so a local branch that tracks nothing — or tracks a different
 * remote — is still measured against the branch actually being adopted.
 */
export async function ensureBaseBranch(
  cwd: string,
  local: string,
  remoteBranch: string,
): Promise<BaseBranchResult> {
  const exists = await runCommand(
    'git',
    ['rev-parse', '--verify', '--quiet', `refs/heads/${local}`],
    cwd,
  );
  if (exists.code !== 0) {
    const created = await runCommand('git', ['branch', '--track', local, remoteBranch], cwd);
    if (created.code !== 0) {
      return {
        kind: 'failed',
        message: firstLine(created.stderr) || `Could not create ${local} tracking ${remoteBranch}.`,
      };
    }
    return { kind: 'created' };
  }

  const counts = await runCommand(
    'git',
    ['rev-list', '--left-right', '--count', `${local}...${remoteBranch}`],
    cwd,
  );
  if (counts.code !== 0) {
    return {
      kind: 'failed',
      message: firstLine(counts.stderr) || `Could not compare ${local} with ${remoteBranch}.`,
    };
  }
  const [ahead = 0, behind = 0] = counts.stdout
    .trim()
    .split(/\s+/)
    .map((n) => Number.parseInt(n, 10) || 0);

  if (ahead > 0) {
    return { kind: 'diverged', ahead, behind };
  }
  if (behind === 0) {
    return { kind: 'current' };
  }

  const failure = await fastForwardTo(cwd, local, remoteBranch);
  return failure ? { kind: 'failed', message: failure } : { kind: 'fastForwarded', by: behind };
}

/**
 * Fast-forward a local branch onto a ref already in the object store.
 *
 * Two forms, because git has two. `git fetch . <ref>:<branch>` moves a branch
 * without checking it out, keeps its upstream configuration, and refuses
 * anything that is not a fast-forward — the same safety `trunkSyncStep` leans
 * on, and the reason this is not `update-ref`, which would happily move the
 * branch backwards. The `.` is the local repository, so despite the verb this
 * reaches no network. Git refuses that form on a checked-out branch, which is
 * what `merge --ff-only` is for.
 */
async function fastForwardTo(
  cwd: string,
  local: string,
  ref: string,
): Promise<string | undefined> {
  const head = await runCommand('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd);
  const checkedOut = head.code === 0 && head.stdout.trim() === local;
  const args = checkedOut ? ['merge', '--ff-only', ref] : ['fetch', '.', `${ref}:${local}`];

  const result = await runCommand('git', args, cwd);
  if (result.code === 0) {
    return undefined;
  }
  return firstLine(result.stderr) || `Could not fast-forward ${local} to ${ref}.`;
}

/**
 * Branches that would lose commits if the stack were rewritten and pushed now.
 *
 * The clobber case: `gh stack push` uses `--force-with-lease`, which compares
 * against the *remote-tracking* ref. If someone pushed to one of these branches
 * and we have not fetched, that ref is stale, the lease passes, and their
 * commits are overwritten. Being behind is the signal, whether or not we are
 * also ahead.
 *
 * Reads local refs only, so preflight stays free of the network. `gone` is not
 * included: a deleted upstream is ordinary after a merge and has nothing left
 * to clobber.
 */
export function branchesBehind(tracking: Map<string, Tracking>, names: string[]): Tracking[] {
  return names
    .map((name) => tracking.get(name))
    .filter((t): t is Tracking => t !== undefined && !t.gone && t.behind > 0);
}
