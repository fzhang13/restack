import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import type {
  CandidateBranch,
  RemoteStackSummary,
  StackBranch,
  StackSummary,
} from '../../model';
import { initArgs } from '../../plan';
import { BranchRow } from '../components/BranchRow';
import { Message, Node } from '../components/primitives';
import { RemoteStackList } from '../components/RemoteStacks';
import { StackColumn } from '../components/StackColumn';
import { StackRow } from '../components/StackSwitcher';
import { Tray } from '../components/Tray';
import { STACK_ID, TRAY_ID } from '../lib/constants';
import { toModelOrder } from '../lib/order';
import { vscodeApi } from '../vscode';

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
export function InitView({
  message,
  trunk: detectedTrunk,
  localBranches,
  remoteBranches,
  stacks,
  remoteStacks,
  candidates,
}: {
  message: string;
  trunk?: string;
  localBranches: string[];
  /** Qualified remote refs (`origin/their-work`), offered as a base of their own. */
  remoteBranches: string[];
  stacks: StackSummary[];
  /** Stacks on GitHub only. The most useful thing an empty repository can offer. */
  remoteStacks: RemoteStackSummary[];
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

      {/*
        Most valuable exactly here. A fresh clone has nothing in
        `.git/gh-stack`, so this screen used to offer only "create a stack" to
        someone whose stack already exists — on GitHub, made from another
        machine or by a colleague.
      */}
      <RemoteStackList stacks={remoteStacks} />

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
