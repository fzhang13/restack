import { useEffect, useState } from 'react';
import type {
  ApplyProgress,
  CandidateBranch,
  HostMessage,
  Plan,
  RemoteStackSummary,
  RemoteState,
  StackResult,
  StackSummary,
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
  };
}

export type HostState = ReturnType<typeof useHostState>;
