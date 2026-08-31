import { useEffect, useState } from 'react';
import type {
  ApplyProgress,
  BranchChanges,
  CandidateBranch,
  HostMessage,
  Plan,
  RemoteStackSummary,
  RemoteState,
  StackResult,
  StackSummary,
  WorkingTree,
} from '../../model';
import { toDisplayOrder } from '../lib/order';
import { vscodeApi } from '../vscode';

/**
 * Everything the host tells this webview, and the listener that keeps it
 * current.
 *
 * One hook rather than a state container: the view is a single tree, the
 * messages arrive on one channel, and the `ready` post that starts the whole
 * exchange has to happen exactly once with the listener already attached.
 */
export function useHostState() {
  const [result, setResult] = useState<StackResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [progress, setProgress] = useState<ApplyProgress | null>(null);
  /** The plan an in-flight apply is running, pinned against refreshes. */
  const [appliedPlan, setAppliedPlan] = useState<Plan | null>(null);
  /** Proposed order, in display (top-down) order. */
  const [displayOrder, setDisplayOrder] = useState<string[]>([]);
  /** Branches parked outside the stack: unstacked candidates plus removals. */
  const [trayOrder, setTrayOrder] = useState<string[]>([]);
  const [candidates, setCandidates] = useState<CandidateBranch[]>([]);
  const [canPublish, setCanPublish] = useState(false);
  /** Ahead/behind as of the last fetch. Absent with no stack, or no remote. */
  const [remote, setRemote] = useState<RemoteState | null>(null);
  /** Every stack in the repository, for the switcher. Empty when there are none. */
  const [stacks, setStacks] = useState<StackSummary[]>([]);
  /** Stacks on GitHub this clone has no branches for. Empty until asked. */
  const [remoteStacks, setRemoteStacks] = useState<RemoteStackSummary[]>([]);
  /** What each expanded branch changed, keyed by branch. Filled on demand. */
  const [changes, setChanges] = useState<Record<string, BranchChanges>>({});
  /**
   * Bumped whenever `changes` is dropped, so a subtree that is already open can
   * notice and ask again. Without it an expanded row is stranded in its loading
   * state after every refresh: the request is only ever posted when a row opens,
   * and a row that is already open never opens again.
   */
  const [changesEpoch, setChangesEpoch] = useState(0);
  const [commitCounts, setCommitCounts] = useState<Record<string, number>>({});
  const [workingTree, setWorkingTree] = useState<WorkingTree | null>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent<HostMessage>) => {
      const message = event.data;
      if (message.type === 'loading') {
        setLoading(true);
        return;
      }
      if (message.type === 'stack') {
        setLoading(false);
        setResult(message.result);
        setPlan(null);
        setCandidates(message.candidates);
        setCanPublish(message.canPublish);
        setRemote(message.remote ?? null);
        setStacks(message.stacks);
        // Defaulted, not read straight through: the screenshot harness posts
        // this message by hand and predates the field.
        setRemoteStacks(message.remoteStacks ?? []);
        setCommitCounts(message.commitCounts);
        // Optional on the message, unlike the counts: there is no working tree
        // to report before a folder is open.
        setWorkingTree(message.workingTree ?? null);
        // Branch tips may have moved, so anything cached here is now suspect.
        // The host's own cache means re-expanding costs nothing.
        setChanges({});
        setChangesEpoch((n) => n + 1);
        setDisplayOrder(
          message.result.kind === 'ok'
            ? toDisplayOrder(message.result.stack.branches.map((b) => b.name))
            : [],
        );
        setTrayOrder(message.candidates.map((c) => c.name));
        // Note: apply progress deliberately survives a refresh. A finished
        // local apply triggers one, and its result — plus the push button —
        // has to outlive it.
        return;
      }
      if (message.type === 'plan') {
        setPlan(message.plan);
        return;
      }
      if (message.type === 'apply') {
        setProgress(message.progress);
        return;
      }
      if (message.type === 'applyCleared') {
        setProgress(null);
        setAppliedPlan(null);
      }
      if (message.type === 'changes') {
        setChanges((prev) => ({ ...prev, [message.changes.branch]: message.changes }));
        return;
      }
      if (message.type === 'workingTree') {
        setWorkingTree(message.workingTree);
        return;
      }
    };
    window.addEventListener('message', onMessage);
    vscodeApi.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  return {
    result,
    loading,
    plan,
    setPlan,
    progress,
    setProgress,
    appliedPlan,
    setAppliedPlan,
    displayOrder,
    setDisplayOrder,
    trayOrder,
    setTrayOrder,
    candidates,
    canPublish,
    remote,
    stacks,
    remoteStacks,
    changes,
    changesEpoch,
    commitCounts,
    workingTree,
  };
}

export type HostState = ReturnType<typeof useHostState>;
