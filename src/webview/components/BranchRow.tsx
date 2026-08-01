import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { StackBranch } from '../../model';
import { CheckoutButton, Node, PrTag } from './primitives';

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

export function BranchRow({
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
