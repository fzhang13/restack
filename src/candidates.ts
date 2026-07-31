import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CandidateBranch, Stack } from './model.ts';

const execFileAsync = promisify(execFile);

/**
 * Local branches that are not in the stack but could be dropped into it.
 *
 * gh-stack knows nothing about these, so there is no recorded base SHA to
 * anchor a rebase to. We compute one ourselves — `git merge-base <branch>
 * <trunk>` — which is the same thing gh-stack's `base` field means for a branch
 * sitting directly on trunk: the commit the branch's own work starts after.
 * plan.ts then treats it exactly like any other recorded base, so the
 * recorded-SHA invariant extends to inserted branches unchanged.
 *
 * Never rejects: a repository we cannot enumerate yields an empty tray rather
 * than breaking the whole view.
 */
export async function readCandidates(cwd: string, stack: Stack): Promise<CandidateBranch[]> {
  const names = await localBranches(cwd);
  if (names.length === 0) {
    return [];
  }

  const inStack = new Set(stack.branches.map((b) => b.name));
  const candidates: CandidateBranch[] = [];

  for (const name of names) {
    if (name === stack.trunk || inStack.has(name)) {
      continue;
    }

    // Fully merged into trunk: rebasing it would replay nothing, so it is not
    // a meaningful stack member. This also filters out the long tail of stale
    // local branches that would otherwise dominate the tray.
    if (await isAncestor(cwd, name, stack.trunk)) {
      continue;
    }

    const base = await mergeBase(cwd, name, stack.trunk);
    if (!base) {
      continue; // No shared history with trunk; nothing sane to rebase onto.
    }

    candidates.push({ name, base, commitCount: await countCommits(cwd, stack.trunk, name) });
  }

  return candidates;
}

async function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, timeout: 15_000 });
    return { code: 0, stdout };
  } catch (err) {
    const code = (err as { code?: number | string }).code;
    return { code: typeof code === 'number' ? code : 1, stdout: '' };
  }
}

async function localBranches(cwd: string): Promise<string[]> {
  const result = await git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  return result.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

async function isAncestor(cwd: string, branch: string, trunk: string): Promise<boolean> {
  const result = await git(cwd, ['merge-base', '--is-ancestor', branch, trunk]);
  return result.code === 0;
}

async function mergeBase(cwd: string, branch: string, trunk: string): Promise<string | undefined> {
  const result = await git(cwd, ['merge-base', branch, trunk]);
  const sha = result.stdout.trim();
  return result.code === 0 && sha.length > 0 ? sha : undefined;
}

async function countCommits(cwd: string, trunk: string, branch: string): Promise<number> {
  const result = await git(cwd, ['rev-list', '--count', `${trunk}..${branch}`]);
  const n = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}
