import * as vscode from 'vscode';
import { listLocalBranches } from '../init';
import { listRemoteBranches, listRemotes, localNameFor } from '../remote';
import type { Stack, StackSummary } from '../model';

/**
 * The three QuickPicks the palette entry points open.
 *
 * Each one only picks. The command that opened it decides what the choice
 * means, so the same handler serves the palette and the button in the view
 * that posts to it directly.
 */

/**
 * Pick a branch to check out from the stack.
 *
 * Listed top-down, matching the view, with the trunk last: it is where the
 * stack sits rather than a part of it, but it is still somewhere you stand.
 */
export async function pickBranch(stack: Stack): Promise<string | undefined> {
  const current = stack.currentBranch;
  const items: Array<vscode.QuickPickItem & { branch: string }> = [
    ...[...stack.branches].reverse().map((b, i) => ({
      branch: b.name,
      label: `${b.name === current ? '$(check) ' : '$(circle-outline) '}${b.name}`,
      description: b.prNumber ? `#${b.prNumber}` : undefined,
      detail: [
        `${stack.branches.length - i} of ${stack.branches.length}`,
        b.isMerged ? 'merged' : b.isQueued ? 'queued' : '',
        b.needsRebase ? 'needs rebase' : '',
      ]
        .filter(Boolean)
        .join(' · '),
    })),
    {
      branch: stack.trunk,
      label: `${stack.trunk === current ? '$(check) ' : '$(circle-outline) '}${stack.trunk}`,
      description: 'trunk',
    },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Check out a branch in this stack',
    placeHolder: current ? `On ${current}` : 'Select a branch',
  });
  // Picking the branch already checked out is a no-op, not a checkout.
  return picked && picked.branch !== current ? picked.branch : undefined;
}

/** Pick one of the repository's stacks, by index. */
export async function pickStack(stacks: StackSummary[]): Promise<number | undefined> {
  const items = stacks.map((s) => ({
    index: s.index,
    label: `${s.isActive ? '$(check) ' : '$(circle-outline) '}Stack ${s.index}`,
    description: [...s.branches].reverse().join(' ← '),
    detail: [
      `on ${s.trunk}`,
      `${s.branches.length} branch${s.branches.length === 1 ? '' : 'es'}`,
      Object.keys(s.prs).length > 0 ? `${Object.keys(s.prs).length} PRs` : '',
      s.behind > 0 ? `${s.behind} behind` : '',
    ]
      .filter(Boolean)
      .join(' · '),
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Switch to a stack in this repository',
    placeHolder: 'Checks out that stack’s top branch',
  });
  return picked?.index;
}

/**
 * Pick a branch for the stack to sit on: every local and remote branch that is
 * not already in it. Returns undefined both when nothing was picked and when
 * there was nothing to pick, having said so in the second case.
 */
export async function pickBase(
  cwd: string,
  stack: Stack,
): Promise<{ base: string; isRemote: boolean } | undefined> {
  const inStack = new Set(stack.branches.map((b) => b.name));
  const [locals, remotes] = await Promise.all([listLocalBranches(cwd), listRemoteBranches(cwd)]);
  const remoteNames = await listRemotes(cwd);

  const items: Array<vscode.QuickPickItem & { base: string; isRemote: boolean }> = [
    ...locals
      .filter((n) => !inStack.has(n) && n !== stack.trunk)
      .map((n) => ({ base: n, isRemote: false, label: `$(git-branch) ${n}` })),
    ...remotes
      .filter((n) => !inStack.has(localNameFor(n, remoteNames)))
      .map((n) => ({
        base: n,
        isRemote: true,
        label: `$(cloud) ${n}`,
        description: 'creates a local tracking branch',
      })),
  ];

  if (items.length === 0) {
    void vscode.window.showInformationMessage('Restack: no other branch to base this stack on.');
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: `Re-base this stack (currently on ${stack.trunk})`,
    placeHolder: 'Pick the branch the bottom of the stack should sit on',
  });
  return picked ? { base: picked.base, isRemote: picked.isRemote } : undefined;
}
