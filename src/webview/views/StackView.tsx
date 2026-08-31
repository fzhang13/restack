import { useCallback, useMemo, useState } from 'react';
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
import type { Stack, StackBranch } from '../../model';
import { AddBranch } from '../components/AddBranch';
import { PrBaseBadge, TrackingBadge } from '../components/badges';
import { Banners } from '../components/Banners';
import { BranchRow } from '../components/BranchRow';
import { ChangeTree } from '../components/ChangeTree';
import { PlanView } from '../components/PlanView';
import { CheckoutButton, Node, PrTag } from '../components/primitives';
import { RemoteStackList } from '../components/RemoteStacks';
import { BaseButton, StackColumn } from '../components/StackColumn';
import { StackSwitcher } from '../components/StackSwitcher';
import { Toolbar } from '../components/Toolbar';
import { Tray } from '../components/Tray';
import { WorkingTreePanel } from '../components/WorkingTree';
import type { HostState } from '../hooks/useHostState';
import { EMPTY_PLAN, TRAY_ID } from '../lib/constants';
import { toDisplayOrder, toModelOrder } from '../lib/order';
import { vscodeApi } from '../vscode';

/**
 * The reorder view: two columns, the tray, and the plan the host builds from
 * whatever the drag left behind.
 *
 * Takes the whole host state rather than a dozen props — it is the one consumer
 * of nearly all of it, and the alternative is threading `setDisplayOrder`
 * through three layers to reach the drag handler that owns it.
 */
export function StackView({ stack, host }: { stack: Stack; host: HostState }) {
  const {
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
    changes,
    changesEpoch,
    commitCounts,
    workingTree,
  } = host;

  const [dragging, setDragging] = useState<string | null>(null);

  /** Branches whose change tree is open. Collapsed is the default: the tree is
      a read of the repository, and most of the time the order is the question. */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleExpanded = useCallback((name: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        // No request from here: mounting ChangeTree posts it, and asking in
        // both places would post twice for every expand.
        next.add(name);
      }
      return next;
    });
  }, []);

  const sensors = useSensors(
    // A small activation distance keeps clicks from registering as drags.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const byName = useMemo(
    () => new Map(stack.branches.map((b) => [b.name, b])),
    [stack],
  );

  const candidatesByName = useMemo(
    () => new Map(candidates.map((c) => [c.name, c])),
    [candidates],
  );

  const currentDisplay = useMemo(
    () => toDisplayOrder(stack.branches.map((b) => b.name)),
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
   * The PRs of the stack we are standing in, keyed by branch — the only place
   * `baseRefName` reaches the view.
   *
   * Taken from the switcher's own summaries rather than a field of its own on
   * the stack message: `readStackSummaries` already matched every branch in
   * every stack against GitHub, and the active one is in there by definition.
   */
  const activePrs = useMemo(
    () => stacks.find((s) => s.isActive)?.prs ?? {},
    [stacks],
  );

  /**
   * The branch each row's PR *should* be targeting: the one below it, or the
   * trunk for the bottom of the stack. Built from the current order, not the
   * proposed one — a pending reorder describes a future the PRs have not been
   * retargeted to yet, and flagging every row mid-drag would say nothing.
   */
  const expectedBaseByName = useMemo(() => {
    const bottomUp = stack.branches.map((b) => b.name);
    return new Map(
      bottomUp.map((name, i) => [name, i === 0 ? stack.trunk : bottomUp[i - 1]]),
    );
  }, [stack]);

  /**
   * Where HEAD is. `currentBranch` and `isCurrent` come straight from
   * `gh stack view`, which reports the stack whether or not HEAD is inside it —
   * so standing on the trunk, or on some branch entirely outside, are both
   * positions to state rather than states to hide.
   */
  const head = useMemo(() => {
    const name = stack.currentBranch;
    const branches = stack.branches;
    const index = branches.findIndex((b) => b.name === name);
    return {
      name,
      onTrunk: !!name && name === stack.trunk,
      /** 1-based from the bottom, matching how the column is counted. */
      position: index >= 0 ? index + 1 : 0,
      total: branches.length,
      /** Neither in the stack nor on its trunk — gh-stack can report this. */
      outside: !!name && name !== stack.trunk && index < 0,
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
    [displayOrder, trayOrder, submitOrder, setDisplayOrder, setTrayOrder],
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
    [displayOrder, submitOrder, setDisplayOrder],
  );

  const reset = useCallback(() => {
    setDisplayOrder(currentDisplay);
    setTrayOrder(candidates.map((c) => c.name));
    setPlan(null);
  }, [currentDisplay, candidates, setDisplayOrder, setTrayOrder, setPlan]);

  const apply = useCallback(() => {
    if (!plan || plan.isNoop) {
      return;
    }
    // Freeze the plan being applied. A successful apply refreshes the stack,
    // which clears `plan` — but the panel still has to show what ran.
    setAppliedPlan(plan);
    vscodeApi.postMessage({ type: 'apply', order: toModelOrder(displayOrder) });
  }, [plan, displayOrder, setAppliedPlan]);

  const dismissApply = useCallback(() => {
    setProgress(null);
    setAppliedPlan(null);
    vscodeApi.postMessage({ type: 'applyDismiss' });
  }, [setProgress, setAppliedPlan]);

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
      <RemoteStackList stacks={remoteStacks} />

      <Toolbar
        busy={busy}
        dirty={dirty}
        canPublish={canPublish}
        remote={remote}
        onReset={reset}
      />

      <Banners
        stack={stack}
        head={head}
        hasMerged={hasMerged}
        behind={behind}
        trunkBehind={trunkBehind}
        drifted={drifted}
        leavingWithPrs={leavingWithPrs}
        remote={remote}
        busy={busy}
      />

      <WorkingTreePanel workingTree={workingTree ?? null} busy={busy} />

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
                <li
                  key={name}
                  className={`row row--static ${branch.isCurrent ? 'row--current' : ''} ${
                    expanded.has(name) ? 'row--expanded' : ''
                  }`}
                >
                  <div className="row__line">
                    <button
                      type="button"
                      className="row__twisty"
                      aria-expanded={expanded.has(name)}
                      aria-label={`${expanded.has(name) ? 'Hide' : 'Show'} changes in ${name}`}
                      onClick={() => toggleExpanded(name)}
                    >
                      {expanded.has(name) ? '▾' : '▸'}
                    </button>
                    <Node index={i} isHead={branch.isCurrent} />
                    <span className="name">{branch.name}</span>
                    {branch.prNumber && <PrTag branch={branch} />}
                    {commitCounts[name] !== undefined && (
                      <span
                        className="badge badge--commits"
                        title={`${commitCounts[name]} commit${
                          commitCounts[name] === 1 ? '' : 's'
                        } of its own`}
                      >
                        {commitCounts[name]}
                      </span>
                    )}
                    {branch.isCurrent && <span className="badge badge--HEAD">HEAD</span>}
                    {/* Only on this column: the proposed one describes a future
                        state, and these counts are about the present. */}
                    <TrackingBadge tracking={trackingByName.get(name)} />
                    <PrBaseBadge
                      pr={activePrs[name]}
                      expected={expectedBaseByName.get(name) ?? stack.trunk}
                    />
                    {!branch.isCurrent && <CheckoutButton branch={name} disabled={busy} />}
                  </div>
                  {expanded.has(name) && (
                    <ChangeTree
                      branch={name}
                      changes={changes[name]}
                      changesEpoch={changesEpoch}
                      hasStaged={(workingTree?.staged.length ?? 0) > 0}
                    />
                  )}
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
