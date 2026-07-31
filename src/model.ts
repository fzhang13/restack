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
 */
export interface PlanStep {
  kind: 'rebase' | 'metadata' | 'push' | 'submit' | 'trunk';
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
      /** Stacks that exist locally but do not contain the current branch. */
      stacks?: LocalStackSummary[];
    }
  | { kind: 'not-a-repo'; message: string }
  | { kind: 'gh-missing'; message: string }
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
    }
  | { type: 'plan'; plan: Plan }
  | { type: 'loading' }
  | { type: 'apply'; progress: ApplyProgress }
  | { type: 'applyCleared' };

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
  | { type: 'showLog' };
