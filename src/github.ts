import { runCommand } from './apply.ts';
import type { BranchPr, GithubGraph, RemoteStack, RemotePrEntry } from './model.ts';

/**
 * What GitHub says about this repository's stacks, over GraphQL.
 *
 * `gh stack view` reports the stack HEAD is in; `.git/gh-stack` reports the
 * stacks this clone has ever recorded. Neither can see a stack that exists only
 * on GitHub — a colleague's, or your own from another machine — and neither
 * knows that someone appended a PR to your stack on the server.
 *
 * GitHub models stacks natively: `PullRequest.stack` is a `PullRequestStack`
 * with a number, a size, a base ref, and positioned entries. Verified against
 * the live API in July 2026. `gh pr list --json` does not offer the field, so
 * this goes through `gh api graphql` — which resolves `{owner}`/`{repo}` from
 * the local remote, so there is no repository to look up first.
 *
 * Split like parse.ts / stack.ts: `parseGraph` is pure and testable against
 * recorded responses, `readGithubGraph` is the one function that spawns.
 *
 * Nothing here throws or rejects. Every failure — no remote, not signed in,
 * offline, rate-limited, a GHES too old to know what a stack is — yields an
 * empty graph, and the view simply says nothing about the remote. See
 * `supported` for the one failure that is worth distinguishing.
 */

/** Page size. Two pages matches `gh pr list --limit 200` in stacks.ts. */
const PAGE_SIZE = 100;
const MAX_PAGES = 2;

/**
 * Entries fetched per stack. A stack this long is already beyond what the
 * switcher can render legibly; truncation is logged rather than hidden.
 */
const ENTRY_LIMIT = 50;

/** 30s, matching the `gh pr list` call this replaces. */
const TIMEOUT_MS = 30_000;

const QUERY = `query($cursor: String) {
  repository(owner: "{owner}", name: "{repo}") {
    pullRequests(first: ${PAGE_SIZE}, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number headRefName baseRefName title url state isDraft
        stack {
          number size baseRefName
          entries(first: ${ENTRY_LIMIT}) {
            totalCount
            nodes { position pullRequest { number headRefName state } }
          }
        }
      }
    }
  }
}`;

/** An empty graph: what every failure degrades to. `supported` stays true. */
export function emptyGraph(): GithubGraph {
  return { prs: new Map(), stacks: new Map(), supported: true, truncated: [] };
}

/**
 * Ask GitHub for this repository's pull requests and their stacks.
 *
 * Paginates by hand rather than with `gh api --paginate`, which concatenates
 * whole response documents and would need the same merge logic anyway. Stops
 * early on the first page that fails, keeping what it already has: half the
 * badges beats none.
 */
export async function readGithubGraph(cwd: string, ghPath: string): Promise<GithubGraph> {
  const graph = emptyGraph();
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const args = ['api', 'graphql', '-f', `query=${QUERY}`];
    if (cursor) {
      args.push('-F', `cursor=${cursor}`);
    }

    const result = await runCommand(ghPath, args, cwd, TIMEOUT_MS);
    // `gh api graphql` exits 1 on a GraphQL error but still prints the body,
    // which is where `undefinedField` lives — so parse regardless of the code.
    const parsed = parseGraph(result.stdout);

    if (!parsed.supported) {
      // An API that does not know what a stack is. Distinguished from an empty
      // result so the caller can fall back to `gh pr list` and keep the PR
      // badges Restack has always shown.
      return { ...emptyGraph(), supported: false };
    }

    mergeInto(graph, parsed);

    if (!parsed.nextCursor) {
      break;
    }
    cursor = parsed.nextCursor;
  }

  return graph;
}

/** First-wins merge, so page 1 (the more recent) keeps precedence. */
function mergeInto(into: GithubGraph, from: GithubGraph): void {
  for (const [branch, pr] of from.prs) {
    if (!into.prs.has(branch)) {
      into.prs.set(branch, pr);
    }
  }
  for (const [number, stack] of from.stacks) {
    if (!into.stacks.has(number)) {
      into.stacks.set(number, stack);
    }
  }
  for (const number of from.truncated) {
    if (!into.truncated.includes(number)) {
      into.truncated.push(number);
    }
  }
}

/** A parsed page, plus the cursor that continues it. */
interface ParsedPage extends GithubGraph {
  nextCursor?: string;
}

/**
 * Parse one `gh api graphql` response document.
 *
 * Tolerant in parse.ts's spirit, and for a sharper reason: this is a
 * pre-release field on a service that will keep moving. A renamed field
 * degrades one badge; it must never take out the PR index alongside it. So
 * every field is read defensively and a node missing its essentials is skipped
 * rather than thrown on.
 */
