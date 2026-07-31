import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
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
  CandidateBranch,
  HostMessage,
  Plan,
  RemoteState,
  Stack,
  StackBranch,
  StackResult,
  StackSummary,
  Tracking,
} from '../model';
import { addArgs, initArgs } from '../plan';
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

/** `1` -> `1st`. Stacks are short, so the teens rule never bites in practice. */
function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${suffix}`;
}

/**
 * How long ago the last fetch was, as coarsely as still says something.
 *
 * The point is not the exact number but whether the ahead/behind counts below
 * are worth believing — "3d ago" and "3d 4h ago" carry the same warning.
 */
function since(when: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - when) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Where a branch stands against its upstream, as one small pill.
 *
 * Renders nothing when the branch is level with its remote — the common case,
 * and a row of "in sync" badges would bury the two states that matter. `gone`
 * and `unpushed` are stated because their *absence* of counts is otherwise
 * indistinguishable from being level.
 */
function TrackingBadge({ tracking }: { tracking?: Tracking }) {
  if (!tracking) {
    return null;
  }
  const { ahead, behind, gone, upstream } = tracking;

  if (gone) {
    return (
      <span className="badge badge--gone" title={`${upstream} no longer exists on the remote`}>
        gone
      </span>
    );
  }
  if (!upstream) {
    return (
      <span className="badge badge--unpushed" title="Never pushed — no upstream branch">
        unpushed
      </span>
    );
  }
  if (ahead > 0 && behind > 0) {
    return (
      <span
        className="badge badge--diverged"
        title={`${ahead} ahead, ${behind} behind ${upstream}. Sync before rewriting: a force-push would drop those ${behind}.`}
      >
        ↑{ahead} ↓{behind}
      </span>
    );
  }
  if (behind > 0) {
    return (
      <span
        className="badge badge--behind"
        title={`${behind} behind ${upstream}. Sync before rewriting: a force-push would drop them.`}
      >
        ↓{behind}
      </span>
    );
  }
  if (ahead > 0) {
    return (
      <span className="badge badge--ahead" title={`${ahead} not yet pushed to ${upstream}`}>
        ↑{ahead}
      </span>
    );
  }
  return null;
}

/** Droppable id for the tray, distinct from any branch name. */
const TRAY_ID = '__tray__';
/** The init view's stack column, droppable so the first branch has a target. */
const STACK_ID = '__stack__';

const EMPTY_PLAN: Plan = {
  steps: [],
  proposedOrder: [],
  isNoop: true,
  mergedBranches: [],
  insertedBranches: [],
  removedBranches: [],
};

/**
 * Node colours cycle by the branch's position in the *current* stack, so a
 * branch keeps its colour when dragged. An out-of-sequence colour run in the
 * proposed column is the reorder, visible at a glance.
 */
const NODE_COLORS = ['#4c8dff', '#3fb950', '#d4a72c', '#e07a3f', '#a371f7', '#ec6cb9'];

function Node({ index, isHead }: { index: number; isHead?: boolean }) {
  return (
    <span
      className={`node${isHead ? ' node--head' : ''}`}
      aria-hidden="true"
      style={{ '--node-color': NODE_COLORS[index % NODE_COLORS.length] } as React.CSSProperties}
    />
  );
}

/**
 * Check this branch out. Shown on hover so a row full of always-visible
 * controls does not compete with the graph, and never on the row that is
 * already HEAD — there is nothing to switch to.
 */
function CheckoutButton({ branch, disabled }: { branch: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      className="row__checkout"
      title={disabled ? 'Busy' : `Check out ${branch}`}
      aria-label={`Check out ${branch}`}
      disabled={disabled}
      // The row is a drag handle and a dblclick target; neither should claim
      // this click. Same treatment as PrTag.
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        vscodeApi.postMessage({ type: 'checkout', branch });
      }}
    >
      ⇣
    </button>
  );
}

/** The PR number, clickable when gh-stack gave us a URL for it. */
function PrTag({ branch }: { branch: StackBranch }) {
  if (!branch.prNumber) {
    return <span className="pr pr--none">no PR</span>;
  }
  if (!branch.prUrl) {
    return <span className="pr">#{branch.prNumber}</span>;
  }
  return (
    <button
      type="button"
      className="pr pr--link"
      title={branch.prTitle ?? `Open pull request #${branch.prNumber}`}
      // Stop the row's drag sensor and dblclick-to-checkout from claiming this.
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        vscodeApi.postMessage({ type: 'openUrl', url: branch.prUrl! });
      }}
    >
      #{branch.prNumber}
    </button>
  );
}

interface RowProps {
  branch: StackBranch;
  draggable: boolean;
  moved: boolean;
  colorIndex: number;
  /** A branch that does not exist yet, typed into the init view. */
  isNew?: boolean;
  /**
   * Drop the PR tag. Set for every row in the init view: nothing there has
   * been submitted yet, so "no PR" states the obvious about all of them and
   * says it about branches git has never heard of.
   */
  hidePr?: boolean;
  /** Move this row one position; `null` when the direction is unavailable. */
  onNudge?: (delta: number) => void;
  onCheckout?: () => void;
}

