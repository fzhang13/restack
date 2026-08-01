import * as vscode from 'vscode';
import { addArgs } from '../../plan';
import { addPreflight, runAdd } from '../../init';
import { checkout } from '../git';
import { blockedByApply, type Host } from '../host';

/**
 * Extend an existing stack by one branch, on top of it.
 *
 * The counterpart to init's typed-in branch, which was only ever reachable
 * from the empty state — once a stack existed there was no way to say "and
 * one more on top" without a terminal. Dragging does not cover it either: a
 * branch created just now is fully merged into trunk, so readCandidates
 * filters it out of the tray and it never appears to drag.
 *
 * Top-only because gh-stack is: v0.1.0 exits 5 with `can only add branches to
 * the top of the stack` anywhere else. So we stand there first — which is a
 * checkout, and the reason addPreflight refuses a dirty tree even though
 * `gh stack add` itself does not.
 *
 * Not an apply: nothing is rebased and no commit is rewritten, so there is no
 * plan to preview and nothing to snapshot. An adopted branch lands flagged
 * `needsRebase`, exactly as init leaves one, and the drift banner's
 * *Rebase stack* button is the undoable step that replays it.
 */
export async function handleAddBranch(host: Host, branch: string): Promise<void> {
  const cwd = host.cwd();
  const stack = host.stack;
  if (!cwd || !stack) {
    return;
  }

  if (blockedByApply(host)) {
    return;
  }

  const name = branch.trim();
  const names = stack.branches.map((b) => b.name);

  await host.guard(async () => {
    const blocked = await addPreflight(cwd, stack.trunk, names, name);
    if (blocked) {
      void vscode.window.showErrorMessage(`Restack: ${blocked}`);
      return;
    }

    // gh stack add only works from the top. Doing this ourselves rather than
    // letting gh-stack refuse keeps the failure modes to one: the checkout is
    // guarded by the same dirty-tree check as every other checkout here.
    const top = names[names.length - 1];
    if (top && stack.currentBranch !== top) {
      host.log.appendLine(`Moving to the top of the stack to add ${name}: git checkout ${top}`);
      const moved = await checkout(cwd, top);
      if (moved) {
        void vscode.window.showErrorMessage(`Restack: ${moved}`);
        return;
      }
    }

    host.log.appendLine(`Adding a branch: gh ${addArgs(name).join(' ')}`);
    const failure = await runAdd(cwd, host.ghPath(), name);
    if (failure) {
      void vscode.window.showErrorMessage(`Restack: ${failure}`);
      host.log.show(true);
    }

    // Either way, for init's reason: a failed add can still have created the
    // branch, and the view has to show what is actually on disk. Success also
    // moves HEAD onto the new branch, which the indicator should follow.
    await host.refresh();
  });
}