export function parseGraph(raw: string): ParsedPage {
  const empty: ParsedPage = emptyGraph();

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    // Not JSON at all: `gh` printing an auth or network error, or nothing.
    return empty;
  }
  if (!isRecord(data)) {
    return empty;
  }

  if (mentionsUnknownStackField(data.errors)) {
    return { ...empty, supported: false };
  }

  const connection = asRecord(
    asRecord(asRecord(asRecord(data.data)?.repository)?.pullRequests),
  );
  if (!connection) {
    return empty;
  }

  const nodes = Array.isArray(connection.nodes) ? connection.nodes : [];
  const prs = new Map<string, BranchPr>();
  const stacks = new Map<number, RemoteStack>();
  const truncated: number[] = [];

  for (const node of nodes) {
    if (!isRecord(node)) {
      continue;
    }
    const branch = asString(node.headRefName);
    const number = asNumber(node.number);
    if (!branch || !number) {
      continue;
    }

    const stack = parseStack(node.stack, truncated);
    if (stack && !stacks.has(stack.number)) {
      stacks.set(stack.number, stack);
    }

    // First wins, as in stacks.ts: GitHub returns newest first, and the newest
    // PR for a branch is the one a badge should be talking about.
    if (prs.has(branch)) {
      continue;
    }
    prs.set(branch, {
      number,
      url: asString(node.url) ?? '',
      title: asString(node.title) ?? '',
      state: (asString(node.state) ?? 'open').toLowerCase(),
      isDraft: node.isDraft === true,
      baseRefName: asString(node.baseRefName),
      stackNumber: stack?.number,
      stackSize: stack?.size,
    });
  }

  const pageInfo = asRecord(connection.pageInfo);
  const nextCursor =
    pageInfo?.hasNextPage === true ? asString(pageInfo.endCursor) : undefined;

  return { prs, stacks, supported: true, nextCursor, truncated };
}

/**
 * A `PullRequestStack`, with its entries in stack order.
 *
 * Sorted by `position` ascending — bottom-to-top, the same direction
 * `Stack.branches` and `LocalStackSummary.branches` run in, so a remote stack
 * and a local one can be compared and rendered without either being reversed.
 * GitHub appears to return them in order already; sorting makes that a
 * guarantee rather than an observation.
 */
function parseStack(value: unknown, truncated: number[]): RemoteStack | undefined {
  const raw = asRecord(value);
  if (!raw) {
    return undefined;
  }
  const number = asNumber(raw.number);
  if (!number) {
    return undefined;
  }

  const connection = asRecord(raw.entries);
  const nodes = Array.isArray(connection?.nodes) ? connection.nodes : [];

  const entries: RemotePrEntry[] = [];
  for (const node of nodes) {
    if (!isRecord(node)) {
      continue;
    }
    const pr = asRecord(node.pullRequest);
    const prNumber = asNumber(pr?.number);
    const headRefName = asString(pr?.headRefName);
    if (!pr || !prNumber || !headRefName) {
      continue;
    }
    entries.push({
      position: asNumber(node.position) ?? entries.length + 1,
      number: prNumber,
      headRefName,
      state: (asString(pr.state) ?? 'open').toLowerCase(),
    });
  }
  entries.sort((a, b) => a.position - b.position);

  const total = asNumber(connection?.totalCount) ?? entries.length;
  if (total > entries.length) {
    truncated.push(number);
  }

  return {
    number,
    size: asNumber(raw.size) ?? entries.length,
    baseRefName: asString(raw.baseRefName) ?? '',
    entries,
  };
}

/**
 * Whether the API rejected the query because it has never heard of stacks.
 *
 * The forward- and backward-compatibility hinge. GitHub Enterprise Server
 * trails github.com by months, so a query naming `stack` is an error there,
 * not an empty result — and an error that took the PR badges down with it
 * would be a regression on a feature that has always worked. Matched on the
 * machine-readable `undefinedField` code and the field name, so an unrelated
 * error (rate limit, permissions) is not mistaken for it.
 */
function mentionsUnknownStackField(errors: unknown): boolean {
  if (!Array.isArray(errors)) {
    return false;
  }
  return errors.some((error) => {
    if (!isRecord(error)) {
      return false;
    }
    const code = asString(asRecord(error.extensions)?.code);
    const field = asString(asRecord(error.extensions)?.fieldName);
    if (code === 'undefinedField') {
      return true;
    }
    // Older servers phrase it in prose only.
    return field === 'stack' || /doesn't exist on type 'PullRequest'/.test(asString(error.message) ?? '');
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
