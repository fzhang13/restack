import * as vscode from 'vscode';
import { preflight } from '../../apply';
import { computePlan } from '../../plan';
import { blockedByApply, type Host } from '../host';
import { confirmRebase } from '../prompts';

/**
 * Replay the stack onto itself to clear the drift gh-stack reports.
 *
 * `gh stack init` adopts branches into stack order without rebasing them, so
 * a freshly created stack is correct on paper and unbuilt in fact. A forced
 * plan is that rebase — and because it is an ordinary plan run through the
 * ordinary runner, it arrives with the snapshot, undo, conflict pause, and
 * reload persistence every other apply has.
 *
 * `gh stack rebase` would also do it, but it owns conflicts through its own
 * `--continue` protocol, which the runner does not speak; a paused rebase
 * would strand the user.
 */
export async function handleRebaseStack(host: Host): Promise<void> {
  const cwd = host.cwd();
  const stack = host.stack;
  if (!cwd || !stack) {
    return;
  }

  if (blockedByApply(host, 'Use the buttons in the plan panel.')) {
    return;
  }

  const order = stack.branches.map((b) => b.name);
  const plan = computePlan(stack, order, [], { force: true });
  if (plan.isNoop) {
    void vscode.window.showInformationMessage('Restack: the stack is already up to date.');
    return;
  }

  const blocked = await preflight(cwd, stack, 'local', order);
  if (blocked) {
    void vscode.window.showErrorMessage(`Restack: ${blocked}`);
    return;
  }

  const branches = plan.steps.filter((s) => s.kind === 'rebase').map((s) => s.branch ?? '');
  if (!(await confirmRebase(branches, stack.trunk))) {
    return;
  }

  // The panel renders from the host's plan, so publish it before the run
  // starts or the progress arrives with no steps to attach itself to.
  host.publishPlan(plan, order);

  await host.guard(async () => {
    await host.runner.start(cwd, host.ghPath(), stack, plan, order, 'local');
    await host.refresh();
  });
}
