import * as vscode from 'vscode';
import { hasOrigin } from '../apply';
import type { UnstackScope } from '../init';
import type { ApplyScope, Plan, RemoteStackSummary, Stack } from '../model';

/**
 * Every modal Restack puts in front of an action, in one place.
 *
 * They are gathered here because they are the same kind of thing and were the
 * bulkiest part of the provider — each one is a paragraph explaining what is
 * about to be rewritten and what can be taken back. Each returns the user's
 * decision and nothing else; the operation that called it does the work.
 */

export async function confirmApply(
  branches: string[],
  trunk: string,
  canPublish: boolean,
  plan: Plan,
): Promise<ApplyScope | undefined> {
  const list = branches.join(', ');
  // Offering "Apply & Publish" without a remote is worse than useless:
  // preflight refuses the whole apply, so the local reorder the user also
  // asked for never runs either.
  const publishNote = canPublish
    ? `"Apply & Publish" additionally force-pushes and runs gh stack submit, ` +
      `which updates your pull requests on GitHub. You will be asked to confirm ` +
      `that separately.`
    : `This repository has no origin remote, so there is nothing to publish to.`;

  // Membership changes are the part a reorder-shaped dialog would hide, so
  // they get their own line.
  const membership = [
    plan.insertedBranches.length > 0
      ? `Joining the stack: ${plan.insertedBranches.join(', ')}.`
      : '',
    plan.removedBranches.length > 0
      ? `Leaving the stack, rebased back onto ${trunk}: ${plan.removedBranches.join(', ')}.`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  const choice = await vscode.window.showWarningMessage(
    `Rewrite ${branches.length} branch${branches.length === 1 ? '' : 'es'} on ${trunk}?`,
    {
      modal: true,
      detail:
        `Restack will rebase ${list}, then update .git/gh-stack to record the new ` +
        `order.\n\n${membership}${membership ? '\n\n' : ''}This rewrites local history. ` +
        `Restack snapshots every branch SHA first and can roll back if a rebase ` +
        `conflicts.\n\n${publishNote}`,
    },
    ...(canPublish ? ['Apply Locally', 'Apply & Publish'] : ['Apply Locally']),
  );

  if (choice === 'Apply Locally') return 'local';
  if (choice === 'Apply & Publish') return 'publish';
  return undefined;
}

export async function confirmRemove(cwd: string, stack: Stack): Promise<UnstackScope | undefined> {
  const names = stack.branches.map((b) => b.name);
  const withPrs = stack.branches.filter((b) => b.prNumber);
  // The remote half only has something to do when there are PRs to detach,
  // and somewhere to reach them.
  const canUnstackRemote = withPrs.length > 0 && (await hasOrigin(cwd));

  const remoteNote = canUnstackRemote
    ? `"Remove & Unstack PRs" additionally runs \`gh stack unstack\`, which detaches ` +
      `${withPrs.map((b) => `#${b.prNumber}`).join(', ')} from the stack on GitHub. ` +
      `Restack cannot undo that.`
    : withPrs.length === 0
      ? `No branch here has a pull request, so there is nothing on GitHub to unstack.`
      : `This repository has no origin remote, so there is nothing on GitHub to unstack.`;

  const choice = await vscode.window.showWarningMessage(
    `Remove this stack of ${names.length} branch${names.length === 1 ? '' : 'es'}?`,
    {
      modal: true,
      detail:
        `Removes the stack from gh-stack's tracking. Every branch and every commit ` +
        `stays exactly where it is — ${names.join(', ')} remain as ordinary branches ` +
        `on ${stack.trunk}. Nothing is rebased and nothing is deleted.\n\n` +
        `"Remove Locally" runs \`gh stack unstack --local\`, which touches only ` +
        `.git/gh-stack.\n\n${remoteNote}`,
    },
    ...(canUnstackRemote ? ['Remove Locally', 'Remove & Unstack PRs'] : ['Remove Locally']),
  );

  if (choice === 'Remove Locally') return 'local';
  if (choice === 'Remove & Unstack PRs') return 'remote';
  return undefined;
}

export async function confirmRebase(branches: string[], trunk: string): Promise<boolean> {
  const confirmed = await vscode.window.showWarningMessage(
    `Rebase ${branches.length} branch${branches.length === 1 ? '' : 'es'} onto ${trunk}?`,
    {
      modal: true,
      detail:
        `Replays ${branches.join(', ')} onto the branch below it, so each one ` +
        `actually sits on its recorded parent.\n\nThis rewrites local history. ` +
        `Restack snapshots every branch SHA first and can roll back.`,
    },
    'Rebase Stack',
  );
  return confirmed === 'Rebase Stack';
}

export async function confirmSync(
  trunk: string,
  remote: string,
  behind: number,
  rebases: string[],
): Promise<boolean> {
  const confirmed = await vscode.window.showWarningMessage(
    `Fast-forward ${trunk} and replay ${rebases.length} branch${rebases.length === 1 ? '' : 'es'}?`,
    {
      modal: true,
      detail:
        `${trunk} is ${behind} commit${behind === 1 ? '' : 's'} behind ` +
        `${remote}/${trunk}. Restack will fast-forward it, then replay ` +
        `${rebases.join(', ')} on top.\n\nThis rewrites local history. Every branch SHA ` +
        `is snapshotted first and can be rolled back. Nothing is pushed.`,
    },
    'Sync Stack',
  );
  return confirmed === 'Sync Stack';
}

export async function confirmChangeBase(
  from: string,
  to: string,
  bottom: string | undefined,
  staleness: string | undefined,
  withPr: number | undefined,
): Promise<boolean> {
  const confirmed = await vscode.window.showWarningMessage(
    `Re-base this stack from ${from} onto ${to}?`,
    {
      modal: true,
      detail:
        `Replays ${bottom} onto ${to}, and cascades every branch above it. ` +
        `.git/gh-stack is updated to record ${to} as the trunk.\n\n` +
        (staleness ? `${staleness}\n\n` : '') +
        (withPr
          ? `#${withPr} currently targets ${from}; the next \`gh stack submit\` ` +
            `will retarget it to ${to}.\n\n`
          : '') +
        `This rewrites local history. Every branch SHA is snapshotted first and can ` +
        `be rolled back. Nothing is pushed.`,
    },
    'Change Base',
  );
  return confirmed === 'Change Base';
}

export async function confirmPublish(): Promise<boolean> {
  const confirmed = await vscode.window.showWarningMessage(
    'Push the reordered stack to GitHub?',
    {
      modal: true,
      detail:
        'Force-pushes the rebased branches with --force-with-lease, then runs ' +
        '`gh stack submit --auto` to retarget each PR base.\n\n' +
        'This changes pull requests other people may already be reviewing, and ' +
        'Restack cannot undo it.',
    },
    'Push & Submit',
  );
  return confirmed === 'Push & Submit';
}

export async function confirmPushSubmit(): Promise<boolean> {
  const confirmed = await vscode.window.showWarningMessage(
    'Push the current stack to GitHub?',
    {
      modal: true,
      detail:
        'Runs `gh stack push` (per-branch --force-with-lease), then ' +
        '`gh stack submit --auto` to create or retarget each PR.\n\n' +
        'This pushes the stack as it is on disk right now, whether or not ' +
        'Restack applied it. It changes pull requests other people may already ' +
        'be reviewing, and Restack cannot undo it.',
    },
    'Push & Submit',
  );
  return confirmed === 'Push & Submit';
}

export async function confirmNewStack(trunk: string): Promise<boolean> {
  const confirmed = await vscode.window.showInformationMessage(
    `Leave this stack to start another?`,
    {
      modal: true,
      detail:
        `gh-stack refuses to create a stack while HEAD is part of one, so Restack ` +
        `will check out ${trunk} first. This stack is untouched — every branch, ` +
        `commit, and pull request stays exactly where it is, and the switcher will ` +
        `still list it.`,
    },
    `Check Out ${trunk}`,
  );
  return confirmed === `Check Out ${trunk}`;
}

export async function confirmCheckoutRemoteStack(
  pr: number,
  target: RemoteStackSummary | undefined,
): Promise<boolean> {
  const count = target?.entries.length ?? 0;
  const confirmed = await vscode.window.showInformationMessage(
    target ? `Check out stack ${target.number} from GitHub?` : `Check out the stack for #${pr}?`,
    {
      modal: true,
      detail:
        `Restack will run \`gh stack checkout ${pr}\`, which asks GitHub for the stack, ` +
        `creates a local branch for each of its ${count || 'pull requests'}` +
        `${count ? ' pull requests' : ''}, records the stack in .git/gh-stack, and checks out ` +
        `its top branch. Nothing on GitHub changes.`,
    },
    'Check Out',
  );
  return confirmed === 'Check Out';
}
