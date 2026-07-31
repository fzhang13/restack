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
 * Steps carry both a display string and an `exec` argv. Apply runs the argv, so
 * what the panel shows is always what runs — no shell parsing in between, and
 * no chance of the two drifting apart.
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

    const args = ['rebase', '--onto', newBaseRef, oldBase, name];
    steps.push({
      kind: 'rebase',
      branch: name,
      command: `git ${args.join(' ')}`,
      exec: { file: 'git', args },
      note: oldBase
        ? `Replay ${name} onto ${newBaseRef}, taking commits after ${shortSha(oldBase)}.`
        : `Replay ${name} onto ${newBaseRef}.`,
    });
  });

  if (steps.length > 0) {
    const touched = steps.filter((s) => s.kind === 'rebase').map((s) => s.branch!);

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

    const pushArgs = ['push', '--force-with-lease', 'origin', ...touched];
    steps.push({
      kind: 'push',
      command: `git ${pushArgs.join(' ')}`,
      exec: { file: 'git', args: pushArgs },
      note: 'force-with-lease refuses to clobber commits you have not seen.',
    });

    // --auto skips the interactive editor, which cannot run from a webview.
    const submitArgs = ['stack', 'submit', '--auto'];
    steps.push({
      kind: 'submit',
      command: `gh ${submitArgs.join(' ')}`,
      exec: { file: 'gh', args: submitArgs },
      note: 'Retargets each PR base and updates the stack on GitHub. --auto skips the interactive editor.',
    });
  }

  return { steps, proposedOrder, isNoop, mergedBranches };
}
