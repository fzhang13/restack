/**
 * Types shared between the extension host and the webview.
 *
 * These mirror `gh stack view --json` as emitted by gh-stack v0.1.0. That
 * schema is pre-1.0 and expected to move, so `parseStack` in stack.ts is
 * deliberately tolerant: only `name` is treated as required.
 */

/** PR state as reported by gh-stack. Unknown strings are preserved as-is. */
export type PullRequestState = 'open' | 'merged' | 'queued' | 'draft' | string;

export interface StackBranch {
  /** Branch name. The stable identity we key drag operations on. */
  name: string;
  /**
   * SHA this branch is currently based on. gh-stack emits a resolved SHA
   * rather than a ref name, which is exactly the pre-rebase anchor a
   * cascade needs — see plan.ts.
   */
  base: string;
  isCurrent: boolean;
  isMerged: boolean;
  isQueued: boolean;
  /** gh-stack's own signal that this branch has drifted from its base. */
  needsRebase: boolean;
  /** PR fields are omitempty in the CLI output; absent before `gh stack submit`. */
  prNumber?: number;
  prUrl?: string;
  prTitle?: string;
  prState?: PullRequestState;
  isDraft?: boolean;
}

export interface Stack {
  /** Trunk branch name, e.g. `main`. */
  trunk: string;
  /** Branch the working tree is on, if it is part of the stack. */
  currentBranch?: string;
  /** Ordered bottom-to-top: index 0 sits directly on trunk. */
  branches: StackBranch[];
}

/**
 * A local branch outside the stack that can be dragged into it.
 *
 * `base` is a merge-base with trunk rather than something gh-stack recorded —
 * see candidates.ts — but it means the same thing to plan.ts, so an inserted
 * branch anchors its rebase exactly like a stacked one.
 */
export interface CandidateBranch {
  name: string;
  base: string;
  /** Commits in `trunk..branch`, so an empty branch is visible in the tray. */
  commitCount: number;
}

/** One file touched by a commit or a diff, as `--name-status` reports it. */
export interface FileChange {
  /** A, M, D, R, C, T — git's own letters, score suffix stripped. */
  status: string;
  path: string;
  /** Set only for renames and copies; the path it came from. */
  oldPath?: string;
}

export interface CommitSummary {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  /** `%ar` — "3 days ago". Display only, never parsed. */
  relativeDate: string;
  files: FileChange[];
}

/**
 * What one branch changed, read for the range plan.ts would replay.
 *
 * `base` is the recorded base SHA, not the parent branch's current tip — so
 * this is the same range a rebase step takes, which is the number this tool
 * should report. When gh-stack flags a branch `needsRebase` the recorded base
 * is stale and the range can include commits the parent already has; the row
 * carries a `needs rebase` badge saying so.
 */
export interface BranchChanges {
  branch: string;
  base: string;
  tip: string;
  /** Newest first, as `git log` emits them. */
  commits: CommitSummary[];
  /** Combined `base`-to-`tip` diff, for the branch-level summary row. */
  files: FileChange[];
}

/** Paths grouped by index state, from `git status --porcelain=v1 -z`. */
export interface StatusGroups {
  staged: FileChange[];
  unstaged: FileChange[];
  untracked: string[];
}

export interface WorkingTree extends StatusGroups {
  /** Branch HEAD is on, absent when detached. */
  branch?: string;
}

/**
 * Where a branch stands against its upstream, read from local refs only.
 *
 * `ahead` and `behind` are both zero when level, when there is no upstream, and
 * when the upstream is `gone` — so the flags, not the counts, are what
 * distinguish those cases.
 */
export interface Tracking {
  branch: string;
  /** `origin/feat/api`. Absent when the branch has never been pushed. */
  upstream?: string;
  /** Local commits the remote does not have. */
  ahead: number;
  /** Remote commits we do not have. The clobber signal — see branchesBehind. */
  behind: number;
  /** An upstream was configured, but the remote ref is gone (deleted, pruned). */
  gone: boolean;
}

/**
 * The remote half of the view: what the trunk and each stack branch look like
 * against the remote, as of the last fetch.
 */
export interface RemoteState {
  /** The remote the stack publishes to. Absent when there is none. */
  remote?: string;
  trunk: Tracking;
  /** Parallel to `Stack.branches`, so the view can zip without a lookup. */
  branches: Tracking[];
  /** mtime of `.git/FETCH_HEAD` — how stale these counts are. */
  lastFetched?: number;
}

