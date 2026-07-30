import type { Plan, PlanStep, Stack } from './model.ts';

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
 * v0 computes and displays only. Nothing here executes.
 */
export function computePlan(stack: Stack, proposedOrder: string[]): Plan {
  const currentOrder = stack.branches.map((b) => b.name);
  const byName = new Map(stack.branches.map((b) => [b.name, b]));

  const mergedBranches = stack.branches.filter((b) => b.isMerged).map((b) => b.name);

  const isNoop =
    proposedOrder.length === currentOrder.length &&
    proposedOrder.every((name, i) => name === currentOrder[i]);

  if (isNoop) {
    return { steps: [], proposedOrder, isNoop, mergedBranches };
  }

  const steps: PlanStep[] = [];

  // Bottom-up: each branch is rebased onto whatever now sits beneath it.
  proposedOrder.forEach((name, index) => {
    const branch = byName.get(name);
    if (!branch) {
      return;
    }

    const newBaseRef = index === 0 ? stack.trunk : proposedOrder[index - 1];
    const oldBase = branch.base;
    const currentIndex = currentOrder.indexOf(name);
    const previousBaseRef = currentIndex === 0 ? stack.trunk : currentOrder[currentIndex - 1];

    // Skip branches whose parent is unchanged — but only when nothing below
    // them moved, since a rewritten ancestor forces a replay regardless.
    const parentUnchanged = newBaseRef === previousBaseRef;
    const ancestorsMoved = proposedOrder
      .slice(0, index)
      .some((n) => currentOrder.indexOf(n) !== proposedOrder.indexOf(n));

    if (parentUnchanged && !ancestorsMoved) {
      return;
    }

    steps.push({
      kind: 'rebase',
      branch: name,
      command: `git rebase --onto ${newBaseRef} ${oldBase} ${name}`,
      note: oldBase
        ? `Replay ${name} onto ${newBaseRef}, taking commits after ${shortSha(oldBase)}.`
        : `Replay ${name} onto ${newBaseRef}.`,
    });
  });

  if (steps.length > 0) {
    const touched = steps.filter((s) => s.kind === 'rebase').map((s) => s.branch!);
    steps.push({
      kind: 'push',
      command: `git push --force-with-lease origin ${touched.join(' ')}`,
      note: 'force-with-lease refuses to clobber commits you have not seen.',
    });
    steps.push({
      kind: 'submit',
      command: 'gh stack submit',
      note: 'Retargets each PR base and updates the stack on GitHub.',
    });
  }

  return { steps, proposedOrder, isNoop, mergedBranches };
}
