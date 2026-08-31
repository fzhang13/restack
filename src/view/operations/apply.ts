import * as vscode from 'vscode';
import { hasOrigin, preflight } from '../../apply';
import { blockedByApply, type Host } from '../host';
import { confirmApply, confirmPublish, confirmPushSubmit } from '../prompts';
import { offerStash, restoreStash, startWithStash } from './stash';

export async function handleApply(host: Host, order: string[]): Promise<void> {
  const cwd = host.cwd();
  const stack = host.stack;
  const plan = host.plan;

  if (!cwd || !stack || !plan || plan.isNoop) {
    return;
  }

  // The order the webview asked to apply must be the one the shown plan was
  // computed from. If they differ the panel is stale, and applying would run
  // commands the user never saw.
  if (!host.order || host.order.join('\0') !== order.join('\0')) {
    void vscode.window.showWarningMessage('Restack: the plan is out of date. Refresh and retry.');
    return;
  }

  const rebases = plan.steps.filter((s) => s.kind === 'rebase');
  const canPublish = await hasOrigin(cwd);
  const scope = await confirmApply(
    rebases.map((s) => s.branch ?? ''),
    stack.trunk,
    canPublish,
    plan,
  );
  if (!scope) {
    return;
  }

  // After the confirmation, so nothing is stashed for an apply the user then
  // backs out of, and before the preflight, which is where the dirty-tree
  // refusal lives. From start() onward the session owns the sha.
  const stash = await offerStash(cwd, host, 'Applying the reorder');

  const blocked = await preflight(cwd, stack, scope, order);
  if (blocked) {
    void vscode.window.showErrorMessage(`Restack: ${blocked}`);
    if (stash) {
      await restoreStash(cwd, host, stash);
    }
    return;
  }

  await host.guard(async () => {
    // Always run the local half first. Publishing is confirmed again after
    // the rebases land, when the user can see what actually happened.
    await startWithStash(cwd, host, stash, () =>
      host.runner.start(cwd, host.ghPath(), stack, plan, order, 'local', stash),
    );
    if (scope === 'publish') {
      await handlePublish(host);
    }
    await host.refresh();
  });
}

export async function handlePublish(host: Host): Promise<void> {
  if (!(await confirmPublish())) {
    return;
  }

  await host.guard(async () => {
    await host.runner.publish();
    await host.refresh();
  });
}

/**
 * Push & submit with no apply session behind it.
 *
 * The session-scoped publish above is only reachable from the panel a
 * successful apply leaves behind. Once that is dismissed — or the window is
 * reloaded — the rebased branches are still sitting there unpushed, so this
 * is the route to origin that does not depend on an apply having just run.
 */
export async function handlePushSubmit(host: Host): Promise<void> {
  const cwd = host.cwd();
  const stack = host.stack;
  if (!cwd || !stack) {
    return;
  }

  if (blockedByApply(host, 'Use the buttons in the plan panel.')) {
    return;
  }

  if (!(await hasOrigin(cwd))) {
    void vscode.window.showErrorMessage('Restack: no `origin` remote to push to.');
    return;
  }

  if (!(await confirmPushSubmit())) {
    return;
  }

  await host.guard(async () => {
    await host.runner.publishOnly(cwd, host.ghPath(), stack);
    await host.refresh();
  });
}
