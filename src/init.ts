import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCommand, firstLine, gitCommonDir, hasOrigin } from './apply.ts';
import { addArgs, initArgs, unstackArgs } from './plan.ts';
import type { LocalStackSummary } from './model.ts';

/**
 * Creating and removing a stack, for the cases Restack used to have no answer
 * for: a repository where no stack exists yet, and a stack the user wants gone.
 *
 * `gh stack init` does the work. What lives here is everything around it —
 * guessing a trunk, listing the stacks already on disk, and refusing the
 * command before it can leave a mess. Verified against gh-stack v0.1.0:
 *
 *   - With no arguments it exits 5, "interactive input required", so branch
 *     names must always be passed.
 *   - `--base` is not validated; a typo'd trunk creates a stack based on a
 *     branch that does not exist.
 *   - It checks out the top branch last, and if a dirty working tree blocks
 *     that checkout it fails *after* writing `.git/gh-stack` — leaving a stack
 *     whose top branch was never checked out. Hence the dirty-tree refusal in
 *     initPreflight, which is the one guard that prevents a half-made stack.
 *
 * Like stack.ts, nothing here throws: every failure becomes a value the UI can
 * render.
 */

/** What the empty state needs to offer a sensible default. */
export interface TrunkInfo {
  trunk: string;
  /** Every local branch, so the view can offer a different base. */
  localBranches: string[];
}

/**
 * Guess the trunk a new stack should sit on.
 *
 * In order of authority: what the remote says its default branch is, what
 * gh-stack already recorded for an existing stack in this repository (matching
 * it beats guessing), the configured default for new repositories, then the
 * conventional names. Falls back to `main` so the caller always has something
 * to show; initPreflight is what refuses a trunk that does not resolve.
 */
export async function detectTrunk(cwd: string): Promise<TrunkInfo> {
  const localBranches = await listLocalBranches(cwd);
  const has = (name: string) => localBranches.includes(name);

  const remoteHead = await runCommand(
    'git',
    ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
    cwd,
  );
  if (remoteHead.code === 0) {
    // `origin/main` -> `main`.
    const name = remoteHead.stdout.trim().replace(/^origin\//, '');
    if (name && has(name)) {
      return { trunk: name, localBranches };
    }
  }

  const recorded = (await readLocalStacks(cwd)).find((s) => has(s.trunk));
  if (recorded) {
    return { trunk: recorded.trunk, localBranches };
  }

  const configured = await runCommand('git', ['config', '--get', 'init.defaultBranch'], cwd);
  const fromConfig = configured.code === 0 ? configured.stdout.trim() : '';
  if (fromConfig && has(fromConfig)) {
    return { trunk: fromConfig, localBranches };
  }

  return {
    trunk: ['main', 'master'].find(has) ?? localBranches[0] ?? 'main',
    localBranches,
  };
}

/**
 * Every stack recorded in `.git/gh-stack`.
 *
 * Tolerant in the same spirit as parse.ts: a missing, unreadable, or malformed
 * file yields an empty list. This only decides which empty state to render, so
 * degrading to "offer init" is always safe — whereas throwing would replace a
 * useful view with an error.
 */
export async function readLocalStacks(cwd: string): Promise<LocalStackSummary[]> {
  let raw: string;
  try {
    raw = await readFile(join(await gitCommonDir(cwd), 'gh-stack'), 'utf8');
  } catch {
    return [];
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }

  if (typeof data !== 'object' || data === null) {
    return [];
  }
  const stacks = (data as Record<string, unknown>).stacks;
  if (!Array.isArray(stacks)) {
    return [];
  }

  const summaries: LocalStackSummary[] = [];
  for (const entry of stacks) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const stack = entry as Record<string, unknown>;
    const trunkField = stack.trunk;
    const trunk =
      typeof trunkField === 'string'
        ? trunkField
        : typeof trunkField === 'object' && trunkField !== null
          ? String((trunkField as Record<string, unknown>).branch ?? '')
          : '';

    const branches = Array.isArray(stack.branches)
      ? stack.branches
          .map((b) =>
            typeof b === 'object' && b !== null
              ? (b as Record<string, unknown>).branch
              : undefined,
          )
          .filter((b): b is string => typeof b === 'string' && b.length > 0)
      : [];

    if (branches.length > 0) {
      summaries.push({ trunk: trunk || 'main', branches });
    }
  }

  return summaries;
}

/**
 * Refuse an init that would fail badly, or half-succeed.
 *
 * Mirrors preflight() in apply.ts: a message means stop, undefined means go.
 * Init rewrites no commits, so unlike an apply there is nothing to snapshot —
 * these checks are the whole safety story.
 */
