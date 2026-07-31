import { runCommand } from './apply.ts';
import { readLocalStacks } from './init.ts';
import { readAllTracking } from './remote.ts';
import type { BranchPr, StackSummary, Tracking } from './model.ts';

/**
 * Every stack in the repository, not just the one HEAD is standing in.
 *
 * `gh stack view --json` is HEAD-scoped by design — it reports the stack the
 * current branch belongs to and exits 2 for everything else, which is why a
 * repository full of stacks and one with none used to look identical to
 * Restack. gh-stack itself models many stacks per repository: `.git/gh-stack`
 * holds a `stacks` array, `gh stack checkout` resolves a stack *number* before
 * anything else, and the binary carries errors like `branch %q belongs to
 * multiple stacks`.
 *
 * So the switcher is built from the file rather than from `gh stack view`. That
 * costs the per-branch detail only gh-stack can compute — recorded base SHAs
 * and `needsRebase` — which is exactly why switching stacks is a checkout: once
 * HEAD is inside one, the ordinary read reports it in full.
 *
 * Nothing here throws. A stack list that fails to load would replace a working
 * view with an error, and every caller can render a degraded row.
 */

/** Fields asked of `gh pr list`; matched to branches on `headRefName`. */
const PR_FIELDS = 'number,headRefName,state,title,url,isDraft';

/** PRs keyed by head branch name. Empty means "we could not ask", not "none". */
export type PrIndex = Map<string, BranchPr>;

/**
 * Ask GitHub for this repository's pull requests, in one call.
 *
 * One call rather than one per stack: the switcher badges every stack at once,
 * and `gh pr list` has no way to filter by a set of head refs anyway. `--state
 * all` because a merged PR is the most interesting thing a switcher row can say
 * about a stack — it is the one that wants cleaning up.
 *
 * Returns an empty index for every failure mode, which are more numerous than
 * usual here: no remote (exit 0 with a plain-text `no git remotes found`), not
 * authenticated, offline, rate-limited, or a repository whose PRs we cannot
 * read. None of those are worth an error state in a stack switcher.
 */
export async function readPullRequests(cwd: string, ghPath: string): Promise<PrIndex> {
  const index: PrIndex = new Map();

  const result = await runCommand(
    ghPath,
    ['pr', 'list', '--state', 'all', '--limit', '200', '--json', PR_FIELDS],
    cwd,
    30_000,
  );
  if (result.code !== 0) {
    return index;
  }

  let data: unknown;
  try {
    data = JSON.parse(result.stdout);
  } catch {
    // `gh pr list` exits 0 and prints `no git remotes found` as bare text when
    // the repository has no remote — not JSON, and not a failure either.
    return index;
  }
  if (!Array.isArray(data)) {
    return index;
  }

  for (const entry of data) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const pr = entry as Record<string, unknown>;
    const branch = typeof pr.headRefName === 'string' ? pr.headRefName : '';
    const number = typeof pr.number === 'number' ? pr.number : 0;
    if (!branch || !number) {
      continue;
    }

    // `--state all` returns closed and merged PRs too, and a branch can have
    // several over its life. The first one wins: gh lists newest first, and the
    // newest is the one a switcher row should be talking about.
    if (index.has(branch)) {
      continue;
    }

    index.set(branch, {
      number,
      url: typeof pr.url === 'string' ? pr.url : '',
      title: typeof pr.title === 'string' ? pr.title : '',
      state: typeof pr.state === 'string' ? pr.state.toLowerCase() : 'open',
      isDraft: pr.isDraft === true,
    });
  }

  return index;
}

/**
 * Summarise every recorded stack, marking the one HEAD is in.
 *
 * `active` is the branch list of the stack `gh stack view` just reported, or
 * empty when it reported nothing. Matching on it is exact-set equality rather
 * than "contains", for findStackIndex's reason: two stacks can share a branch
 * name, and marking both active would let the switcher offer to check out the
 * stack you are already in.
 *
 * `prs` is passed in rather than fetched here so the caller controls when the
 * network is touched. refresh() runs on every `.git/HEAD` change — which means
 * once per rebase step during an apply — and a call per step would be dozens
 * per reorder.
 */
export async function readStackSummaries(
  cwd: string,
  active: string[],
  prs: PrIndex = new Map(),
): Promise<StackSummary[]> {
  const recorded = await readLocalStacks(cwd);
  if (recorded.length === 0) {
    return [];
  }

  const tracking = await readAllTracking(cwd);
  const wanted = new Set(active);

  return recorded.map((stack, i) => {
    const counts = stack.branches.map((name) => tracking.get(name)).filter(isTracked);

    return {
      ...stack,
      // 1-based, matching the number `gh stack checkout <n>` takes.
      index: i + 1,
      isActive:
        wanted.size > 0 &&
        wanted.size === stack.branches.length &&
        stack.branches.every((name) => wanted.has(name)),
      prs: Object.fromEntries(
        stack.branches
          .map((name) => [name, prs.get(name)] as const)
          .filter((pair): pair is [string, BranchPr] => pair[1] !== undefined),
      ),
      ahead: counts.reduce((total, t) => total + t.ahead, 0),
      behind: counts.reduce((total, t) => total + t.behind, 0),
    };
  });
}

/**
 * A branch whose upstream still exists.
 *
 * `gone` is excluded for the reason branchesBehind excludes it: a branch whose
 * remote was deleted after its PR merged is the normal end of a stack's life,
 * not something to count against it.
 */
function isTracked(t: Tracking | undefined): t is Tracking {
  return t !== undefined && !t.gone;
}

/**
 * The branch to check out to make `stack` the active one.
 *
 * The top: it is the only branch guaranteed to be in this stack and no other,
 * since a stack's trunk is routinely another stack's branch — and standing on
 * a shared branch is precisely the ambiguity gh-stack refuses with `branch %q
 * belongs to multiple stacks`.
 */
export function topBranchOf(stack: { branches: string[] }): string | undefined {
  return stack.branches[stack.branches.length - 1];
}
