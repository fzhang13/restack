import type { CandidateBranch, Plan, PlanStep, Stack } from './model.ts';

/** Short SHA for display; plans still carry the full SHA in the command. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * Compute the git steps that would transform the stack's current order into
 * `proposedOrder` (bottom-to-top, index 0 sits on trunk).
 *
 * The load-bearing detail: each `git rebase --onto` passes the branch's
 * *recorded* base SHA as the upstream argument, captured before any rebase
 * runs. gh-stack hands us that SHA directly in `branch.base`.
 *
 * Using a branch name as upstream instead would be wrong. After step 1
 * rewrites feat/api, the ref `feat/api` points at new commits, so step 2's
 * upstream would resolve to the post-rebase tip and silently replay the wrong
 * commit range — dropping or duplicating commits with no error. Recorded SHAs
 * make each step independent of the steps before it.
 *
 * Steps carry both a display string and an `exec` argv. Apply runs the argv, so
 * what the panel shows is always what runs — no shell parsing in between, and
 * no chance of the two drifting apart.
 *
 * `proposedOrder` may also add branches (drawn from `candidates`) and drop ones
 * the stack currently holds. A dropped branch is rebased back onto trunk, which
 * detaches it from the stack without discarding its commits.
 *
 * `options.force` additionally replays branches gh-stack flags as drifted, even
 * though their position is unchanged. That is what `gh stack init` leaves
 * behind: adopting divergent branches records them in stack order without
 * rebasing them onto each other, so `needsRebase` is set while the order this
 * function diffs on is already correct. Anything above a drifted branch replays
 * too, since its parent's tip is about to move. Same recorded-SHA anchors and
 * same metadata write as a reorder — only the reason for replaying differs.
 *
 * `options.drifted` names branches to treat as drifted on top of whatever
 * gh-stack said. Needed because `needsRebase` was computed by `gh stack view`
 * before Restack did anything: after a fetch moves the trunk, or when the trunk
 * is being changed outright, the bottom branch has drifted and that flag has no
 * way of knowing. Supplementing rather than replacing keeps one code path for
 * every reason a branch might need replaying. Only read when `force` is set.
 */