function BranchRow({
  branch,
  draggable,
  moved,
  colorIndex,
  isNew,
  hidePr,
  onNudge,
  onCheckout,
}: RowProps) {
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
  // First, so "you are here" is not read after three status words.
  if (branch.isCurrent) badges.push('HEAD');
  if (isNew) badges.push('new');
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
      title={onCheckout ? `${branch.name} — double-click to check out` : branch.name}
      onDoubleClick={onCheckout}
      {...attributes}
      {...listeners}
      // Alt+arrows are the discoverable alternative to dnd-kit's own
      // space-then-arrows keyboard drag, which needs the row focused first.
      //
      // This must come *after* the listeners spread: dnd-kit's KeyboardSensor
      // supplies its own `onKeyDown`, so an earlier handler here is silently
      // overwritten by it. Unhandled keys are forwarded on, leaving dnd-kit's
      // space-to-lift path intact.
      onKeyDown={(event) => {
        if (onNudge && event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
          event.preventDefault();
          onNudge(event.key === 'ArrowUp' ? -1 : 1);
          return;
        }
        listeners?.onKeyDown?.(event);
      }}
    >
      <Node index={colorIndex} isHead={branch.isCurrent} />
      <span className="name">{branch.name}</span>
      {!hidePr && <PrTag branch={branch} />}
      {badges.map((b) => (
        <span key={b} className={`badge badge--${b.replace(/\s+/g, '-')}`}>
          {b}
        </span>
      ))}
      {onCheckout && !branch.isCurrent && <CheckoutButton branch={branch.name} />}
    </li>
  );
}

/**
 * Move the whole stack onto a different branch.
 *
 * Opens the host's QuickPick rather than rendering a `<select>` here, because
 * the webview cannot build the list. The one base every such stack eventually
 * wants — back to `main`, once the colleague's branch merges — is a branch the
 * trunk already contains, and so is filtered out of `candidates` as merged.
 * The host enumerates local and remote refs directly and has no such gap.
 */
function BaseButton({ disabled }: { disabled?: boolean }) {
  return (
    <button
      type="button"
      className="trunk__base"
      disabled={disabled}
      title="Re-base the whole stack onto another branch"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={() => vscodeApi.postMessage({ type: 'pickBase' })}
    >
      Change base…
    </button>
  );
}

function StackColumn({
  title,
  trunk,
  branches,
  droppableId,
  onTrunk,
  trunkCheckout,
  trunkTracking,
  trunkExtra,
  children,
}: {
  title: string;
  trunk: string;
  branches: StackBranch[];
  /**
   * Makes the graph itself a drop target. Only the init view needs this: its
   * column starts empty, and with nothing but rows to drop onto there would be
   * no way to put the first branch in.
   */
  droppableId?: string;
  /** HEAD is on the trunk — a real position in the stack, not the absence of one. */
  onTrunk?: boolean;
  /** Offer checkout on the trunk row too. Off in the init view, where nothing exists yet. */
  trunkCheckout?: boolean;
  /** Where the trunk stands against its own upstream, if there is one. */
  trunkTracking?: Tracking;
  /** Controls that belong on the trunk row — the base picker, in practice. */
  trunkExtra?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: droppableId ?? '', disabled: !droppableId });

  return (
    <section className="column">
      <h2 className="column__title">{title}</h2>
      {/*
        The graph reads bottom-up like git log: trunk at the base, the tip of
        the stack at the top. Each node carries its own rail segment, overhanging
        into the row gap, so the line travels with the row it belongs to while
        dnd-kit animates a drag instead of sitting still behind it.
      */}
      <div
        ref={setNodeRef}
        className={['graph', isOver ? 'graph--over' : ''].filter(Boolean).join(' ')}
      >
        <ol className="rows">{children}</ol>
        <div className={`trunk${onTrunk ? ' trunk--current' : ''}`}>
          <span className="trunk__node" aria-hidden="true" />
          <span className="trunk__name">{trunk}</span>
          {onTrunk && <span className="badge badge--HEAD">HEAD</span>}
          <TrackingBadge tracking={trunkTracking} />
          {trunkCheckout && !onTrunk && <CheckoutButton branch={trunk} />}
          {trunkExtra}
        </div>
      </div>
      {branches.length === 0 && <p className="empty">No branches.</p>}
    </section>
  );
}

/**
 * Branches that could join the stack, and branches dragged out of it.
 *
 * A drop target in its own right, so removing a branch is the same gesture as
 * adding one. Rendered full width below the columns rather than as a third
 * column — the two existing ones already collapse to one at 420px.
 */
function Tray({
  names,
  candidates,
  byName,
  enabled,
  leaving,
}: {
  names: string[];
  candidates: Map<string, CandidateBranch>;
  byName: Map<string, StackBranch>;
  enabled: boolean;
  leaving: Set<string>;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: TRAY_ID, disabled: !enabled });

  return (
    <section className="tray">
      <h2 className="column__title">Available</h2>
      <SortableContext items={names} strategy={verticalListSortingStrategy}>
        <ul
          ref={setNodeRef}
          className={`tray__list ${isOver ? 'tray__list--over' : ''} ${
            names.length === 0 ? 'tray__list--empty' : ''
          }`}
        >
          {names.map((name) => (
            <TrayRow
              key={name}
              name={name}
              candidate={candidates.get(name)}
              branch={byName.get(name)}
              draggable={enabled}
              leaving={leaving.has(name)}
            />
          ))}
          {names.length === 0 && (
            <li className="tray__hint">
              {enabled
                ? 'No other local branches. Drag a branch here to remove it from the stack.'
                : 'No other local branches.'}
            </li>
          )}
        </ul>
      </SortableContext>
    </section>
  );
}

