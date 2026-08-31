import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BranchChanges, CommitSummary, FileChange, StatusGroups, WorkingTree } from './model.ts';

/**
 * Reading what a branch changed: its commits, their files, and the working
 * tree.
 *
 * The parsers here are exported separately from anything that spawns, so they
 * test against fixture strings with no repository — the same split parse.ts
 * has. Unlike parse.ts this module is *not* Node-free; it is not bundled into
 * the browser harness.
 */

/**
 * The `git log` format the parser below expects, as one constant so the two can
 * never disagree. `%x1f` is the unit separator: a commit message can contain a
 * tab or a newline, but not a NUL and not a 0x1f.
 */
export const COMMIT_FORMAT = '@@%H%x1f%h%x1f%s%x1f%an%x1f%ar';

/**
 * Parse `git log --format=COMMIT_FORMAT --name-status -M -z`.
 *
 * The layout, verified against git 2.50.1:
 *
 *     @@<sha>\x1f<short>\x1f<subject>\x1f<author>\x1f<date>\0\n<status>\0<path>\0…
 *
 * Two traps. The header is terminated by NUL *and then a newline*, so after
 * splitting on NUL the first status token of every commit arrives with a
 * leading `\n`. And a path may itself begin with `@@`, so a token is only read
 * as a header when the parser is not already expecting a path — detecting by
 * prefix alone would truncate the file list of any commit that touched one.
 */
export function parseCommitLog(raw: string): CommitSummary[] {
  const commits: CommitSummary[] = [];
  const tokens = raw.split('\0');

  /** Paths still owed to the status token just read: 1 normally, 2 for R/C. */
  let owed = 0;
  let status = '';
  let oldPath: string | undefined;

  for (const token of tokens) {
    // Only the first status of each commit carries this, but stripping
    // unconditionally is harmless: git never emits a status or a header with a
    // leading newline of its own.
    const value = token.startsWith('\n') ? token.slice(1) : token;

    if (owed > 0) {
      const current = commits[commits.length - 1];
      if (owed === 2) {
        oldPath = value;
        owed = 1;
        continue;
      }
      current?.files.push(
        oldPath === undefined
          ? { status, path: value }
          : { status, path: value, oldPath },
      );
      oldPath = undefined;
      owed = 0;
      continue;
    }

    if (value.length === 0) {
      continue; // Trailing NUL at the end of the stream.
    }

    if (value.startsWith('@@')) {
      const [sha, shortSha, subject, author, relativeDate] = value.slice(2).split('\x1f');
      commits.push({
        sha: sha ?? '',
        shortSha: shortSha ?? '',
        subject: subject ?? '',
        author: author ?? '',
        relativeDate: relativeDate ?? '',
        files: [],
      });
      continue;
    }

    // A status letter, possibly with a similarity score: R100, C75.
    status = value[0];
    owed = status === 'R' || status === 'C' ? 2 : 1;
  }

  return commits;
}

/**
 * Parse `git diff --name-status -M -z`.
 *
 * The same status/path grammar as the file half of parseCommitLog, without the
 * commit headers interleaved — hence a second, simpler pass rather than one
 * shared routine that would have to know whether headers are possible.
 */
export function parseNameStatus(raw: string): FileChange[] {
  const files: FileChange[] = [];
  const tokens = raw.split('\0').filter((t) => t.length > 0);

  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i][0];
    if (status === 'R' || status === 'C') {
      if (i + 2 >= tokens.length) break;
      files.push({ status, path: tokens[i + 2], oldPath: tokens[i + 1] });
      i += 3;
    } else {
      if (i + 1 >= tokens.length) break;
      files.push({ status, path: tokens[i + 1] });
      i += 2;
    }
  }

  return files;
}

/**
 * Parse `git status --porcelain=v1 -z`.
 *
 * `XY path` where X is the index state and Y the worktree state, so a file can
 * legitimately appear in both groups — `MM` is a staged edit with a further
 * unstaged one on top, and hiding either half would misreport what an amend is
 * about to fold in.
 *
 * With `-z` a rename emits `XY <new>\0<old>\0` — the new path *first*, the
 * reverse of the `old -> new` arrow the human-readable form prints.
 */
export function parseStatus(raw: string): StatusGroups {
  const groups: StatusGroups = { staged: [], unstaged: [], untracked: [] };
  const tokens = raw.split('\0');

  for (let i = 0; i < tokens.length; i += 1) {
    const entry = tokens[i];
    if (entry.length < 3) {
      continue; // Trailing NUL, or a truncated record.
    }
    const index = entry[0];
    const worktree = entry[1];
    const path = entry.slice(3);

    if (index === '?' || worktree === '?') {
      groups.untracked.push(path);
      continue;
    }

    // A rename consumes the following token as its original path.
    let oldPath: string | undefined;
    if (index === 'R' || index === 'C') {
      oldPath = tokens[i + 1];
      i += 1;
    }

    if (index !== ' ') {
      groups.staged.push(oldPath === undefined ? { status: index, path } : { status: index, path, oldPath });
    }
    if (worktree !== ' ') {
      groups.unstaged.push({ status: worktree, path });
    }
  }

  return groups;
}

const execFileAsync = promisify(execFile);

/**
 * Every read here declines to take `index.lock`.
 *
 * `git status` refreshes and rewrites `.git/index` when its stat information is
 * stale, and this module runs it on every document save. That lock would
 * collide with a git the user is running in their own terminal, and the error
 * would surface there rather than here. Nothing in this module writes, so
 * giving up the refresh costs nothing.
 *
 * No GIT_EDITOR or GIT_TERMINAL_PROMPT, matching candidates.ts: none of these
 * read-only subcommands can prompt.
 */