/**
 * How a step is executed. `command` is display only; `exec` is what actually
 * runs, so the two can never drift. `file` is a token rather than a path
 * because `gh` resolves against the `restack.ghPath` setting at run time.
 *
 * Absent on the `metadata` step, which Restack performs itself rather than
 * shelling out — gh-stack exposes no command for it.
 */
export interface StepExec {
  file: 'git' | 'gh';
  args: string[];
}

/**
 * A single step in a reorder plan.
 *
 * `trunk` fast-forwards the trunk onto its upstream before the cascade replays
 * on top of it. Local like `rebase` and `metadata`: it only moves a ref this
 * repository already has objects for, since the fetch happened before the plan
 * was built.
 *
 * `link` is remote, and runs last: it joins the pull requests submit just
 * opened into a stack on GitHub. See publishSteps in plan.ts for why submit
 * alone is not enough.
 */
export interface PlanStep {
  kind: 'rebase' | 'metadata' | 'push' | 'submit' | 'link' | 'trunk';
  /** Branch this step acts on, when applicable. */
  branch?: string;
  /** Human-readable shell command, ready to copy. */
  command: string;
  /** Short explanation shown under the command in the UI. */
  note?: string;
  exec?: StepExec;
}

/** Steps up to and including `metadata` are local; the rest touch GitHub. */
export type ApplyScope = 'local' | 'publish';

export type ApplyPhase = 'running' | 'conflict' | 'done' | 'failed';

export interface ApplyProgress {
  phase: ApplyPhase;
  scope: ApplyScope;
  /** Index into `Plan.steps` of the step running, finished, or failed. */
  stepIndex: number;
  /** Per-step status, parallel to `Plan.steps`. */
  statuses: Array<'pending' | 'running' | 'done' | 'failed' | 'skipped'>;
  message?: string;
  /** Branch whose rebase stopped on a conflict. */
  conflictBranch?: string;
  /**
   * Every path that was unmerged when the pause began, so the UI can list what
   * to resolve. Held fixed for the duration of the pause: a list that shrank as
   * files were staged would erase the record of what had already been done.
   */
  conflictFiles?: string[];
  /**
   * The subset of `conflictFiles` still unmerged right now. Empty means the
   * rebase can continue. Recomputed whenever the index changes, which is what
   * lets the panel track resolution instead of showing one stale snapshot.
   */
  unresolvedFiles?: string[];
  /**
   * True once the rebases and the metadata write have landed. Gates the
   * push/submit button, and gates undo: once pushed, undo is off the table.
   */
  localComplete?: boolean;
  /** True while branch SHAs can still be restored from the pre-apply snapshot. */
  canUndo?: boolean;
}

export interface Plan {
  steps: PlanStep[];
  /** Branch names in their proposed bottom-to-top order. */
  proposedOrder: string[];
  /** True when the proposed order matches the current order. */
  isNoop: boolean;
  /**
   * Branches that gh-stack reports as merged. Reordering around a merged
   * branch is refused: gh-stack itself rejects inserting next to one.
   */
  mergedBranches: string[];
  /** Branches joining the stack, in proposed order. */
  insertedBranches: string[];
  /** Branches leaving the stack, rebased back onto trunk. */
  removedBranches: string[];
}

/**
 * A stack recorded in `.git/gh-stack`, read without going through gh-stack.
 *
 * `gh stack view` only reports the stack HEAD is currently on, so a repository
 * with stacks the user is simply not standing in is indistinguishable from one
 * with no stacks at all — both are exit 2, "not part of a stack". Reading the
 * file directly is what tells the two apart, and the difference matters: the
 * fix for one is to create a stack, for the other to check one out.
 */
export interface LocalStackSummary {
  trunk: string;
  /** Bottom-to-top, as recorded. */
  branches: string[];
}

/**
 * A pull request matched to a branch by head ref.
 *
 * `gh stack view` reports PRs for the stack HEAD is in and no other, so the
 * only way to badge the stacks the user is *not* standing in is to ask GitHub
 * directly — one `gh pr list` for the repository, matched on `headRefName`.
 * Absent entirely when there is no remote, or the call failed: a switcher row
 * without badges is worth more than no switcher.
 */
