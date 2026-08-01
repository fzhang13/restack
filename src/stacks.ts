import { runCommand } from './apply.ts';
import { emptyGraph } from './github.ts';
import { readLocalStacks } from './init.ts';
import { readAllTracking } from './remote.ts';
import type {
  BranchPr,
  GithubGraph,
  LocalStackSummary,
  RemoteStack,
  RemoteStackSummary,
  StackDivergence,
  StackSummary,
  Tracking,
} from './model.ts';

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
 * The fallback path. `readGithubGraph` in github.ts supersedes this and returns
 * strictly more — the same PRs plus the stacks they belong to — but it names
 * `PullRequest.stack`, which a GitHub Enterprise Server behind github.com does
 * not have. This is what runs there, so an old server loses the stack badges
 * and keeps the PR badges it has always had.
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
 * `github` is passed in rather than fetched here so the caller controls when
 * the network is touched. refresh() runs on every `.git/HEAD` change — which
 * means once per rebase step during an apply — and a call per step would be
 * dozens per reorder.
 */
export async function readStackSummaries(
  cwd: string,
  active: string[],
  github: GithubGraph = emptyGraph(),
): Promise<StackSummary[]> {
  const recorded = await readLocalStacks(cwd);
  if (recorded.length === 0) {
    return [];
  }

  const tracking = await readAllTracking(cwd);
  const wanted = new Set(active);

  return recorded.map((stack, i) => {
    const counts = stack.branches.map((name) => tracking.get(name)).filter(isTracked);
    const remoteStackNumber = matchRemoteStack(stack, github.prs);
    const remote = remoteStackNumber ? github.stacks.get(remoteStackNumber) : undefined;
    const divergence = remote ? computeDivergence(stack.branches, remote) : undefined;

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
          .map((name) => [name, github.prs.get(name)] as const)
          .filter((pair): pair is [string, BranchPr] => pair[1] !== undefined),
      ),
      ahead: counts.reduce((total, t) => total + t.ahead, 0),
      behind: counts.reduce((total, t) => total + t.behind, 0),
      remoteStackNumber,
      // Omitted when the two agree, so the UI can treat its presence as the
      // signal rather than having to inspect two empty arrays.
      divergence:
        divergence && (divergence.onlyRemote.length > 0 || divergence.onlyLocal.length > 0)
          ? divergence
          : undefined,
    };
  });
}

/**
 * The GitHub stack a local stack's PRs belong to, if they agree on one.
 *
 * Exactly one distinct stack number across the branches, or nothing. Zero is
 * the ordinary case for a stack never submitted. Several is the interesting
 * refusal: a local stack whose branches sit in two GitHub stacks is the same
 * ambiguity gh-stack rejects with `branch %q belongs to multiple stacks`, and
 * picking one to badge would be a guess presented as a fact.
 */
export function matchRemoteStack(
  stack: LocalStackSummary,
  prs: Map<string, BranchPr>,
): number | undefined {
  const numbers = new Set<number>();
  for (const branch of stack.branches) {
    const number = prs.get(branch)?.stackNumber;
    if (number) {
      numbers.add(number);
    }
  }
  return numbers.size === 1 ? [...numbers][0] : undefined;
}

/**
 * What each side has that the other does not.
 *
 * Merged entries are excluded, for the reason `isTracked` excludes `gone`
 * branches: a PR that merged and had its branch deleted is the normal end of a
 * stack's life, not drift. Closed entries are excluded on the same grounds —
 * there is no branch to pull down and nothing to reconcile.
 */
export function computeDivergence(
  localBranches: string[],
  remote: RemoteStack,
): StackDivergence {
  const local = new Set(localBranches);
  const live = remote.entries.filter((e) => isLive(e.state));
  const remoteRefs = new Set(live.map((e) => e.headRefName));

  return {
    onlyRemote: live.filter((e) => !local.has(e.headRefName)).map((e) => e.headRefName),
    onlyLocal: localBranches.filter((name) => !remoteRefs.has(name)),
  };
}

/** A PR still worth reconciling against. `gh pr list` lowercases these. */
function isLive(state: string): boolean {
  const normalized = state.toLowerCase();
  return normalized !== 'merged' && normalized !== 'closed';
}

/**
 * GitHub stacks with no counterpart in this clone.
 *
 * "No counterpart" is any local stack sharing a single branch name, not an
 * exact match: a stack half checked out is one you already have, and offering
 * to check it out again would be offering to redo work. Divergence on a stack
 * you do have is reported on its own row instead.
 *
 * Fully merged stacks are dropped, which is what `gh stack checkout`'s own
 * interactive picker does — there is nothing left to work on.
 */
export function remoteOnlyStacks(
  github: GithubGraph,
  local: LocalStackSummary[],
): RemoteStackSummary[] {
  const claimed = new Set(local.flatMap((s) => s.branches));

  const summaries: RemoteStackSummary[] = [];
  for (const stack of github.stacks.values()) {
    if (stack.entries.some((e) => claimed.has(e.headRefName))) {
      continue;
    }
    const live = stack.entries.filter((e) => isLive(e.state));
    // The bottom-most open PR: checkout resolves the whole stack from any of
    // its PRs, and a merged one may have had its branch deleted on the remote.
    const checkoutPr = live[0]?.number;
    if (!checkoutPr) {
      continue;
    }
    summaries.push({
      number: stack.number,
      baseRefName: stack.baseRefName,
      entries: stack.entries,
      checkoutPr,
    });
  }

  return summaries.sort((a, b) => a.number - b.number);
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