function TrayRow({
  name,
  candidate,
  branch,
  draggable,
  leaving,
}: {
  name: string;
  candidate?: CandidateBranch;
  branch?: StackBranch;
  draggable: boolean;
  leaving: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: name,
    disabled: !draggable,
  });

  const count = candidate?.commitCount;

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={[
        'candidate',
        draggable ? 'candidate--draggable' : '',
        isDragging ? 'candidate--dragging' : '',
        leaving ? 'candidate--leaving' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      {...attributes}
      {...listeners}
    >
      <span className="candidate__dot" aria-hidden="true" />
      <span className="name">{name}</span>
      {leaving ? (
        <span className="badge badge--leaving">un-stacking</span>
      ) : (
        count !== undefined && (
          <span className="candidate__count">
            {count} commit{count === 1 ? '' : 's'}
          </span>
        )
      )}
      {branch?.prNumber && <PrTag branch={branch} />}
    </li>
  );
}

/**
 * Add one branch on top of the stack — init's typed-in branch, for a stack that
 * already exists.
 *
 * Sits under the tray because both answer the same question, and the tray alone
 * cannot: dragging needs a branch with commits on it, and a branch created a
 * moment ago has none, so it is filtered out as merged into trunk before it can
 * be dragged anywhere.
 *
 * Top-only, and says so, because `gh stack add` is. The command is previewed
 * the way init's is, built by the same `addArgs` the host runs.
 */
