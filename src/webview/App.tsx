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
import type { HostMessage, Plan, Stack, StackBranch, StackResult } from '../model';
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

interface RowProps {
  branch: StackBranch;
  draggable: boolean;
  moved: boolean;
}

function BranchRow({ branch, draggable, moved }: RowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: branch.name,
    disabled: !draggable,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
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
        branch.isCurrent ? 'row--current' : '',
        branch.isMerged ? 'row--merged' : '',
        moved ? 'row--moved' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      {...attributes}
      {...listeners}
    >
      {draggable && (
        <span className="grip" aria-hidden="true">
          ⠿
        </span>
      )}
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
      <ol className="rows">{children}</ol>
      <div className="trunk">
        <span className="trunk__line" />
        {trunk}
      </div>
      {branches.length === 0 && <p className="empty">No branches.</p>}
    </section>
  );
}

function PlanView({ plan, onCopy }: { plan: Plan; onCopy: (text: string) => void }) {
  if (plan.isNoop) {
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
        <button type="button" onClick={() => onCopy(text)}>
          Copy
        </button>
      </div>
      <p className="plan__notice">
        Preview only — Restack does not run these. Review, then run them yourself.
      </p>
      <ol className="steps">
        {plan.steps.map((step, i) => (
          <li key={i} className={`step step--${step.kind}`}>
            <code>{step.command}</code>
            {step.note && <span className="step__note">{step.note}</span>}
          </li>
        ))}
      </ol>
      <button type="button" className="apply" disabled title="Execution lands in v1.">
        Apply — coming in v1
      </button>
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
        return;
      }
      if (message.type === 'plan') {
        setPlan(message.plan);
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

  return (
    <div className="app">
      <div className="toolbar">
        <button type="button" onClick={() => vscodeApi.postMessage({ type: 'refresh' })}>
          Refresh
        </button>
        <button type="button" onClick={reset} disabled={!dirty}>
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
          {currentDisplay.map((name) => {
            const branch = byName.get(name);
            return branch ? (
              <li key={name} className={`row row--static ${branch.isCurrent ? 'row--current' : ''}`}>
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
                    draggable={!hasMerged}
                    moved={movedNames.has(name)}
                  />
                ) : null;
              })}
            </SortableContext>
          </StackColumn>
        </DndContext>
      </div>

      <PlanView
        plan={plan ?? { steps: [], proposedOrder: [], isNoop: true, mergedBranches: [] }}
        onCopy={(text) => vscodeApi.postMessage({ type: 'copyPlan', text })}
      />
    </div>
  );
}
