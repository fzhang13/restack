import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type {
  ApplyProgress,
  HostMessage,
  Plan,
  Stack,
  StackBranch,
  StackResult,
} from '../model';
import { vscodeApi } from './vscode';
import './styles.css';

/**
 * Stacks read bottom-to-top in the data model (index 0 sits on trunk), but
 * read top-down on screen, matching `gh stack view`. Only the display is
 * reversed; every message back to the host uses model order.
 */
function toDisplayOrder(names: string[]): string[] {
  return [...names].reverse();
}

function toModelOrder(names: string[]): string[] {
  return [...names].reverse();
}

/**
 * Node colours cycle by the branch's position in the *current* stack, so a
 * branch keeps its colour when dragged. An out-of-sequence colour run in the
 * proposed column is the reorder, visible at a glance.
 */
const NODE_COLORS = ['#4c8dff', '#3fb950', '#d4a72c', '#e07a3f', '#a371f7', '#ec6cb9'];

function Node({ index }: { index: number }) {
  return (
    <span
      className="node"
      aria-hidden="true"
      style={{ '--node-color': NODE_COLORS[index % NODE_COLORS.length] } as React.CSSProperties}
    />
  );
}

interface RowProps {
  branch: StackBranch;
  draggable: boolean;
  moved: boolean;
  colorIndex: number;
}

function BranchRow({ branch, draggable, moved, colorIndex }: RowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: branch.name,
    disabled: !draggable,
  });

  // Dimming happens in CSS on the row's contents, not here: an opacity on the
  // row itself would fade its rail segment and dent the line mid-drag.
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const badges: string[] = [];
  if (branch.isMerged) badges.push('merged');
  else if (branch.isQueued) badges.push('queued');
  if (branch.needsRebase) badges.push('needs rebase');
  if (branch.isDraft) badges.push('draft');

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={[
        'row',
        draggable ? 'row--draggable' : 'row--static',
        isDragging ? 'row--dragging' : '',
        branch.isCurrent ? 'row--current' : '',
        branch.isMerged ? 'row--merged' : '',
        moved ? 'row--moved' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      {...attributes}
      {...listeners}
    >
      <Node index={colorIndex} />
      <span className="name">{branch.name}</span>
      {branch.prNumber ? (
        <span className="pr">#{branch.prNumber}</span>
      ) : (
        <span className="pr pr--none">no PR</span>
      )}
      {badges.map((b) => (
        <span key={b} className={`badge badge--${b.replace(/\s+/g, '-')}`}>
          {b}
        </span>
      ))}
    </li>
  );
}

function StackColumn({
  title,
  trunk,
  branches,
  children,
}: {
  title: string;
  trunk: string;
  branches: StackBranch[];
  children?: React.ReactNode;
}) {
  return (
    <section className="column">
      <h2 className="column__title">{title}</h2>
      {/*
        The graph reads bottom-up like git log: trunk at the base, the tip of
        the stack at the top. Each node carries its own rail segment, overhanging
        into the row gap, so the line travels with the row it belongs to while
        dnd-kit animates a drag instead of sitting still behind it.
      */}
      <div className="graph">
        <ol className="rows">{children}</ol>
        <div className="trunk">
          <span className="trunk__node" aria-hidden="true" />
          <span className="trunk__name">{trunk}</span>
        </div>
      </div>
      {branches.length === 0 && <p className="empty">No branches.</p>}
    </section>
  );
}

