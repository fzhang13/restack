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

/** A single step in a reorder plan. */
export interface PlanStep {
  kind: 'rebase' | 'metadata' | 'push' | 'submit';
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
  /** Unmerged paths, so the UI can list what to resolve. */
  conflictFiles?: string[];
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
}

/** Discriminated result of reading the stack, so the UI can render each case. */
export type StackResult =
  | { kind: 'ok'; stack: Stack }
  | { kind: 'no-stack'; message: string }
  | { kind: 'not-a-repo'; message: string }
  | { kind: 'gh-missing'; message: string }
  | { kind: 'error'; message: string };

/** Messages: extension host -> webview. */
export type HostMessage =
  | { type: 'stack'; result: StackResult }
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
  /** Run the local steps: rebases, then the gh-stack metadata write. */
  | { type: 'apply'; order: string[] }
  /** Run push + submit against an already-applied local reorder. */
  | { type: 'publish' }
  | { type: 'applyContinue' }
  | { type: 'applyAbort' }
  | { type: 'applyUndo' }
  | { type: 'applyDismiss' };
