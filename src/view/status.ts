import * as vscode from 'vscode';
import type { Stack, StackSummary } from '../model';

/**
 * Mirror HEAD's position in the status bar, so the stack is legible without
 * the view open. Hidden whenever there is no stack to be positioned within.
 */
export function updateStatus(
  status: vscode.StatusBarItem,
  stack: Stack | undefined,
  stacks: StackSummary[],
): void {
  if (!stack || !stack.currentBranch) {
    status.hide();
    return;
  }

  const total = stack.branches.length;
  const index = stack.branches.findIndex((b) => b.name === stack.currentBranch);
  const onTrunk = stack.currentBranch === stack.trunk;

  // Counted from the bottom, so it reads the same way the column does.
  const position = onTrunk ? 'trunk' : index >= 0 ? `${index + 1}/${total}` : 'outside';
  // Which stack, when there is more than one to be in. Silent otherwise: in
  // the ordinary single-stack repository "stack 1 of 1" is noise.
  const active = stacks.find((s) => s.isActive);
  const which =
    stacks.length > 1 && active ? ` · stack ${active.index} of ${stacks.length}` : '';

  status.text = `$(git-branch) ${stack.currentBranch} ${position}${which}`;
  status.tooltip =
    (onTrunk
      ? `On ${stack.trunk}, the trunk this stack sits on.`
      : index >= 0
        ? `On ${stack.currentBranch} — branch ${index + 1} of ${total} in the stack.`
        : `On ${stack.currentBranch}, which is not part of this stack.`) +
    (which ? `\n\nThis repository has ${stacks.length} stacks.` : '') +
    '\n\nClick to check out another branch in the stack.';
  status.show();
}