const STATUS_MARK: Record<string, string> = {
  pending: '·',
  running: '▶',
  done: '✓',
  failed: '✗',
  skipped: '–',
};

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

  return (
    <div className={`applying applying--${phase}`}>
      <p className="applying__message">
        {phase === 'running' && 'Applying…'}
        {progress.message}
      </p>

      {phase === 'conflict' && progress.conflictFiles && progress.conflictFiles.length > 0 && (
        <ul className="conflicts">
          {progress.conflictFiles.map((file) => (
            <li key={file}>
              <code>{file}</code>
            </li>
          ))}
        </ul>
      )}

      <div className="applying__actions">
        {phase === 'conflict' && (
          <>
            <button type="button" onClick={onContinue}>
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

function PlanView({ plan, progress, onCopy, onApply, ...actions }: PlanViewProps) {
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

function Message({ title, body }: { title: string; body: string }) {
  return (
    <div className="message">
      <h2>{title}</h2>
      <p>{body}</p>
    </div>
  );
}

export function App() {
  const [result, setResult] = useState<StackResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [progress, setProgress] = useState<ApplyProgress | null>(null);
  /** The plan an in-flight apply is running, pinned against refreshes. */
  const [appliedPlan, setAppliedPlan] = useState<Plan | null>(null);
  /** Proposed order, in display (top-down) order. */
  const [displayOrder, setDisplayOrder] = useState<string[]>([]);

  const sensors = useSensors(
    // A small activation distance keeps clicks from registering as drags.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

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
        setDisplayOrder(
          message.result.kind === 'ok'
            ? toDisplayOrder(message.result.stack.branches.map((b) => b.name))
            : [],
        );
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

  const stack: Stack | undefined = result?.kind === 'ok' ? result.stack : undefined;

  const byName = useMemo(
    () => new Map((stack?.branches ?? []).map((b) => [b.name, b])),
    [stack],
  );

  const currentDisplay = useMemo(
    () => toDisplayOrder((stack?.branches ?? []).map((b) => b.name)),
    [stack],
  );

  /** Colour by current position, so a branch keeps its node colour when moved. */
  const colorIndexByName = useMemo(
    () => new Map(currentDisplay.map((name, i) => [name, i])),
    [currentDisplay],
  );

  const movedNames = useMemo(() => {
    const moved = new Set<string>();
    displayOrder.forEach((name, i) => {
      if (currentDisplay[i] !== name) {
        moved.add(name);
      }
    });
    return moved;
  }, [displayOrder, currentDisplay]);

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) {
        return;
      }
      const from = displayOrder.indexOf(String(active.id));
      const to = displayOrder.indexOf(String(over.id));
      if (from < 0 || to < 0) {
        return;
      }
      const next = arrayMove(displayOrder, from, to);
      setDisplayOrder(next);
      vscodeApi.postMessage({ type: 'reorder', order: toModelOrder(next) });
    },
    [displayOrder],
  );

  const reset = useCallback(() => {
    setDisplayOrder(currentDisplay);
    setPlan(null);
  }, [currentDisplay]);

  const apply = useCallback(() => {
    if (!plan || plan.isNoop) {
      return;
    }
    // Freeze the plan being applied. A successful apply refreshes the stack,
    // which clears `plan` — but the panel still has to show what ran.
    setAppliedPlan(plan);
    vscodeApi.postMessage({ type: 'apply', order: toModelOrder(displayOrder) });
  }, [plan, displayOrder]);

  const dismissApply = useCallback(() => {
    setProgress(null);
    setAppliedPlan(null);
    vscodeApi.postMessage({ type: 'applyDismiss' });
  }, []);

  if (loading && !result) {
    return <div className="app"><p className="empty">Reading stack…</p></div>;
  }

  if (result && result.kind !== 'ok') {
    const titles: Record<string, string> = {
      'no-stack': 'Not on a stack',
      'not-a-repo': 'Not a git repository',
      'gh-missing': 'gh CLI unavailable',
      error: 'Could not read stack',
    };
    return (
      <div className="app">
        <Message title={titles[result.kind] ?? 'Error'} body={result.message} />
        <button type="button" onClick={() => vscodeApi.postMessage({ type: 'refresh' })}>
          Retry
        </button>
      </div>
    );
  }

  if (!stack) {
    return <div className="app"><p className="empty">No stack.</p></div>;
  }

  // gh-stack refuses to insert next to a merged branch, so we don't offer it.
  const hasMerged = stack.branches.some((b) => b.isMerged);
  const dirty = displayOrder.some((n, i) => currentDisplay[i] !== n);
  // Reordering mid-apply would desync the plan from the repository state the
  // runner is partway through rewriting.
  const busy = progress?.phase === 'running' || progress?.phase === 'conflict';

  return (
    <div className="app">
      <div className="toolbar">
        <button
          type="button"
          onClick={() => vscodeApi.postMessage({ type: 'refresh' })}
          disabled={busy}
        >
          Refresh
        </button>
        <button type="button" onClick={reset} disabled={!dirty || busy}>
          Reset
        </button>
      </div>

      {hasMerged && (
        <p className="warn">
          This stack has merged branches. Reordering around them is disabled — gh-stack
          rejects inserting next to a merged branch.
        </p>
      )}

      <div className="columns">
        <StackColumn title="Current" trunk={stack.trunk} branches={stack.branches}>
          {currentDisplay.map((name, i) => {
            const branch = byName.get(name);
            return branch ? (
              <li key={name} className={`row row--static ${branch.isCurrent ? 'row--current' : ''}`}>
                <Node index={i} />
                <span className="name">{branch.name}</span>
                {branch.prNumber && <span className="pr">#{branch.prNumber}</span>}
              </li>
            ) : null;
          })}
        </StackColumn>

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <StackColumn title="Proposed" trunk={stack.trunk} branches={stack.branches}>
            <SortableContext items={displayOrder} strategy={verticalListSortingStrategy}>
              {displayOrder.map((name) => {
                const branch = byName.get(name);
                return branch ? (
                  <BranchRow
                    key={name}
                    branch={branch}
                    draggable={!hasMerged && !busy}
                    moved={movedNames.has(name)}
                    colorIndex={colorIndexByName.get(name) ?? 0}
                  />
                ) : null;
              })}
            </SortableContext>
          </StackColumn>
        </DndContext>
      </div>

      <PlanView
        plan={
          // appliedPlan is null when the host replays a session this webview
          // never started, so fall back to the plan it replayed alongside it.
          (progress ? (appliedPlan ?? plan) : plan) ?? {
            steps: [],
            proposedOrder: [],
            isNoop: true,
            mergedBranches: [],
          }
        }
        progress={progress}
        onCopy={(text) => vscodeApi.postMessage({ type: 'copyPlan', text })}
        onApply={apply}
        onContinue={() => vscodeApi.postMessage({ type: 'applyContinue' })}
        onAbort={() => vscodeApi.postMessage({ type: 'applyAbort' })}
        onPublish={() => vscodeApi.postMessage({ type: 'publish' })}
        onDismiss={dismissApply}
      />
    </div>
  );
}
