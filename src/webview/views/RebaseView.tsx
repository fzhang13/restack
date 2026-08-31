import { Message } from '../components/primitives';
import { PlanView } from '../components/PlanView';
import type { HostState } from '../hooks/useHostState';
import { EMPTY_PLAN } from '../lib/constants';
import { vscodeApi } from '../vscode';

/**
 * HEAD is not on a branch, so there is no stack to render — but there may still
 * be an apply to finish.
 *
 * This is where a rebase that stopped on a conflict leaves the repository, which
 * makes it the one "cannot read the stack" state that must not be a dead end:
 * the session behind it is paused, and its Continue and Abort buttons live in
 * the plan panel below. Without them the only way out is a terminal.
 *
 * The panel is rendered from the plan the host replayed alongside the progress
 * — `appliedPlan` is null in the case that matters most here, a window reloaded
 * mid-conflict, where this webview never saw the apply start.
 */
export function RebaseView({
  message,
  sequencer,
  host,
}: {
  message: string;
  /** A rebase or cherry-pick is open, rather than a plain detached checkout. */
  sequencer?: boolean;
  host: HostState;
}) {
  const { plan, appliedPlan, progress, setProgress, setAppliedPlan } = host;

  const body = sequencer
    ? 'A rebase or cherry-pick is in progress, so HEAD is not on a branch and the stack ' +
      'cannot be read. Resolve the conflicts and continue — or abort — and the stack comes back.'
    : 'HEAD is not on a branch, so there is no stack to read. Check out a branch in the stack ' +
      'to see it again.';

  return (
    <div className="app">
      <Message title={sequencer ? 'Rebase in progress' : 'Not on a branch'} body={body} />
      <p className="empty">{message}</p>
      <button type="button" onClick={() => vscodeApi.postMessage({ type: 'refresh' })}>
        Retry
      </button>

      {progress && (
        <PlanView
          plan={(appliedPlan ?? plan) ?? EMPTY_PLAN}
          progress={progress}
          onCopy={(text) => vscodeApi.postMessage({ type: 'copyPlan', text })}
          // Unreachable: PlanView only offers Apply when there is no progress,
          // and this branch is the one where there is.
          onApply={() => {}}
          onContinue={() => vscodeApi.postMessage({ type: 'applyContinue' })}
          onAbort={() => vscodeApi.postMessage({ type: 'applyAbort' })}
          onPublish={() => vscodeApi.postMessage({ type: 'publish' })}
          onDismiss={() => {
            setProgress(null);
            setAppliedPlan(null);
            vscodeApi.postMessage({ type: 'applyDismiss' });
          }}
        />
      )}
    </div>
  );
}