export async function initPreflight(
  cwd: string,
  trunk: string,
  branches: string[],
): Promise<string | undefined> {
  const repo = await runCommand('git', ['rev-parse', '--is-inside-work-tree'], cwd);
  if (repo.code !== 0) {
    return 'Not a git repository.';
  }

  if (branches.length === 0) {
    // gh stack init with no arguments wants an interactive prompt it cannot
    // get from a webview, and exits 5.
    return 'Add at least one branch to the stack.';
  }

  const duplicate = branches.find((name, i) => branches.indexOf(name) !== i);
  if (duplicate) {
    return `${duplicate} appears in the stack twice.`;
  }

  if (branches.includes(trunk)) {
    return `${trunk} is the trunk, so it cannot also be a branch in the stack.`;
  }

  for (const name of branches) {
    const valid = await runCommand('git', ['check-ref-format', '--branch', name], cwd);
    if (valid.code !== 0) {
      return `${name} is not a valid branch name.`;
    }
  }

  // gh-stack does not check this: `gh stack init --base nope my-feature`
  // succeeds and records a trunk that does not exist.
  const trunkExists = await runCommand(
    'git',
    ['rev-parse', '--verify', `refs/heads/${trunk}`],
    cwd,
  );
  if (trunkExists.code !== 0) {
    return `Trunk ${trunk} does not exist locally.`;
  }

  // The load-bearing check. gh stack init finishes by checking out the top
  // branch; when a dirty file blocks that, it has already written
  // .git/gh-stack, leaving a stack in a state nobody asked for.
  const status = await runCommand('git', ['status', '--porcelain', '--untracked-files=no'], cwd);
  if (status.stdout.trim().length > 0) {
    return (
      'Working tree has uncommitted changes. Commit or stash them first — ' +
      '`gh stack init` checks out the top branch, and a dirty tree can leave the ' +
      'stack half-created.'
    );
  }

  return undefined;
}

/**
 * Run `gh stack init`. Returns an error message, or undefined on success.
 *
 * Goes through runCommand, so the full argv, exit code, and both streams land
 * in the Restack output channel like every other command.
 */
export async function runInit(
  cwd: string,
  ghPath: string,
  trunk: string,
  branches: string[],
): Promise<string | undefined> {
  const result = await runCommand(ghPath, initArgs(trunk, branches), cwd, 60_000);
  if (result.code === 0) {
    return undefined;
  }
  return (
    firstLine(result.stderr) ||
    firstLine(result.stdout) ||
    `gh ${initArgs(trunk, branches).join(' ')} failed.`
  );
}

/**
 * Refuse an add the stack is not in a state to take.
 *
 * Same contract as initPreflight. Verified against gh-stack v0.1.0, which is
 * stricter than init in one way and looser in another:
 *
 *   - It refuses anywhere but the top: `can only add branches to the top of
 *     the stack; run gh stack top then gh stack add`. The host checks the top
 *     branch out first, so that refusal never reaches the user — but it is why
 *     the dirty-tree guard below matters even though `add` itself does not
 *     check. A dirty tree blocks *our* checkout, not gh-stack's.
 *   - It does *not* refuse on a dirty tree. Adding with uncommitted changes
 *     sitting there succeeded and left them uncommitted on the new branch.
 *
 * `existing` is the stack's branch names; a name already in it would otherwise
 * be adopted a second time.
 */
export async function addPreflight(
  cwd: string,
  trunk: string,
  existing: string[],
  branch: string,
): Promise<string | undefined> {
  const repo = await runCommand('git', ['rev-parse', '--is-inside-work-tree'], cwd);
  if (repo.code !== 0) {
    return 'Not a git repository.';
  }

  if (!branch) {
    return 'Name the branch to add.';
  }

  if (branch === trunk) {
    return `${trunk} is the trunk, so it cannot also be a branch in the stack.`;
  }

  if (existing.includes(branch)) {
    return `${branch} is already in this stack.`;
  }

  const valid = await runCommand('git', ['check-ref-format', '--branch', branch], cwd);
  if (valid.code !== 0) {
    return `${branch} is not a valid branch name.`;
  }

  // Adding lands HEAD on the new branch, which means a checkout — two of them,
  // in fact, since we move to the top of the stack first.
  const priv = await runCommand('git', ['rev-parse', '--absolute-git-dir'], cwd);
  const dirs = [await gitCommonDir(cwd), priv.code === 0 ? priv.stdout.trim() : ''];
  if (dirs.some((d) => d && (existsSync(join(d, 'rebase-merge')) || existsSync(join(d, 'rebase-apply'))))) {
    return 'A rebase is in progress. Finish or abort it first (`git rebase --abort`).';
  }

  const status = await runCommand('git', ['status', '--porcelain', '--untracked-files=no'], cwd);
  if (status.stdout.trim().length > 0) {
    return (
      'Working tree has uncommitted changes. Commit or stash them first — ' +
      'adding a branch checks out the top of the stack, and a dirty tree blocks that.'
    );
  }

  return undefined;
}

