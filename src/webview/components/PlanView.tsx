import type { ApplyProgress, Plan } from '../../model';
import { STATUS_MARK } from '../lib/constants';
import { vscodeApi } from '../vscode';

/**
 * The conflict, failure, and completion states of an in-flight apply.
 *
 * Deliberately blunt about what has and has not left the machine: once the
 * push step runs, undo stops being offered rather than being offered and
 * quietly doing nothing.
 */
function ApplyPanel({
  progress,
  onContinue,
  onAbort,
  onPublish,
  onDismiss,
}: {
  progress: ApplyProgress;
  onContinue: () => void;
  onAbort: () => void;
  onPublish: () => void;
  onDismiss: () => void;
}) {
  const { phase } = progress;
  const conflictFiles = progress.conflictFiles ?? [];
  // Absent on a session persisted before this field existed — treat every
  // listed file as unresolved rather than enabling Continue on a guess.
  const unresolved = new Set(progress.unresolvedFiles ?? conflictFiles);
  const allResolved = conflictFiles.length > 0 && unresolved.size === 0;

  return (
    <div className={`applying applying--${phase}`}>
      <p className="applying__message">
        {phase === 'running' && 'Applying…'}
        {progress.message}
      </p>

      {phase === 'conflict' && conflictFiles.length > 0 && (
        <ul className="conflicts">
          {conflictFiles.map((file) => {
            const done = !unresolved.has(file);
            return (
              <li key={file} className={`conflicts__row${done ? ' conflicts__row--done' : ''}`}>
                <span className="conflicts__mark" aria-hidden="true">
                  {done ? '✓' : '✗'}
                </span>
                <button
                  type="button"
                  className="conflicts__file"
                  title="Open as text, conflict markers and all"
                  onClick={() => vscodeApi.postMessage({ type: 'openFile', path: file })}
                >
                  <code>{file}</code>
                </button>
                {done ? (
                  <span className="conflicts__state">staged</span>
                ) : (
                  <button
                    type="button"
                    className="conflicts__resolve"
                    title="Open in the three-way merge editor"
                    onClick={() => vscodeApi.postMessage({ type: 'openMergeEditor', path: file })}
                  >
                    Resolve
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="applying__actions">
        {phase === 'conflict' && (
          <>
            {/*
              Disabled is a hint, not the guard: resume() re-reads the index
              itself, since the file could conflict again between the last
              index event and this click.
            */}
            <button
              type="button"
              className={allResolved ? 'publish' : undefined}
              onClick={onContinue}
              disabled={unresolved.size > 0}
              title={
                unresolved.size > 0
                  ? `Still unresolved: ${[...unresolved].join(', ')}. Resolve and stage them first.`
                  : 'Continue the rebase'
              }
            >
              Continue
            </button>
            <button type="button" onClick={onAbort}>
              Abort &amp; roll back
            </button>
          </>
        )}

        {phase === 'done' && progress.localComplete && progress.canUndo && (
          <>
            <button type="button" className="publish" onClick={onPublish}>
              Push &amp; submit
            </button>
            <button type="button" onClick={onAbort}>
              Undo
            </button>
            <button type="button" onClick={onDismiss}>
              Done
            </button>
          </>
        )}

        {phase === 'done' && !(progress.localComplete && progress.canUndo) && (
          <button type="button" onClick={onDismiss}>
            Dismiss
          </button>
        )}

        {phase === 'failed' && (
          <>
            {progress.canUndo && (
              <button type="button" onClick={onAbort}>
                Roll back
              </button>
            )}
            <button type="button" onClick={() => vscodeApi.postMessage({ type: 'showLog' })}>
              Show log
            </button>
            <button type="button" onClick={onDismiss}>
              Dismiss
            </button>
          </>
        )}
      </div>
    </div>
  );
}

interface PlanViewProps {
  plan: Plan;
  progress: ApplyProgress | null;
  onCopy: (text: string) => void;
  onApply: () => void;
  onContinue: () => void;
  onAbort: () => void;
  onPublish: () => void;
  onDismiss: () => void;
}

export function PlanView({ plan, progress, onCopy, onApply, ...actions }: PlanViewProps) {
  if (plan.isNoop && !progress) {
    return (
      <div className="plan plan--empty">
        <p>Drag a branch to see the plan.</p>
      </div>
    );
  }

  const text = plan.steps.map((s) => s.command).join('\n');

  return (
    <div className="plan">
      <div className="plan__header">
        <h2>
          Plan <span className="plan__count">{plan.steps.length} steps</span>
        </h2>
        <button type="button" onClick={() => onCopy(text)} disabled={plan.isNoop}>
          Copy
        </button>
      </div>
      <p className="plan__notice">
        Apply runs the local steps only. Push and submit are confirmed separately.
      </p>
      <ol className="steps">
        {plan.steps.map((step, i) => {
          const status = progress?.statuses[i];
          return (
            <li
              key={i}
              className={`step step--${step.kind}${status ? ` step--${status}` : ''}`}
            >
              <code>
                {status && <span className="step__mark">{STATUS_MARK[status]} </span>}
                {step.command}
              </code>
              {step.note && <span className="step__note">{step.note}</span>}
            </li>
          );
        })}
      </ol>

      {progress ? (
        <ApplyPanel progress={progress} {...actions} />
      ) : (
        <button type="button" className="apply" onClick={onApply} disabled={plan.isNoop}>
          Apply…
        </button>
      )}
    </div>
  );
}