export interface BranchPr {
  number: number;
  url: string;
  title: string;
  state: PullRequestState;
  isDraft: boolean;
  /**
   * The branch this PR actually targets on GitHub. Not the same thing as
   * `StackBranch.base`, which is the SHA gh-stack recorded locally — so a PR
   * whose base was changed on the server is only visible here.
   *
   * Absent on the `gh pr list` fallback path, which does not ask for it.
   */
  baseRefName?: string;
  /** The GitHub stack this PR belongs to, when it belongs to one. */
  stackNumber?: number;
  /** How many PRs GitHub counts in that stack. */
  stackSize?: number;
}

/** One PR's place in a GitHub stack. */
export interface RemotePrEntry {
  /** 1-based, counting from the bottom — the direction `branches` runs in. */
  position: number;
  number: number;
  headRefName: string;
  state: PullRequestState;
}

/**
 * A stack as GitHub models it: `PullRequest.stack`, a first-class object with
 * its own number, distinct from any PR number and from gh-stack's local index.
 */
export interface RemoteStack {
  /** The number shown in the GitHub stack UI, and taken by `gh stack link`. */
  number: number;
  /** GitHub's own count, which can exceed `entries` when a stack is long. */
  size: number;
  /** The branch the bottom of the stack targets. */
  baseRefName: string;
  /** Bottom-to-top, sorted by position. Possibly truncated — see `size`. */
  entries: RemotePrEntry[];
}

/**
 * Everything one GraphQL read learned about this repository.
 *
 * `supported: false` is the one failure worth distinguishing from an empty
 * result: it means the API has never heard of `PullRequest.stack` — a GitHub
 * Enterprise Server behind github.com — and the caller should fall back to
 * `gh pr list` rather than lose the PR badges Restack has always shown.
 */
export interface GithubGraph {
  /** Keyed by head branch, exactly like the `gh pr list` index it replaces. */
  prs: Map<string, BranchPr>;
  /** Keyed by GitHub stack number. */
  stacks: Map<number, RemoteStack>;
  supported: boolean;
  /** Stack numbers whose entry list was cut off by the query's page size. */
  truncated: number[];
}

/**
 * A stack that exists on GitHub and nowhere in this clone.
 *
 * The case neither `gh stack view` nor `.git/gh-stack` can see: a colleague's
 * stack, or your own from another machine. Offered for checkout rather than
 * rendered in detail — `gh stack checkout <pr>` is what materializes one
 * locally, and once it has, the ordinary local path describes it in full.
 */
export interface RemoteStackSummary {
  number: number;
  baseRefName: string;
  /** Bottom-to-top. */
  entries: RemotePrEntry[];
  /**
   * The PR number to hand `gh stack checkout`. The bottom-most one still open:
   * checkout resolves a stack from any of its PRs, and a merged one may have
   * had its branch deleted on the remote.
   */
  checkoutPr: number;
}

/**
 * How a local stack differs from the GitHub stack it is matched to.
 *
 * Two directions, and they mean different things. `onlyRemote` is the reason
 * this exists: a PR someone appended to your stack on GitHub, which this clone
 * has no branch for and no other part of Restack can see. `onlyLocal` is
 * ordinary — a branch not yet submitted is the normal state of the top of a
 * stack — so it is reported without being called a problem.
 */
export interface StackDivergence {
  /** Head refs in the GitHub stack with no local branch. */
  onlyRemote: string[];
  /** Local branches with no entry in the GitHub stack. */
  onlyLocal: string[];
}

/**
 * One stack in `.git/gh-stack`, enriched enough to render a switcher row.
 *
 * The counterpart to `Stack`, which is what `gh stack view` reports for the one
 * stack HEAD is in. This is every stack, in less detail — no per-branch base
 * SHAs and no `needsRebase`, because nothing short of gh-stack itself can
 * compute those for a stack we are not standing in.
 */
export interface StackSummary extends LocalStackSummary {
  /**
   * 1-based position in the `stacks` array — the number `gh stack checkout <n>`
   * takes, and display-only. Identity is the branch set (see findStackIndex in
   * metadata.ts); an index is not stable across a stack being removed.
   */
  index: number;
  /** True when HEAD is in this stack — the one `gh stack view` reports. */
  isActive: boolean;
  /** Keyed by branch name. Empty when there is no remote, or the call failed. */
  prs: Record<string, BranchPr>;
  /** Local commits the remote does not have, summed over the stack's branches. */
  ahead: number;
  /** Remote commits we do not have. Non-zero is what blocks a rewrite. */
  behind: number;
  /**
   * The GitHub stack this one's PRs belong to. Absent when the stack has no
   * PRs yet, when GitHub has not been asked, or when its branches point at
   * more than one GitHub stack — see matchRemoteStack.
   */
  remoteStackNumber?: number;
  /** Set only alongside `remoteStackNumber`, and only when non-empty. */
  divergence?: StackDivergence;
}