export function computePlan(
  stack: Stack,
  proposedOrder: string[],
  candidates: CandidateBranch[] = [],
  options: { force?: boolean; drifted?: string[] } = {},
): Plan {
  const force = options.force === true;
  const alsoDrifted = new Set(options.drifted ?? []);
  const currentOrder = stack.branches.map((b) => b.name);
  const byName = new Map(stack.branches.map((b) => [b.name, b]));

  // Every anchor in one place: gh-stack's recorded base for stacked branches,
  // the merge-base with trunk for candidates. Both are pre-rebase SHAs, which
  // is the only property the cascade depends on.
  const baseOf = new Map<string, string>();
  for (const branch of stack.branches) {
    baseOf.set(branch.name, branch.base);
  }
  for (const candidate of candidates) {
    if (!baseOf.has(candidate.name)) {
      baseOf.set(candidate.name, candidate.base);
    }
  }

  const mergedBranches = stack.branches.filter((b) => b.isMerged).map((b) => b.name);
  const proposedSet = new Set(proposedOrder);
  const insertedBranches = proposedOrder.filter((n) => !byName.has(n));
  const removedBranches = currentOrder.filter((n) => !proposedSet.has(n));

  const orderUnchanged =
    insertedBranches.length === 0 &&
    removedBranches.length === 0 &&
    proposedOrder.length === currentOrder.length &&
    proposedOrder.every((name, i) => name === currentOrder[i]);

  // A forced plan with nothing drifted has nothing to do, and must still report
  // isNoop — that flag is what gates the Apply button and the host's own noop
  // check, so claiming work exists would offer an apply that runs no rebases.
  const hasDrift = proposedOrder.some(
    (name) => byName.get(name)?.needsRebase || alsoDrifted.has(name),
  );
  const isNoop = orderUnchanged && !(force && hasDrift);

  if (isNoop) {
    return { steps: [], proposedOrder, isNoop, mergedBranches, insertedBranches, removedBranches };
  }

  const steps: PlanStep[] = [];

  // Removals first, so the cascade below runs against a stack that already has
  // the departing branches out of the way. Each is anchored to its own recorded
  // base, so these stay independent of each other and of what follows.
  for (const name of removedBranches) {
    const oldBase = baseOf.get(name) ?? stack.trunk;
    const args = ['rebase', '--onto', stack.trunk, oldBase, name];
    steps.push({
      kind: 'rebase',
      branch: name,
      command: `git ${args.join(' ')}`,
      exec: { file: 'git', args },
      note: `Detach ${name} from the stack, replaying it onto ${stack.trunk}. Its commits are kept.`,
    });
  }

  // Bottom-up: each branch is rebased onto whatever now sits beneath it.
  //
  // Once one branch replays, its tip SHA changes, so everything above it has to
  // replay too even if its parent is still called the same thing. Tracking that
  // as a running flag is what makes this exact: a branch is skipped only when
  // its parent is unchanged *and* nothing beneath it was rewritten. A removal
  // above a branch, for instance, leaves it entirely alone.
  let rewrittenBelow = false;

  proposedOrder.forEach((name, index) => {
    const oldBase = baseOf.get(name);
    if (oldBase === undefined) {
      return; // Neither stacked nor a known candidate: no anchor to replay from.
    }

    const newBaseRef = index === 0 ? stack.trunk : proposedOrder[index - 1];
    const currentIndex = currentOrder.indexOf(name);
    const previousBaseRef = currentIndex === 0 ? stack.trunk : currentOrder[currentIndex - 1];

    // A branch joining the stack always replays: it has never sat here.
    const isInserted = currentIndex < 0;
    const parentUnchanged = !isInserted && newBaseRef === previousBaseRef;
    // Under `force`, a branch gh-stack flags as drifted replays even though its
    // position is unchanged — and, via the running flag below, so does
    // everything above it, because its tip is about to move.
    const drifted =
      force && ((byName.get(name)?.needsRebase ?? false) || alsoDrifted.has(name));

    if (parentUnchanged && !rewrittenBelow && !drifted) {
      return;
    }
    rewrittenBelow = true;

    const args = ['rebase', '--onto', newBaseRef, oldBase, name];
    steps.push({
      kind: 'rebase',
      branch: name,
      command: `git ${args.join(' ')}`,
      exec: { file: 'git', args },
      note: oldBase
        ? `${isInserted ? 'Add' : 'Replay'} ${name} onto ${newBaseRef}, taking commits after ${shortSha(oldBase)}.`
        : `Replay ${name} onto ${newBaseRef}.`,
    });
  });

  if (steps.length > 0) {
    // Rendered as a shell comment so the plan stays pasteable, but it is a real
    // step: rebasing alone leaves .git/gh-stack describing the old order, and
    // `gh stack submit` would then retarget PR bases from stale data. Anyone
    // running these commands by hand has to reorder that file too, or use
    // `gh stack modify`. See metadata.ts.
    steps.push({
      kind: 'metadata',
      command: '# Restack rewrites .git/gh-stack: branch order + recorded base SHAs',
      note: 'Rebasing does not update gh-stack’s own state file. Without this, `gh stack view` reports the old order and submit retargets the wrong bases.',
    });

    steps.push(...publishSteps());
  }

  return { steps, proposedOrder, isNoop, mergedBranches, insertedBranches, removedBranches };
}

/**
 * Move the trunk onto its upstream, before the cascade replays on top of it.
 *
 * Two forms, because git allows exactly one of them at a time — verified
 * against git 2.50:
 *
 *   - Trunk not checked out: `git fetch <remote> <trunk>:<trunk>`. This form
 *     refuses anything but a fast-forward, and refuses outright if the branch
 *     is checked out (`refusing to fetch into branch ... checked out at`). The
 *     safety is git's own, not a check we have to write.
 *   - Trunk checked out: `git merge --ff-only <remote>/<trunk>`, which is the
 *     same guarantee by the route that works with a working tree attached.
 *
 * Fast-forward-only in both cases on purpose. A trunk that cannot fast-forward
 * has local commits of its own or was force-pushed, and quietly merging or
 * resetting it is not something a sync should decide by itself — the step fails
 * and the runner surfaces git's message.
 *
 * The `fetch` form does contact the remote, but by the time it runs the objects
 * are already local: handleSyncStack fetches before building the plan. It is
 * the ref move that matters here.
 */
export function trunkSyncStep(trunk: string, remote: string, checkedOut: boolean): PlanStep {
  const args = checkedOut
    ? ['merge', '--ff-only', `${remote}/${trunk}`]
    : ['fetch', remote, `${trunk}:${trunk}`];
  return {
    kind: 'trunk',
    branch: trunk,
    command: `git ${args.join(' ')}`,
    exec: { file: 'git', args },
    note: checkedOut
      ? `Fast-forward ${trunk} onto ${remote}/${trunk}. Fails rather than merging if it has diverged.`
      : `Fast-forward ${trunk} onto ${remote}/${trunk}. Git refuses anything but a fast-forward.`,
  };
}

/**
 * Bring the stack up to date with a trunk that has moved: fast-forward the
 * trunk, then replay the stack onto it.
 *
 * The bottom branch is passed as `drifted` because it *is* — its recorded base
 * is the trunk SHA from before the fetch. That recorded SHA is what makes the
 * replay exact: `git rebase --onto <trunk> <oldTrunkSha> <bottom>` takes
 * precisely the commits after the old trunk tip, which is the bottom branch's
 * own work and nothing else. Everything above it then cascades through the
 * ordinary rewrittenBelow logic in computePlan.
 *
 * The order is unchanged, so this is `force` in the same sense the drift banner
 * uses it, and it arrives with the same metadata write, push, and submit steps
 * as any other plan.
 */
