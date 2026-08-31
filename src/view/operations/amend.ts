import * as vscode from 'vscode';
import { amendPreflight, hasOrigin, runCommand } from '../../apply';
import { amendPlan, type AmendTarget } from '../../amend';
import { shortSha } from '../../plan';
import { blockedByApply, type Host } from '../host';
import { confirmAmend } from '../prompts';
import { handlePublish } from './apply';

/**
 * Fold staged work into a commit that already exists, anywhere in the stack.
 *
 * The plan is built here, from the stack as it stands *now*, and handed to the
 * same runner a reorder uses — so it renders in the same panel, pauses on a
 * conflict the same way, and rolls back through the same snapshot. The one
 * thing amend adds to that machinery is the parked commit, and `Plan.amend`
 * carries it; see `restoreParked` in apply.ts.
 */
export async function handleAmend(
  host: Host,
  request: { branch: string; sha: string; subject: string; reword?: boolean },
): Promise<void> {
  const cwd = host.cwd();
  const stack = host.stack;
  if (!cwd || !stack) {
    return;
  }

  if (blockedByApply(host, 'Use the buttons in the plan panel.')) {
    return;
  }

  const target: AmendTarget = {
    branch: request.branch,
    sha: request.sha,
    subject: request.subject,
  };

  let message: string | undefined;
  if (request.reword) {
    message = await vscode.window.showInputBox({
      title: `Reword ${shortSha(target.sha)}`,
      prompt: 'The new commit message. Every branch above this one is replayed.',
      value: target.subject,
      ignoreFocusOut: true,
    });
    if (message === undefined || message.trim() === target.subject.trim()) {
      return; // Cancelled, or unchanged — either way there is nothing to do.
    }
    message = message.trim();
  }

  // Read the tree at the moment of the click rather than trusting the copy the
  // webview is rendering. The two are normally the same; when they are not it
  // is because a file was saved between the render and the press, and the plan
  // has to describe what git will actually see.
  const tree = await host.changes.workingTree(cwd);
  const staged = tree.staged.length > 0;
  const unstaged = tree.unstaged.length > 0;

  const blocked = await amendPreflight(cwd, stack, target, 'local', { message });
  if (blocked) {
    void vscode.window.showErrorMessage(`Restack: ${blocked}`);
    return;
  }

  const headTip =
    tree.branch === undefined
      ? undefined
      : (await runCommand('git', ['rev-parse', tree.branch], cwd)).stdout.trim() || undefined;

  const plan = amendPlan(stack, target, {
    head: tree.branch,
    headTip,
    staged,
    unstaged,
    message,
  });

  const canPublish = await hasOrigin(cwd);
  const scope = await confirmAmend(
    { branch: target.branch, shortSha: shortSha(target.sha), subject: target.subject },
    plan,
    canPublish,
  );
  if (!scope) {
    return;
  }

  const order = stack.branches.map((b) => b.name);
  // The panel renders from the plan the host published, so this has to land
  // before the runner starts emitting progress against its step indices.
  host.publishPlan(plan, order);

  await host.guard(async () => {
    await host.runner.start(cwd, host.ghPath(), stack, plan, order, 'local');
    // A conflict pauses the plan rather than ending it, and start() resolves
    // either way — see ApplyRunner.paused. Neither of the steps below is right
    // yet: there is nothing to publish, and a refresh would read the stack with
    // HEAD detached mid-rebase and post the error over the conflict panel.
    if (host.runner.paused) {
      return;
    }
    if (scope === 'publish') {
      await handlePublish(host);
    }
    await host.refresh();
  });
}