/** Discriminated result of reading the stack, so the UI can render each case. */
export type StackResult =
  | { kind: 'ok'; stack: Stack }
  | {
      kind: 'no-stack';
      message: string;
      /**
       * Best guess at the trunk a new stack should sit on, and the branches
       * that could go in it. Absent when the host could not enumerate them —
       * the view then offers what it can rather than nothing.
       */
      trunk?: string;
      localBranches?: string[];
      /**
       * Remote-tracking branches, qualified (`origin/feat/x`). A stack can be
       * based on one of these; the host creates the local tracking branch
       * before `gh stack init`, which records the trunk by name.
       */
      remoteBranches?: string[];
    }
  | { kind: 'not-a-repo'; message: string }
  /** The `gh` CLI itself could not be run. Restack cannot install this one. */
  | { kind: 'gh-missing'; message: string }
  /**
   * `gh` runs, but does not know the `stack` command — the extension is not
   * installed. Distinct from `gh-missing` because it has a one-command fix
   * Restack can offer to run; see operations/setup.ts.
   */
  | { kind: 'stack-missing'; message: string }
  | { kind: 'error'; message: string };

/** Messages: extension host -> webview. */
export type HostMessage =
  | {
      type: 'stack';
      result: StackResult;
      /** Local branches outside the stack, offered in the tray. */
      candidates: CandidateBranch[];
      /** Whether there is an `origin` to push to; gates Push & Submit. */
      canPublish: boolean;
      /** Ahead/behind for the trunk and each branch. Absent with no stack. */
      remote?: RemoteState;
      /**
       * Every stack in `.git/gh-stack`, whichever one HEAD is in — so the
       * switcher renders the same way from inside a stack and from outside
       * one. Empty in a repository with no stacks at all.
       */
      stacks: StackSummary[];
      /**
       * Stacks GitHub knows about that this clone does not. Empty until the
       * deferred GraphQL read lands, and empty forever when there is no
       * remote, no auth, or `restack.readRemoteStacks` is off.
       */
      remoteStacks: RemoteStackSummary[];
      /** Commits in each branch's own range, keyed by branch. See changes.ts. */
      commitCounts: Record<string, number>;
      /** Uncommitted state, so the HEAD row can render without a round trip. */
      workingTree?: WorkingTree;
    }
  | { type: 'plan'; plan: Plan }
  | { type: 'loading' }
  | { type: 'apply'; progress: ApplyProgress }
  | { type: 'applyCleared' }
  /** Answer to `loadChanges`, for one branch. */
  | { type: 'changes'; changes: BranchChanges }
  /**
   * The working tree alone, posted by the save/index watcher. Deliberately not
   * a full refresh: re-reading the whole stack on every keystroke-to-disk would
   * spawn gh for nothing.
   */
  | { type: 'workingTree'; workingTree: WorkingTree };