function AddBranch({ top, blocked }: { top: string | undefined; blocked?: string }) {
  const [draft, setDraft] = useState('');
  const name = draft.trim();

  const submit = useCallback(() => {
    if (!name || blocked) {
      return;
    }
    vscodeApi.postMessage({ type: 'addBranch', branch: name });
    setDraft('');
  }, [name, blocked]);

  return (
    <section className="add">
      <div className="init__row">
        <label htmlFor="add-branch">Add on top</label>
        <input
          id="add-branch"
          type="text"
          placeholder="feat/my-change"
          value={draft}
          disabled={!!blocked}
          title={blocked}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button type="button" onClick={submit} disabled={!!blocked || !name} title={blocked}>
          Add
        </button>
      </div>
      <p className="add__note">
        {blocked ? (
          blocked
        ) : name ? (
          <>
            <code>gh {addArgs(name).join(' ')}</code> — creates {name} on top of{' '}
            {top ?? 'the stack'}, or adopts it if it already exists. Adopting does not rebase;
            Restack offers that next.
          </>
        ) : (
          <>
            Goes on top of the stack — <code>gh stack add</code> only adds there. To put a branch
            further down, drag one in from Available.
          </>
        )}
      </p>
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

/** A PR badge for a switcher row: `#12`, dimmed once merged or closed. */
function PrBadge({ number, state, isDraft }: { number: number; state: string; isDraft: boolean }) {
  const label = isDraft && state === 'open' ? 'draft' : state;
  return (
    <span className={`switcher__pr switcher__pr--${label}`} title={`#${number} — ${label}`}>
      #{number}
    </span>
  );
}

/**
 * One row in the switcher: a stack, its branches, and where its PRs stand.
 *
 * Branches read top-down here as everywhere else, with the trunk last — the
 * same shape `gh stack view` prints, so a row and the column below it describe
 * a stack the same way round.
 */
function StackRow({ stack, onSwitch }: { stack: StackSummary; onSwitch: () => void }) {
  const topDown = [...stack.branches].reverse();
  const top = stack.branches[stack.branches.length - 1];

  return (
    <li className={`stacks__item${stack.isActive ? ' stacks__item--active' : ''}`}>
      <span className="switcher__number" aria-hidden="true">
        {stack.isActive ? '●' : '○'} {stack.index}
      </span>

      <span className="stacks__path">
        {topDown.map((name, i) => {
          const pr = stack.prs[name];
          return (
            <span key={name}>
              {i > 0 && <span className="stacks__arrow"> ← </span>}
              <span>{name}</span>
              {pr && <PrBadge number={pr.number} state={pr.state} isDraft={pr.isDraft} />}
            </span>
          );
        })}
        <span className="stacks__arrow"> ← </span>
        <span className="stacks__trunk">{stack.trunk}</span>
        {stack.behind > 0 && (
          <span
            className="switcher__behind"
            title={`${stack.behind} commit${stack.behind === 1 ? '' : 's'} on the remote that this clone does not have, as of the last fetch. Rewriting is blocked until they are pulled.`}
          >
            ↓{stack.behind}
          </span>
        )}
      </span>

      {stack.isActive ? (
        <span className="switcher__here">current</span>
      ) : (
        <button
          type="button"
          onClick={onSwitch}
          title={`Check out ${top}, the top of this stack. gh-stack reports the stack HEAD is in, so standing in it is what makes it the active one.`}
        >
          Check out
        </button>
      )}
    </li>
  );
}

/**
 * Every stack in the repository, and which one you are standing in.
 *
 * gh-stack models many stacks per repository — `.git/gh-stack` holds an array,
 * and `gh stack checkout` takes a stack number — but `gh stack view` reports
 * only the stack HEAD is in. So before this, the other stacks in a repository
 * were invisible from inside one: reachable only by knowing their branch names
 * and checking one out from a terminal.
 *
 * Collapsed to a single line by default, because the common repository has one
 * stack and the switcher should cost it nothing. Renders nothing at all below
 * two, where there is no choice to offer.
 */
function StackSwitcher({ stacks }: { stacks: StackSummary[] }) {
  const [open, setOpen] = useState(false);
  const active = stacks.find((s) => s.isActive);

  if (stacks.length < 2) {
    return null;
  }

  return (
    <section className="switcher">
      <button
        type="button"
        className="switcher__header"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className="switcher__caret" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className="switcher__summary">
          {active ? (
            <>
              Stack {active.index} of {stacks.length}
            </>
          ) : (
            // Standing outside every stack is a position too — and the one
            // where the switcher is most worth opening.
            <>
              {stacks.length} stacks · none checked out
            </>
          )}
        </span>
        {active && <span className="switcher__trunk">on {active.trunk}</span>}
      </button>

      {open && (
        <ul className="stacks__list">
          {stacks.map((s) => (
            <StackRow
              key={s.index}
              stack={s}
              onSwitch={() => vscodeApi.postMessage({ type: 'switchStack', index: s.index })}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The empty state, for a repository with no stack under the current branch.
 *
 * Built from the same drag machinery as the reorder view rather than a native
 * QuickPick, because the order *is* the stack: `gh stack init a b c` takes its
 * branches bottom-to-top, and a multi-select returns list order, not the order
 * you clicked. Dragging is the only interaction where what you see is the
 * argument list.
 *
 * Two situations arrive here as the same gh-stack error. When `stacks` is
 * non-empty the repository has stacks and the user is just standing outside
 * one, so checking one out is offered first and creating another is secondary.
 */
function InitView({
  message,
  trunk: detectedTrunk,
  localBranches,
  remoteBranches,
  stacks,
  candidates,
}: {
  message: string;
  trunk?: string;
  localBranches: string[];
  /** Qualified remote refs (`origin/their-work`), offered as a base of their own. */
  remoteBranches: string[];
  stacks: StackSummary[];
  candidates: CandidateBranch[];
}) {
  const [trunk, setTrunk] = useState(detectedTrunk ?? 'main');
  /**
   * The picked trunk is a remote ref, so the host has a local tracking branch
   * to create before `gh stack init` — which records a trunk by name and needs
   * it to resolve.
   */
  const trunkIsRemote = remoteBranches.includes(trunk);
  /** Branches picked for the new stack, top-down like the reorder view. */
  const [picked, setPicked] = useState<string[]>([]);
  const [available, setAvailable] = useState<string[]>(() => candidates.map((c) => c.name));
  /** Branches typed in rather than dragged; gh-stack creates these. */
  const [created, setCreated] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [dragging, setDragging] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const candidatesByName = useMemo(
    () => new Map(candidates.map((c) => [c.name, c])),
    [candidates],
  );

  // Changing the trunk cannot leave it sitting in the stack it is the base of.
  useEffect(() => {
    setPicked((p) => p.filter((n) => n !== trunk));
    setAvailable((a) => a.filter((n) => n !== trunk));
  }, [trunk]);

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      setDragging(null);
      const { active, over } = event;
      if (!over) {
        return;
      }
      const id = String(active.id);
      const overId = String(over.id);
      if (id === overId) {
        return;
      }

      const inStack = picked.includes(id);
      const toTray = overId === TRAY_ID || available.includes(overId);

      if (inStack && toTray) {
        setPicked(picked.filter((n) => n !== id));
        // A typed-in branch does not exist yet, so there is nothing to park in
        // the tray — dropping it there discards it.
        if (created.includes(id)) {
          setCreated(created.filter((n) => n !== id));
        } else {
          setAvailable([...available, id]);
        }
        return;
      }

      if (!inStack && !toTray) {
        // Dropping on the column itself rather than a row — the only option
        // while the stack is empty — appends to the bottom.
        const at = overId === STACK_ID ? -1 : picked.indexOf(overId);
        setAvailable(available.filter((n) => n !== id));
        const next = [...picked];
        next.splice(at < 0 ? next.length : at, 0, id);
        setPicked(next);
        return;
      }

      if (inStack) {
        const from = picked.indexOf(id);
        const to = picked.indexOf(overId);
        if (to >= 0 && from !== to) {
          setPicked(arrayMove(picked, from, to));
        }
        return;
      }

      const from = available.indexOf(id);
      const to = available.indexOf(overId);
      if (from >= 0 && to >= 0 && from !== to) {
        setAvailable(arrayMove(available, from, to));
      }
    },
    [picked, available, created],
  );

  const addDraft = useCallback(() => {
    const name = draft.trim();
    // Only a name nothing else already claims: the host would refuse a
    // duplicate, and silently ignoring one here would look like a no-op.
    if (!name || picked.includes(name) || available.includes(name) || name === trunk) {
      return;
    }
    setPicked([name, ...picked]);
    setCreated([...created, name]);
    setDraft('');
  }, [draft, picked, available, created, trunk]);

  /** Bottom-to-top, which is the order gh stack init takes its arguments in. */
  const order = toModelOrder(picked);
  /**
   * `origin/their-work` -> `their-work`, the local branch the host creates. Only
   * ever applied to a name that came from `remoteBranches`, so the first segment
   * is the remote — the host does the same strip against the real remote list.
   */
  const localTrunk = trunkIsRemote ? trunk.slice(trunk.indexOf('/') + 1) : trunk;
  const command = `gh ${initArgs(localTrunk, order).join(' ')}`;

  const rowFor = useCallback(
    (name: string): StackBranch => ({
      name,
      base: candidatesByName.get(name)?.base ?? '',
      isCurrent: false,
      isMerged: false,
      isQueued: false,
      needsRebase: false,
    }),
    [candidatesByName],
  );

  return (
    <div className="app">
      {stacks.length > 0 ? (
        <section className="stacks">
          <h2 className="column__title">Stacks in this repository</h2>
          <p className="stacks__hint">{message}</p>
          {/*
            The same rows the switcher renders from inside a stack, so a stack
            describes itself identically wherever it is listed. None of them is
            active here by definition — that is why this view is showing.
          */}
          <ul className="stacks__list">
            {stacks.map((s) => (
              <StackRow
                key={s.index}
                stack={s}
                onSwitch={() => vscodeApi.postMessage({ type: 'switchStack', index: s.index })}
              />
            ))}
          </ul>
        </section>
      ) : (
        <Message title="No stack yet" body={message} />
      )}

      <section className="init">
        <h2 className="column__title">
          {stacks.length > 0 ? 'Create another stack' : 'Create a stack'}
        </h2>
        <p className="init__hint">
          Drag branches into the stack, bottom first. The bottom branch sits on the trunk;
          each one above it is based on the one below.
        </p>

        <div className="init__row">
          <label htmlFor="init-trunk">Trunk</label>
          <select
            id="init-trunk"
            value={trunk}
            onChange={(e) => setTrunk(e.target.value)}
            disabled={localBranches.length === 0 && remoteBranches.length === 0}
          >
            {(localBranches.length > 0 ? localBranches : [trunk]).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
            {/*
              A stack does not have to sit on the default branch, and the
              colleague's branch you want to build on often exists only here.
            */}
            {remoteBranches.length > 0 && (
              <optgroup label="Remote — creates a local branch">
                {remoteBranches.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>

        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={(event: DragStartEvent) => setDragging(String(event.active.id))}
          onDragCancel={() => setDragging(null)}
          onDragEnd={onDragEnd}
        >
          <div className="columns columns--single">
            <StackColumn
              title="New stack"
              trunk={trunk}
              branches={picked.map(rowFor)}
              droppableId={STACK_ID}
            >
              <SortableContext items={picked} strategy={verticalListSortingStrategy}>
                {picked.map((name, i) => (
                  <BranchRow
                    key={name}
                    branch={rowFor(name)}
                    draggable
                    moved={false}
                    isNew={created.includes(name)}
                    hidePr
                    colorIndex={i}
                  />
                ))}
              </SortableContext>
            </StackColumn>
          </div>

          <Tray
            names={available}
            candidates={candidatesByName}
            byName={new Map()}
            enabled
            leaving={new Set()}
          />

          <DragOverlay>
            {dragging ? (
              <div className="row row--overlay">
                <Node index={picked.indexOf(dragging)} />
                <span className="name">{dragging}</span>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>

        <div className="init__row">
          <label htmlFor="init-new">New branch</label>
          <input
            id="init-new"
            type="text"
            placeholder="feat/my-change"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addDraft();
              }
            }}
          />
          <button type="button" onClick={addDraft} disabled={!draft.trim()}>
            Add
          </button>
        </div>

        <div className="init__preview">
          <code>
            {trunkIsRemote && `git branch --track ${localTrunk} ${trunk}\n`}
            {command}
          </code>
          <span className="step__note">
            {picked.length === 0
              ? 'Add at least one branch.'
              : (trunkIsRemote
                  ? `${trunk} exists only on the remote, so a local ${localTrunk} is created ` +
                    'to track it first. '
                  : '') +
                'Adopts branches that exist and creates the ones that do not. ' +
                'Adopting does not rebase them — Restack offers that next.'}
          </span>
        </div>

        <button
          type="button"
          className="publish init__go"
          onClick={() =>
            vscodeApi.postMessage({
              // The qualified name: the host strips the remote itself, against
              // the real remote list rather than the first slash.
              type: 'initStack',
              trunk,
              branches: order,
              trunkIsRemote,
            })
          }
          disabled={picked.length === 0}
        >
          Initialize stack
        </button>
      </section>
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
  /** Branches parked outside the stack: unstacked candidates plus removals. */
  const [trayOrder, setTrayOrder] = useState<string[]>([]);
  const [candidates, setCandidates] = useState<CandidateBranch[]>([]);
  const [canPublish, setCanPublish] = useState(false);
  /** Ahead/behind as of the last fetch. Absent with no stack, or no remote. */
  const [remote, setRemote] = useState<RemoteState | null>(null);
  /** Every stack in the repository, for the switcher. Empty when there are none. */
  const [stacks, setStacks] = useState<StackSummary[]>([]);
  const [dragging, setDragging] = useState<string | null>(null);

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
        setCandidates(message.candidates);
        setCanPublish(message.canPublish);
        setRemote(message.remote ?? null);
        setStacks(message.stacks);
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

  const stack: Stack | undefined = result?.kind === 'ok' ? result.stack : undefined;

  const byName = useMemo(
    () => new Map((stack?.branches ?? []).map((b) => [b.name, b])),
    [stack],
  );

  const candidatesByName = useMemo(
    () => new Map(candidates.map((c) => [c.name, c])),
    [candidates],
  );

  const currentDisplay = useMemo(
    () => toDisplayOrder((stack?.branches ?? []).map((b) => b.name)),
    [stack],
  );

  /**
   * Tracking by branch name. `remote.branches` arrives parallel to
   * `stack.branches`, but the proposed column renders in a different order and
   * the tray in none at all, so it is indexed by name once here.
   */
  const trackingByName = useMemo(
    () => new Map((remote?.branches ?? []).map((t) => [t.branch, t])),
    [remote],
  );

  /** Colour by current position, so a branch keeps its node colour when moved. */
  const colorIndexByName = useMemo(
    () => new Map(currentDisplay.map((name, i) => [name, i])),
    [currentDisplay],
  );

  /**
   * Where HEAD is. `currentBranch` and `isCurrent` come straight from
   * `gh stack view`, which reports the stack whether or not HEAD is inside it —
   * so standing on the trunk, or on some branch entirely outside, are both
   * positions to state rather than states to hide.
   */
  const head = useMemo(() => {
    const name = stack?.currentBranch;
    const branches = stack?.branches ?? [];
    const index = branches.findIndex((b) => b.name === name);
    return {
      name,
      onTrunk: !!name && name === stack?.trunk,
      /** 1-based from the bottom, matching how the column is counted. */
      position: index >= 0 ? index + 1 : 0,
      total: branches.length,
      /** Neither in the stack nor on its trunk — gh-stack can report this. */
      outside: !!name && name !== stack?.trunk && index < 0,
    };
  }, [stack]);

  /** Branches in the tray that the stack currently holds — i.e. being removed. */
  const leaving = useMemo(
    () => new Set(trayOrder.filter((n) => byName.has(n))),
    [trayOrder, byName],
  );

  const movedNames = useMemo(() => {
    const moved = new Set<string>();
    displayOrder.forEach((name, i) => {
      // A branch joining the stack is a change by definition, wherever it sits.
      if (currentDisplay[i] !== name || !byName.has(name)) {
        moved.add(name);
      }
    });
    return moved;
  }, [displayOrder, currentDisplay, byName]);

  /**
   * A synthetic StackBranch for a candidate, so tray branches dropped into the
   * stack render through the same row component as everything else.
   */
  const rowFor = useCallback(
    (name: string): StackBranch =>
      byName.get(name) ?? {
        name,
        base: candidatesByName.get(name)?.base ?? '',
        isCurrent: false,
        isMerged: false,
        isQueued: false,
        needsRebase: false,
      },
    [byName, candidatesByName],
  );

  /** Push the proposed order to the host, which recomputes the plan. */
  const submitOrder = useCallback((nextDisplay: string[]) => {
    vscodeApi.postMessage({ type: 'reorder', order: toModelOrder(nextDisplay) });
  }, []);

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      setDragging(null);
      const { active, over } = event;
      if (!over) {
        return;
      }

      const id = String(active.id);
      const overId = String(over.id);
      const fromStack = displayOrder.indexOf(id);
      const inStack = fromStack >= 0;
      // `over` is either a row (drop next to it) or the tray's own droppable
      // (dropped on empty space in it).
      const toTray = overId === TRAY_ID || trayOrder.includes(overId);

      if (inStack && toTray) {
        // Leaving the stack.
        const nextStack = displayOrder.filter((n) => n !== id);
        const at = overId === TRAY_ID ? trayOrder.length : trayOrder.indexOf(overId);
        const nextTray = [...trayOrder];
        nextTray.splice(at, 0, id);
        setDisplayOrder(nextStack);
        setTrayOrder(nextTray);
        submitOrder(nextStack);
        return;
      }

      if (!inStack && !toTray) {
        // Joining the stack, at the position it was dropped on.
        const at = displayOrder.indexOf(overId);
        const nextStack = [...displayOrder];
        nextStack.splice(at < 0 ? nextStack.length : at, 0, id);
        setTrayOrder(trayOrder.filter((n) => n !== id));
        setDisplayOrder(nextStack);
        submitOrder(nextStack);
        return;
      }

      if (inStack) {
        const to = displayOrder.indexOf(overId);
        if (to < 0 || to === fromStack) {
          return;
        }
        const next = arrayMove(displayOrder, fromStack, to);
        setDisplayOrder(next);
        submitOrder(next);
        return;
      }

      // Reordering inside the tray: purely cosmetic, no plan change.
      const from = trayOrder.indexOf(id);
      const to = trayOrder.indexOf(overId);
      if (from >= 0 && to >= 0 && from !== to) {
        setTrayOrder(arrayMove(trayOrder, from, to));
      }
    },
    [displayOrder, trayOrder, submitOrder],
  );

  const nudge = useCallback(
    (name: string, delta: number) => {
      const from = displayOrder.indexOf(name);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= displayOrder.length) {
        return;
      }
      const next = arrayMove(displayOrder, from, to);
      setDisplayOrder(next);
      submitOrder(next);
    },
    [displayOrder, submitOrder],
  );

  const reset = useCallback(() => {
    setDisplayOrder(currentDisplay);
    setTrayOrder(candidates.map((c) => c.name));
    setPlan(null);
  }, [currentDisplay, candidates]);

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

  // No stack under the current branch is not an error — it is where every
  // repository starts, so it gets an entry point rather than a dead end.
  if (result?.kind === 'no-stack') {
    return (
      <InitView
        message={result.message}
        trunk={result.trunk}
        localBranches={result.localBranches ?? []}
        remoteBranches={result.remoteBranches ?? []}
        stacks={stacks}
        candidates={candidates}
      />
    );
  }

  if (result && result.kind !== 'ok') {
    const titles: Record<string, string> = {
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
  const dirty =
    displayOrder.length !== currentDisplay.length ||
    displayOrder.some((n, i) => currentDisplay[i] !== n);
  // Reordering mid-apply would desync the plan from the repository state the
  // runner is partway through rewriting.
  const busy = progress?.phase === 'running' || progress?.phase === 'conflict';
  const editable = !hasMerged && !busy;
  /** Branches leaving the stack that already have a PR open against a parent. */
  const leavingWithPrs = [...leaving].filter((n) => byName.get(n)?.prNumber);
  /**
   * Branches recorded in the stack but not actually sitting on their parent —
   * what `gh stack init` leaves behind when it adopts divergent branches. Only
   * offered while the order is untouched: with a reorder pending, the plan
   * below already replays these branches.
   */
  const drifted = dirty ? [] : stack.branches.filter((b) => b.needsRebase).map((b) => b.name);

  /**
   * Branches whose remote has commits we do not. Mirrors `branchesBehind` in
   * remote.ts, which is what preflight refuses on — so the banner below states
   * the same rule the host enforces, rather than the UI offering a button that
   * is guaranteed to be rejected. `gone` is excluded in both places: a branch
   * deleted after its PR merged is normal, not a hazard.
   */
  const behind = (remote?.branches ?? []).filter((t) => !t.gone && t.behind > 0);
  /** The trunk moved under the stack. Fixable, unlike the above — hence a button. */
  const trunkBehind = remote?.trunk.gone ? 0 : (remote?.trunk.behind ?? 0);

  return (
    <div className="app">
      <StackSwitcher stacks={stacks} />

      <div className="toolbar">
        <button
          type="button"
          onClick={() => vscodeApi.postMessage({ type: 'refresh' })}
          disabled={busy}
        >
          Refresh
        </button>
        {/*
          Refresh re-reads local refs; this is the only control that talks to
          the network. Every count on this screen is as old as the last one.
        */}
        <button
          type="button"
          onClick={() => vscodeApi.postMessage({ type: 'fetch' })}
          disabled={busy || !remote?.remote}
          title={
            remote?.remote
              ? `git fetch --prune ${remote.remote}` +
                (remote.lastFetched ? ` — last fetched ${since(remote.lastFetched)}` : '')
              : 'No remote to fetch from'
          }
        >
          Fetch
        </button>
        <button type="button" onClick={reset} disabled={!dirty || busy}>
          Reset
        </button>
        {/*
          `gh stack init` refuses while HEAD is in a stack, so the host parks
          on the trunk first — stated here rather than discovered after the
          click, since it moves the working tree.
        */}
        <button
          type="button"
          onClick={() => vscodeApi.postMessage({ type: 'newStack' })}
          disabled={busy}
          title="Start a second stack in this repository. Checks out the trunk first, since a new stack cannot be started from inside an existing one."
        >
          + New stack
        </button>
        <button
          type="button"
          className="toolbar__remove"
          onClick={() => vscodeApi.postMessage({ type: 'removeStack' })}
          disabled={busy}
          title="Remove this stack from gh-stack's tracking. Every branch and commit is kept."
        >
          Remove stack
        </button>
        <button
          type="button"
          className="publish toolbar__publish"
          onClick={() => vscodeApi.postMessage({ type: 'pushSubmit' })}
          disabled={!canPublish || busy}
          title={
            canPublish
              ? 'Run gh stack push, then gh stack submit --auto, for the stack as it is on disk now'
              : 'No origin remote to push to'
          }
        >
          Push &amp; submit
        </button>
      </div>

      {head.name && (
        <p className={head.outside ? 'warn' : 'here'}>
          {head.outside ? (
            <>
              You are on <strong>{head.name}</strong>, which is not part of this stack. Check
              out a branch below to work in it.
            </>
          ) : head.onTrunk ? (
            <>
              You are on <strong>{head.name}</strong>, the trunk this stack sits on.
            </>
          ) : (
            <>
              You are on <strong>{head.name}</strong> — {ordinal(head.position)} of {head.total}{' '}
              in the stack.
            </>
          )}
        </p>
      )}

      {hasMerged && (
        <p className="warn">
          This stack has merged branches. Reordering around them is disabled — gh-stack
          rejects inserting next to a merged branch.
        </p>
      )}

      {/*
        Blocking, and first among the remote banners: preflight refuses every
        apply while this holds, so offering the fixable trunk case above it
        would be offering a button that cannot run.
      */}
      {behind.length > 0 && (
        <div className="warn">
          <p className="warn__text">
            {behind
              .map((t) => `${t.branch} is ${t.behind} behind ${t.upstream ?? 'its upstream'}`)
              .join('; ')}
            . Rewriting is blocked: <code>gh stack push</code> force-pushes with a lease
            against the remote ref we already have, so those commits would be dropped with
            no warning. Pull{' '}
            {behind.length === 1 ? 'that branch' : 'those branches'} first — Restack has no
            safe automatic answer, since the local and remote sides have both moved.
          </p>
        </div>
      )}

      {trunkBehind > 0 && (
        <div className="warn">
          <p className="warn__text">
            <strong>{stack.trunk}</strong> is {trunkBehind} commit
            {trunkBehind === 1 ? '' : 's'} behind {remote?.trunk.upstream ?? 'its upstream'}
            {remote?.lastFetched ? ` as of ${since(remote.lastFetched)}` : ''}. Syncing
            fast-forwards it and replays the stack on top — snapshotted first, and nothing
            is pushed.
          </p>
          <button
            type="button"
            onClick={() => vscodeApi.postMessage({ type: 'syncStack' })}
            disabled={busy || behind.length > 0}
            title={
              behind.length > 0
                ? 'Resolve the branches behind their upstreams first.'
                : `Fetch, fast-forward ${stack.trunk}, then replay the stack`
            }
          >
            Sync stack
          </button>
        </div>
      )}

      {drifted.length > 0 && (
        <div className="warn">
          <p className="warn__text">
            {drifted.join(', ')} {drifted.length === 1 ? 'is' : 'are'} not sitting on{' '}
            {drifted.length === 1 ? 'its' : 'their'} recorded parent. Adopting an existing
            branch leaves it this way — <code>gh stack init</code> and{' '}
            <code>gh stack add</code> both record the order without rebasing.
          </p>
          <button type="button" onClick={() => vscodeApi.postMessage({ type: 'rebaseStack' })} disabled={busy}>
            Rebase stack
          </button>
        </div>
      )}

      {leavingWithPrs.length > 0 && (
        <p className="warn">
          {leavingWithPrs.join(', ')} {leavingWithPrs.length === 1 ? 'has' : 'have'} an open
          PR. Removing {leavingWithPrs.length === 1 ? 'it' : 'them'} from the stack leaves that
          PR targeting a base that is no longer its parent — `gh stack submit` will not
          retarget it once it is out of the stack. Retarget or close it on GitHub.
        </p>
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={(event: DragStartEvent) => setDragging(String(event.active.id))}
        onDragCancel={() => setDragging(null)}
        onDragEnd={onDragEnd}
      >
        <div className="columns">
          {/* The column you navigate from: every row here is somewhere you can stand. */}
          <StackColumn
            title="Current"
            trunk={stack.trunk}
            branches={stack.branches}
            onTrunk={head.onTrunk}
            trunkCheckout={!busy}
            trunkTracking={remote?.trunk}
            trunkExtra={<BaseButton disabled={busy} />}
          >
            {currentDisplay.map((name, i) => {
              const branch = byName.get(name);
              return branch ? (
                <li key={name} className={`row row--static ${branch.isCurrent ? 'row--current' : ''}`}>
                  <Node index={i} isHead={branch.isCurrent} />
                  <span className="name">{branch.name}</span>
                  {branch.prNumber && <PrTag branch={branch} />}
                  {branch.isCurrent && <span className="badge badge--HEAD">HEAD</span>}
                  {/* Only on this column: the proposed one describes a future
                      state, and these counts are about the present. */}
                  <TrackingBadge tracking={trackingByName.get(name)} />
                  {!branch.isCurrent && <CheckoutButton branch={name} disabled={busy} />}
                </li>
              ) : null;
            })}
          </StackColumn>

          <StackColumn title="Proposed" trunk={stack.trunk} branches={stack.branches} onTrunk={head.onTrunk}>
            <SortableContext items={displayOrder} strategy={verticalListSortingStrategy}>
              {displayOrder.map((name) => (
                <BranchRow
                  key={name}
                  branch={rowFor(name)}
                  draggable={editable}
                  moved={movedNames.has(name)}
                  colorIndex={colorIndexByName.get(name) ?? currentDisplay.length}
                  onNudge={editable ? (delta) => nudge(name, delta) : undefined}
                  onCheckout={
                    busy ? undefined : () => vscodeApi.postMessage({ type: 'checkout', branch: name })
                  }
                />
              ))}
            </SortableContext>
          </StackColumn>
        </div>

        <Tray
          names={trayOrder}
          candidates={candidatesByName}
          byName={byName}
          enabled={editable}
          leaving={leaving}
        />

        <AddBranch
          top={currentDisplay[0]}
          blocked={
            busy
              ? 'An apply is in progress. Finish or dismiss it first.'
              : dirty
                ? 'Apply or reset the pending reorder first — adding a branch re-reads the ' +
                  'stack, which would discard it.'
                : undefined
          }
        />

        {/* Keeps the lifted row legible as it crosses between containers. */}
        <DragOverlay>
          {dragging ? (
            <div className="row row--overlay">
              <Node index={colorIndexByName.get(dragging) ?? currentDisplay.length} />
              <span className="name">{dragging}</span>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      <PlanView
        plan={
          // appliedPlan is null when the host replays a session this webview
          // never started, so fall back to the plan it replayed alongside it.
          (progress ? (appliedPlan ?? plan) : plan) ?? EMPTY_PLAN
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