const PLUMBING_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };

/**
 * Unlogged, like the helper in candidates.ts and for the same stated reason:
 * these run per branch on every refresh, and that volume in the output channel
 * would bury the commands a user actually wants to read. Never rejects.
 */
async function plumbing(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      env: PLUMBING_ENV,
      timeout: 20_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return '';
  }
}

/**
 * Every local branch head, in one call.
 *
 * One `for-each-ref` rather than a `rev-parse` per branch: the tips are needed
 * for the cache key of every branch on every refresh, and N spawns to learn
 * something git will list in one is the difference between a badge that is free
 * and a badge that is not worth having.
 */
export async function readTips(cwd: string): Promise<Map<string, string>> {
  const out = await plumbing(cwd, [
    'for-each-ref',
    '--format=%(refname:short)%00%(objectname)',
    'refs/heads',
  ]);
  const tips = new Map<string, string>();
  for (const line of out.split('\n')) {
    const [name, sha] = line.trim().split('\0');
    if (name && sha) {
      tips.set(name, sha);
    }
  }
  return tips;
}

/**
 * Reads what each branch changed, and remembers it.
 *
 * Cached on `<branch>@<base>..<tip>`, so a refresh where nothing moved spawns
 * nothing and re-expanding a row is free. The key includes the base as well as
 * the tip because a rebase can move a branch's anchor without moving its head.
 */
export class ChangesReader {
  private readonly branches = new Map<string, BranchChanges>();
  private counts = new Map<string, number>();
  /** Incremented per child process, so tests can prove the cache is used. */
  spawns = 0;

  private async run(cwd: string, args: string[]): Promise<string> {
    this.spawns += 1;
    return plumbing(cwd, args);
  }

  async branchChanges(
    cwd: string,
    branch: string,
    base: string,
    tip: string,
  ): Promise<BranchChanges> {
    const key = `${branch}@${base}..${tip}`;
    const hit = this.branches.get(key);
    if (hit) {
      return hit;
    }

    const [log, diff] = await Promise.all([
      this.run(cwd, [
        'log',
        `--format=${COMMIT_FORMAT}`,
        '--name-status',
        '-M',
        '-z',
        `${base}..${tip}`,
      ]),
      this.run(cwd, ['diff', '--name-status', '-M', '-z', base, tip]),
    ]);

    const changes: BranchChanges = {
      branch,
      base,
      tip,
      commits: parseCommitLog(log),
      files: parseNameStatus(diff),
    };
    this.branches.set(key, changes);
    return changes;
  }

  async commitCounts(
    cwd: string,
    branches: Array<{ name: string; base: string }>,
    tips: Map<string, string>,
  ): Promise<Record<string, number>> {
    const result: Record<string, number> = {};
    /** Only the ranges this round asked for; becomes the whole cache below. */
    const seen = new Map<string, number>();

    for (const { name, base } of branches) {
      const tip = tips.get(name);
      if (!tip) {
        continue; // A branch gh-stack lists that no longer exists locally.
      }
      const key = `${base}..${tip}`;
      let count = this.counts.get(key) ?? seen.get(key);
      if (count === undefined) {
        const out = await this.run(cwd, ['rev-list', '--count', key]);
        const parsed = Number.parseInt(out.trim(), 10);
        if (!Number.isFinite(parsed)) {
          // The range did not resolve. Omit the branch rather than report a
          // zero: the badge renders nothing for a missing count, and "0 commits
          // of its own" is a failure dressed up as a fact. Not cached either —
          // a failure must not be remembered as an answer.
          continue;
        }
        count = parsed;
      }
      seen.set(key, count);
      result[name] = count;
    }

    // Replacing rather than adding is the eviction. Every rebase gives every
    // branch above it a new range, so a cache that only grew would hold an
    // entry per branch per apply for the lifetime of the window.
    this.counts = seen;
    return result;
  }

  /**
   * Forget the trees of branches this stack no longer holds.
   *
   * Called on every refresh. A BranchChanges is the largest thing this module
   * keeps — every commit and every path — so a branch that left the stack, or
   * was renamed, should not go on costing memory until the window closes.
   *
   * Split on the *last* `@`: a branch name may contain one, the SHAs that
   * follow it cannot.
   */
  prune(keep: Iterable<string>): void {
    const live = new Set(keep);
    for (const key of this.branches.keys()) {
      if (!live.has(key.slice(0, key.lastIndexOf('@')))) {
        this.branches.delete(key);
      }
    }
  }

  /**
   * Forget everything, for a change of repository rather than of branch.
   *
   * `prune` keeps what is still in the stack, which is the wrong question when
   * the whole folder has changed underneath. The keys carry SHAs, so a stale
   * entry could not be *returned* for another repository — but it would sit
   * there for the life of the window, and nothing would ever prune it.
   */
  clear(): void {
    this.branches.clear();
    this.counts.clear();
  }

  /** Never cached: it is the one thing here that changes without a ref moving. */
  async workingTree(cwd: string): Promise<WorkingTree> {
    const [status, head] = await Promise.all([
      this.run(cwd, ['status', '--porcelain=v1', '-z']),
      this.run(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    ]);
    const branch = head.trim();
    return { ...parseStatus(status), branch: branch.length > 0 ? branch : undefined };
  }
}
