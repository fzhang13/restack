import { useDroppable } from '@dnd-kit/core';
import type { StackBranch, Tracking } from '../../model';
import { vscodeApi } from '../vscode';
import { TrackingBadge } from './badges';
import { CheckoutButton } from './primitives';

/**
 * Move the whole stack onto a different branch.
 *
 * Opens the host's QuickPick rather than rendering a `<select>` here, because
 * the webview cannot build the list. The one base every such stack eventually
 * wants — back to `main`, once the colleague's branch merges — is a branch the
 * trunk already contains, and so is filtered out of `candidates` as merged.
 * The host enumerates local and remote refs directly and has no such gap.
 */
export function BaseButton({ disabled }: { disabled?: boolean }) {
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

export function StackColumn({
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
