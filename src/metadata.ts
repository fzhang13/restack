/**
 * Rewriting gh-stack's own state file, `.git/gh-stack`.
 *
 * Why this exists: `git rebase` moves branch refs but leaves that file
 * untouched. Verified against gh-stack v0.1.0 — after rebasing a stack into a
 * new order by hand, `gh stack view` still printed the *old* order with a drift
 * marker, and the recorded base SHAs were unchanged. Since `gh stack submit`
 * retargets PR bases from this file, submitting on top of stale state would
 * point PRs at the wrong parents.
 *
 * So Restack writes the file. That is a real liability: schemaVersion is 1,
 * gh-stack is pre-1.0, and this is another tool's data. Three mitigations:
 *
 *   1. The version is checked up front and an unrecognized one aborts rather
 *      than guessing.
 *   2. Every key we do not understand is carried through untouched, at both the
 *      document and per-branch level, so a field we have never seen survives.
 *   3. The caller snapshots the original bytes before we touch anything and
 *      restores them on abort.
 *
 * Note the on-disk shape differs from `gh stack view --json`: entries are keyed
 * `branch`/`base` here, `name`/`base` there. parse.ts handles the latter.
 */

/** The only schemaVersion this code has been verified against. */
export const SUPPORTED_SCHEMA_VERSION = 1;

export interface BranchBase {
  branch: string;
  /** SHA of the tip this branch now sits on. */
  base: string;
}

export interface MetadataUpdate {
  trunk: string;
  /** Resolved trunk tip; also the base of the bottom branch. */
  trunkHead: string;
  /** Bottom-to-top, matching the proposed order. */
  branches: BranchBase[];
  /**
   * Names to *find* the stack by, when they differ from the names being
   * written — i.e. when a branch is joining or leaving the stack.
   *
   * Defaults to the written names, so a pure reorder is unaffected. The
   * matching itself stays exact-set (see findStackIndex); only the set being
   * matched against changes. The caller passes the pre-apply branch list, which
   * is what is still on disk at the moment of the write.
   */
  match?: string[];
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Find the stack in `stacks[]` holding exactly `names`.
 *
 * Exact set equality rather than "contains": a subset match could silently
 * rewrite a different stack that happens to share branch names, and writing the
 * wrong stack is far worse than refusing.
 */
export function findStackIndex(stacks: unknown[], names: string[]): number {
  const wanted = new Set(names);
  return stacks.findIndex((stack) => {
    if (!isRecord(stack) || !Array.isArray(stack.branches)) {
      return false;
    }
    const found = new Set(
      stack.branches
        .map((b) => (isRecord(b) && typeof b.branch === 'string' ? b.branch : undefined))
        .filter((b): b is string => b !== undefined),
    );
    return found.size === wanted.size && [...wanted].every((n) => found.has(n));
  });
}

/**
 * Return `raw` with the matching stack reordered and its base SHAs updated.
 *
 * Throws rather than writing anything questionable — the caller treats any
 * throw here as "abort and roll back the rebases".
 */
export function rewriteMetadata(raw: string, update: MetadataUpdate): string {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('.git/gh-stack is not valid JSON. Refusing to overwrite it.');
  }

  if (!isRecord(data)) {
    throw new Error('.git/gh-stack has an unexpected shape. Refusing to overwrite it.');
  }

  if (data.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    throw new Error(
      `.git/gh-stack is schemaVersion ${String(data.schemaVersion)}; Restack only ` +
        `writes version ${SUPPORTED_SCHEMA_VERSION}. Reorder with \`gh stack modify\` instead.`,
    );
  }

  if (!Array.isArray(data.stacks)) {
    throw new Error('.git/gh-stack has no stacks array. Refusing to overwrite it.');
  }

  const names = update.match ?? update.branches.map((b) => b.branch);
  const index = findStackIndex(data.stacks, names);
  if (index < 0) {
    throw new Error(
      'Could not find this stack in .git/gh-stack. It may have changed since Restack ' +
        'read it — refresh and try again.',
    );
  }

  const stack = data.stacks[index] as Json;
  const existing = new Map(
    (stack.branches as unknown[]).map((b) => {
      const entry = b as Json;
      return [entry.branch as string, entry];
    }),
  );

  // Spread each original entry so fields we do not model survive the rewrite.
  stack.branches = update.branches.map(({ branch, base }) => ({
    ...(existing.get(branch) ?? {}),
    branch,
    base,
  }));

  stack.trunk = {
    ...(isRecord(stack.trunk) ? stack.trunk : {}),
    branch: update.trunk,
    head: update.trunkHead,
  };

  // gh-stack writes 2-space indent with no trailing newline; match it so a
  // diff of this file shows the reorder and nothing else.
  return JSON.stringify(data, null, 2);
}

/**
 * Base SHA for each branch in a proposed order: the bottom branch sits on
 * trunk, and every branch above sits on the resolved tip of the one below.
 */
export function basesForOrder(
  order: string[],
  trunkHead: string,
  tipOf: (branch: string) => string | undefined,
): BranchBase[] {
  return order.map((branch, i) => {
    if (i === 0) {
      return { branch, base: trunkHead };
    }
    const parent = order[i - 1];
    const base = tipOf(parent);
    if (!base) {
      throw new Error(`Could not resolve the new tip of ${parent}.`);
    }
    return { branch, base };
  });
}