/**
 * Run `gh stack add`. Returns an error message, or undefined on success.
 *
 * The caller is responsible for standing on the top branch first; see
 * addPreflight for why.
 */
export async function runAdd(
  cwd: string,
  ghPath: string,
  branch: string,
): Promise<string | undefined> {
  const result = await runCommand(ghPath, addArgs(branch), cwd, 60_000);
  if (result.code === 0) {
    return undefined;
  }
  return (
    firstLine(result.stderr) || firstLine(result.stdout) || `gh ${addArgs(branch).join(' ')} failed.`
  );
}

/** How far a removal reaches: the metadata file, or GitHub as well. */
export type UnstackScope = 'local' | 'remote';

/**
 * Refuse a removal the repository is not in a state to survive.
 *
 * Same contract as initPreflight: a message means stop. Unstacking rewrites no
 * commits and moves no branch refs, so there is nothing to snapshot and nothing
 * an undo would have to put back — but gh-stack can still check out a branch on
 * its way through, which is what the dirty-tree guard is for.
 */
export async function unstackPreflight(
  cwd: string,
  scope: UnstackScope,
): Promise<string | undefined> {
  const repo = await runCommand('git', ['rev-parse', '--is-inside-work-tree'], cwd);
  if (repo.code !== 0) {
    return 'Not a git repository.';
  }

  const gitDir = await gitCommonDir(cwd);
  if (!existsSync(join(gitDir, 'gh-stack'))) {
    return 'No .git/gh-stack file, so there is no stack to remove.';
  }

  // A half-finished rebase plus a deleted stack record is a state nothing here
  // can unwind: the record of where the branches were going is gone.
  //
  // Checked before the working tree, unlike preflight in apply.ts. A rebase
  // paused on a conflict leaves unmerged files, so the dirty-tree message below
  // would fire first and name a symptom instead of the cause.
  const priv = await runCommand('git', ['rev-parse', '--absolute-git-dir'], cwd);
  const dirs = [gitDir, priv.code === 0 ? priv.stdout.trim() : gitDir];
  if (dirs.some((d) => existsSync(join(d, 'rebase-merge')) || existsSync(join(d, 'rebase-apply')))) {
    return 'A rebase is in progress. Finish or abort it first (`git rebase --abort`).';
  }

  // gh-stack's unstack path can move HEAD — its failures include
  // "failed to checkout branch" and "failed to restore branch" — so the same
  // reasoning as init applies: a dirty tree can strand it partway.
  const status = await runCommand('git', ['status', '--porcelain', '--untracked-files=no'], cwd);
  if (status.stdout.trim().length > 0) {
    return (
      'Working tree has uncommitted changes. Commit or stash them first — ' +
      '`gh stack unstack` may check out a branch, and a dirty tree can block it partway.'
    );
  }

  if (scope === 'remote' && !(await hasOrigin(cwd))) {
    return 'No `origin` remote, so there are no pull requests to unstack.';
  }

  return undefined;
}

/**
 * Run `gh stack unstack`. Returns an error message, or undefined on success.
 *
 * Success is not the same as "the stack is gone": GitHub refuses to unstack PRs
 * that are queued or have auto-merge enabled, and gh-stack then keeps the stack
 * — including local tracking — while still exiting zero. The caller re-reads the
 * stack afterwards rather than trusting the exit code.
 */
export async function runUnstack(
  cwd: string,
  ghPath: string,
  local: boolean,
): Promise<string | undefined> {
  const args = unstackArgs(local);
  // A remote unstack goes through the GitHub API; give it the same headroom the
  // push and submit steps get.
  const result = await runCommand(ghPath, args, cwd, local ? 60_000 : 180_000);
  if (result.code === 0) {
    return undefined;
  }
  return (
    firstLine(result.stderr) || firstLine(result.stdout) || `gh ${args.join(' ')} failed.`
  );
}

async function listLocalBranches(cwd: string): Promise<string[]> {
  const result = await runCommand(
    'git',
    ['for-each-ref', '--format=%(refname:short)', 'refs/heads'],
    cwd,
  );
  return result.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}
