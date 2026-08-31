import * as vscode from 'vscode';
import type { ApplyRunner } from '../apply';
import type { ChangesReader } from '../changes';
import type {
  HostMessage,
  Plan,
  RemoteStackSummary,
  RemoteState,
  Stack,
  StackSummary,
} from '../model';

/**
 * What a stack operation is allowed to know about the view that owns it.
 *
 * The operations in `operations/` were methods on StackViewProvider and reached
 * `this.lastStack`, `this.runner`, `this.refresh()` and so on directly. This is
 * that reach, named: the provider implements it and passes itself, so the
 * operations keep reading live state rather than a snapshot taken at call time.
 *
 * The `lastX` fields stay private on the provider and surface here as
 * getters — several operations deliberately re-read `stack` after an
 * `await refresh()`.
 */
export interface Host {
  readonly log: vscode.OutputChannel;
  readonly runner: ApplyRunner;
  readonly stack?: Stack;
  readonly stacks: StackSummary[];
  readonly remoteStacks: RemoteStackSummary[];
  readonly remote?: RemoteState;
  readonly plan?: Plan;
  readonly order?: string[];
  /** Reads and caches per-branch commits, files, and counts. */
  readonly changes: ChangesReader;
  /** Every local branch head as of the last refresh, keyed by name. */
  readonly tips: Map<string, string>;
  cwd(): string | undefined;
  ghPath(): string;
  post(message: HostMessage): void;
  guard(action: () => Promise<void>): Promise<void>;
  refresh(): Promise<void>;
  loadGithub(cwd: string): Promise<void>;
  /** Record the plan the panel renders from, before a run starts. */
  publishPlan(plan: Plan, order: string[]): void;
}

/**
 * True when an apply owns the repository; warns the user as a side effect.
 *
 * The two wordings are not interchangeable. The default is for actions taken
 * from somewhere the plan panel may not be visible; "Use the buttons in the
 * plan panel." is for the ones taken from right next to it.
 */
export function blockedByApply(
  host: Host,
  detail = 'Finish or dismiss it first.',
): boolean {
  if (!host.runner.active) {
    return false;
  }
  void vscode.window.showWarningMessage(`Restack: an apply is in progress. ${detail}`);
  return true;
}
