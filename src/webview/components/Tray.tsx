import { useDroppable } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { CandidateBranch, StackBranch } from '../../model';
import { TRAY_ID } from '../lib/constants';
import { PrTag } from './primitives';

/**
 * Branches that could join the stack, and branches dragged out of it.
 *
 * A drop target in its own right, so removing a branch is the same gesture as
 * adding one. Rendered full width below the columns rather than as a third
 * column — the two existing ones already collapse to one at 420px.
 */
export function Tray({
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