/** Messages: webview -> extension host. */
export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'reorder'; order: string[] }
  | { type: 'copyPlan'; text: string }
  /**
   * Create a stack from `branches`, bottom-to-top, based on `trunk`. Branches
   * that do not exist yet are created by gh-stack.
   *
   * `trunkIsRemote` means `trunk` is a remote-tracking ref (`origin/their-work`)
   * rather than a local branch: the host creates the local tracking branch
   * first, since gh-stack records a trunk by name and needs it to resolve.
   */
  | { type: 'initStack'; trunk: string; branches: string[]; trunkIsRemote?: boolean }
  /** Go and ask the remote: `git fetch --prune`. The only network read. */
  | { type: 'fetch' }
  /**
   * Fast-forward the trunk onto its upstream, then replay the stack on top of
   * it. Fetches first, so the plan is never built from stale counts.
   */
  | { type: 'syncStack' }
  /**
   * Re-base the whole stack onto a different branch — the bottom moves to
   * `base`, everything above cascades. `isRemote` marks a remote-tracking ref,
   * handled as in `initStack`.
   */
  | { type: 'changeBase'; base: string; isRemote?: boolean }
  /**
   * Open the host's branch picker, which then sends `changeBase` itself. The
   * webview cannot build that list: the branch a stack most often moves back
   * onto is already merged into its trunk, and so is filtered out of the
   * candidate tray.
   */
  | { type: 'pickBase' }
  /**
   * Extend the stack by one branch, on top: `gh stack add <branch>`. Created if
   * it does not exist, adopted if it does — gh-stack decides, and an adopted
   * branch arrives flagged `needsRebase` for the drift banner to offer.
   */
  | { type: 'addBranch'; branch: string }
  /**
   * Replay the stack onto itself, resolving the drift gh-stack reports after
   * an init adopts branches without rebasing them.
   */
  | { type: 'rebaseStack' }
  /**
   * Dissolve the stack: `gh stack unstack`. Every branch and commit stays where
   * it is — only gh-stack's record of them being a stack goes away. The host
   * confirms the scope, since the remote form also detaches the PRs on GitHub.
   */
  | { type: 'removeStack' }
  /** Run the local steps: rebases, then the gh-stack metadata write. */
  | { type: 'apply'; order: string[] }
  /** Run push + submit against an already-applied local reorder. */
  | { type: 'publish' }
  /** Push + submit with no apply session — the standalone toolbar action. */
  | { type: 'pushSubmit' }
  | { type: 'applyContinue' }
  | { type: 'applyAbort' }
  | { type: 'applyUndo' }
  | { type: 'applyDismiss' }
  | { type: 'openUrl'; url: string }
  /** Workspace-relative path of a conflicted file to open in the editor. */
  | { type: 'openFile'; path: string }
  /**
   * Open a conflicted file in VS Code's three-way merge editor rather than as
   * plain text with conflict markers. Completing that merge stages the file,
   * which is exactly what `applyContinue` requires — so the whole resolve loop
   * stays inside the editor.
   */
  | { type: 'openMergeEditor'; path: string }
  | { type: 'checkout'; branch: string }
  /**
   * Make another stack the active one, by its `StackSummary.index`.
   *
   * A checkout, not a mode switch: `gh stack view` reports the stack HEAD is
   * in and no other, so standing in a stack is what makes it renderable. The
   * host checks out its top branch, which is the same thing the empty state's
   * per-stack button has always done.
   */
  | { type: 'switchStack'; index: number }
  /**
   * Materialize a stack that exists only on GitHub: `gh stack checkout <pr>`.
   *
   * Unlike `switchStack`, which is a local checkout, this reaches the network,
   * creates branches, and writes `.git/gh-stack` — so the host confirms first.
   */
  | { type: 'checkoutRemoteStack'; pr: number }
  /**
   * Start a stack alongside the ones already here.
   *
   * `gh stack init` refuses while HEAD is part of a stack, so this is a
   * request to leave the current one — the host confirms, checks out the
   * trunk, and the ordinary no-stack view takes it from there.
   */
  | { type: 'newStack' }
  /**
   * Install the tool Restack is a front end for:
   * `gh extension install github/gh-stack`. Only ever sent from the setup
   * screen, which is the one state where there is no stack to act on because
   * nothing can read one.
   */
  | { type: 'installGhStack' }
  /** Reveal `restack.ghPath`, for a gh CLI installed somewhere unusual. */
  | { type: 'openGhPathSetting' }
  | { type: 'showLog' }
  /**
   * Read what `branch` changed. Sent when a row is expanded, and again by every
   * open row when a refresh invalidates the webview's copy; collapsing sends
   * nothing, because the cache lives on the host and is keyed by content, so it
   * has no interest in what is on screen.
   */
  | { type: 'loadChanges'; branch: string }
  /**
   * Open `sha`'s version of a file beside an earlier one.
   *
   * `base` is optional because the two lists that send this ask different
   * questions. A file row inside one commit wants that commit against its own
   * parent, which is `sha^` and needs no base. A row in the branch-level list
   * came from `base..tip`, so its left-hand side is the branch's base — `sha^`
   * there would compare a file the tip commit never touched against itself.
   */
  | { type: 'openCommitFile'; sha: string; base?: string; path: string; oldPath?: string }
  /** Open an uncommitted file beside HEAD's version of it. */
  | { type: 'openWorkingFile'; path: string };