export function syncPlan(stack: Stack, remote: string, trunkCheckedOut: boolean): Plan {
  const order = stack.branches.map((b) => b.name);
  const bottom = order[0];
  const plan = computePlan(stack, order, [], {
    force: true,
    drifted: bottom ? [bottom] : [],
  });

  if (plan.isNoop) {
    // Only reachable with an empty stack: with any branch at all the bottom is
    // marked drifted above, so there is always something to replay. Returned
    // without a trunk step because there would be nothing for it to precede.
    return plan;
  }

  return { ...plan, steps: [trunkSyncStep(stack.trunk, remote, trunkCheckedOut), ...plan.steps] };
}

/**
 * Re-base an entire stack onto a different branch.
 *
 * The whole change is `{...stack, trunk: newBase}`: computePlan reads the trunk
 * off the stack it is given, so the bottom branch's `rebase --onto` targets the
 * new base and everything above cascades. The caller passes the same modified
 * stack to the runner, which is what makes the metadata write record the new
 * trunk — see writeMetadata in apply.ts.
 *
 * As in syncPlan, the bottom branch is marked drifted because its recorded base
 * still points into the old trunk.
 */
export function changeBasePlan(stack: Stack, newBase: string): Plan {
  const order = stack.branches.map((b) => b.name);
  const bottom = order[0];
  return computePlan({ ...stack, trunk: newBase }, order, [], {
    force: true,
    drifted: bottom ? [bottom] : [],
  });
}

/**
 * The argv for creating a stack: `gh stack init --base <trunk> a b c`, with
 * branches bottom-to-top.
 *
 * Lives here, beside the other command builders, because it is Node-free and
 * so the webview can call it too — the command previewed before the button is
 * pressed is built by the same function that runs it, the same way PlanStep
 * pairs `command` with `exec`.
 */
export function initArgs(trunk: string, branches: string[]): string[] {
  return ['stack', 'init', '--base', trunk, ...branches];
}

/**
 * The argv for extending a stack: `gh stack add <branch>`.
 *
 * Takes one branch, not a list, because gh-stack does: v0.1.0 accepts a single
 * optional name and refuses anywhere but the top —
 * `can only add branches to the top of the stack`. The host checks the top
 * branch out first rather than surfacing that refusal.
 *
 * Whether the branch exists decides what the command means, and gh-stack picks
 * for itself: a name it can resolve is adopted, one it cannot is created. Both
 * are the same argv, so the preview shown beside the button stays honest either
 * way — only the sentence under it changes.
 */
export function addArgs(branch: string): string[] {
  return ['stack', 'add', branch];
}

/**
 * The argv for dissolving a stack: `gh stack unstack`, or `--local` to stop at
 * the metadata file.
 *
 * With no stack argument gh-stack targets the stack holding the checked-out
 * branch — which is exactly the stack the view is rendering, so the command
 * needs nothing else to identify it. Neither form rewrites a commit or moves a
 * branch ref; the branches simply stop being tracked as a stack.
 */
export function unstackArgs(local: boolean): string[] {
  return local ? ['stack', 'unstack', '--local'] : ['stack', 'unstack'];
}

/**
 * The remote half: push, then submit.
 *
 * `gh stack push` does per-branch `--force-with-lease` itself and skips merged
 * and queued branches, so it replaces a hand-rolled `git push` over a branch
 * list — which would have to reproduce those rules and would drift when
 * gh-stack changes them. It reads the branch list from `.git/gh-stack`, so it
 * must run after the metadata write.
 *
 * Pushing before submitting is not redundant even though submit pushes too: a
 * rejected lease surfaces here, before any PR base has been retargeted.
 *
 * Shared with the standalone Push & Submit action, which runs these two steps
 * with no reorder in front of them.
 */
export function publishSteps(): PlanStep[] {
  const pushArgs = ['stack', 'push'];
  const submitArgs = ['stack', 'submit', '--auto'];
  return [
    {
      kind: 'push',
      command: `gh ${pushArgs.join(' ')}`,
      exec: { file: 'gh', args: pushArgs },
      note: 'Per-branch --force-with-lease, refusing to clobber commits you have not seen. Merged and queued branches are skipped.',
    },
    {
      // --auto skips the interactive editor, which cannot run from a webview.
      kind: 'submit',
      command: `gh ${submitArgs.join(' ')}`,
      exec: { file: 'gh', args: submitArgs },
      note: 'Retargets each PR base and updates the stack on GitHub. --auto skips the interactive editor.',
    },
  ];
}
