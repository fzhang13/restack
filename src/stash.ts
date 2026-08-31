import { run } from './git.ts';

/**
 * Put the working tree aside, and put it back.
 *
 * Restack refuses every operation that moves HEAD while the tree is dirty, for
 * the reason apply.ts states: a rebase over uncommitted work is the one failure
 * no snapshot can undo. This is the other half of that refusal — the offer to
 * do by hand what you would have done by hand, without leaving the view.
 *
 * Two rules shape everything here.
 *
 * Untracked files are not touched. Every dirty check in this codebase passes
 * `--untracked-files=no`, so an untracked file has never blocked anything; a
 * stash that swept them up would pocket files Restack never objected to.
 *
 * A stash is identified by its commit sha, never by `stash@{0}`. The stash is
 * a stack, and the user has a terminal: a stash pushed in another window shifts
 * every index down by one, and popping `stash@{0}` would then restore the wrong
 * work over theirs. The sha is stable, so it is what gets recorded — including
 * into the apply session that survives a window reload.
 */

/** What `git stash list` says about one entry. */
interface Entry {
  sha: string;
  /** The reflog selector, e.g. `stash@{2}`. Only valid until the list changes. */
  selector: string;
}

export type StashPush =
  | { kind: 'stashed'; sha: string }
  /** Nothing to stash. Not an error: the caller can simply carry on. */
  | { kind: 'clean' }
  | { kind: 'failed'; message: string };

export type StashRestore =
  | { kind: 'restored' }
  /**
   * The pop hit a conflict. git leaves the entry in place when this happens,
   * which is the one piece of good news worth passing on.
   */
  | { kind: 'conflict'; selector: string }
  /** The entry is gone — popped by hand, or dropped. Nothing left to do. */
  | { kind: 'missing' }
  | { kind: 'failed'; message: string; selector?: string };

/**
 * Stash tracked changes and return the entry's sha.
 *
 * `--keep-index` is deliberately *not* used: the operations this unblocks all
 * check out branches, and a staged-but-stashed state would leave the index
 * disagreeing with the tree across a checkout.
 */
export async function stashPush(cwd: string, label: string): Promise<StashPush> {
  const before = await listEntries(cwd);
  const result = await run('git', ['stash', 'push', '--message', label], cwd);
  if (result.code !== 0) {
    return { kind: 'failed', message: firstLine(result.stderr) || 'git stash push failed.' };
  }

  const after = await listEntries(cwd);
  // "No local changes to save" also exits 0, so the list is what says whether
  // anything actually happened — not the exit code, and not the message text.
  if (after.length === before.length) {
    return { kind: 'clean' };
  }
  return { kind: 'stashed', sha: after[0].sha };
}

/**
 * Put a stash back, found by sha rather than by position.
 *
 * A pop that conflicts is reported, not thrown, and not treated as failing the
 * operation that ran in between: that operation succeeded, and the conflict is
 * between the user's own saved work and the result they asked for. git keeps
 * the entry when a pop conflicts, so nothing is lost either way.
 */
export async function stashRestore(cwd: string, sha: string): Promise<StashRestore> {
  const entry = (await listEntries(cwd)).find((e) => e.sha === sha);
  if (!entry) {
    return { kind: 'missing' };
  }

  const result = await run('git', ['stash', 'pop', entry.selector], cwd);
  if (result.code === 0) {
    return { kind: 'restored' };
  }

  // Distinguished by the tree, not by parsing git's prose: if the entry is
  // still listed, the pop refused to drop it, which is what a conflict does.
  const survived = (await listEntries(cwd)).some((e) => e.sha === sha);
  if (survived && (await hasUnmerged(cwd))) {
    return { kind: 'conflict', selector: entry.selector };
  }
  return {
    kind: 'failed',
    message: firstLine(result.stderr) || 'git stash pop failed.',
    selector: survived ? entry.selector : undefined,
  };
}

/** Where a recorded stash sits now, for a message that has to name it. */
export async function stashSelector(cwd: string, sha: string): Promise<string | undefined> {
  return (await listEntries(cwd)).find((e) => e.sha === sha)?.selector;
}

async function listEntries(cwd: string): Promise<Entry[]> {
  const result = await run('git', ['stash', 'list', '--format=%H %gd'], cwd);
  if (result.code !== 0) {
    return [];
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha = '', selector = ''] = line.split(' ');
      return { sha, selector };
    })
    .filter((entry) => entry.sha && entry.selector);
}

async function hasUnmerged(cwd: string): Promise<boolean> {
  const result = await run('git', ['diff', '--name-only', '--diff-filter=U'], cwd);
  return result.stdout.trim().length > 0;
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.trim() ?? '';
}
