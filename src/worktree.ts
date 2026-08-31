import { run, type RunResult } from './git.ts';

/**
 * The two index writes the working-tree section makes, split out from the
 * operation that calls them.
 *
 * Here rather than in `view/operations/worktree.ts` for one reason: that module
 * imports `vscode`, which does not resolve under `node --test`, and these are
 * the halves worth testing against a real repository. Same split `changes.ts`
 * has between its parsers and the code that spawns.
 *
 * They go through `git.ts`'s `run` rather than the unlogged helper in
 * `changes.ts`, because unlike the reads there these *write* — and every write
 * Restack makes belongs in the output channel.
 */

/** Stage `paths`, or the whole tree when the list is empty. */
export async function stagePaths(cwd: string, paths: string[]): Promise<RunResult> {
  // `-A` rather than `-u` for the empty case: the section lists untracked files,
  // so "Stage all" that skipped them would contradict what is on screen.
  const args = paths.length === 0 ? ['add', '-A'] : ['add', '--', ...paths];
  return run('git', args, cwd);
}

/**
 * Unstage `paths`, or the whole index when the list is empty.
 *
 * `git restore --staged` rather than `git reset`: it is the porcelain for
 * exactly this, it leaves the working tree alone by definition, and it handles
 * a newly-added path — which has no HEAD version — without the special case
 * `reset HEAD -- <path>` needs on an unborn branch.
 */
export async function unstagePaths(cwd: string, paths: string[]): Promise<RunResult> {
  const args =
    paths.length === 0 ? ['restore', '--staged', '.'] : ['restore', '--staged', '--', ...paths];
  return run('git', args, cwd);
}
