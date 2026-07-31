import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCommand, firstLine, gitCommonDir } from './apply.ts';
import { initArgs } from './plan.ts';
import type { LocalStackSummary } from './model.ts';

/**
 * Creating a stack, for the case Restack used to have no answer for: a
 * repository where no stack exists yet.
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
