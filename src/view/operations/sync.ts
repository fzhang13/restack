import * as vscode from 'vscode';
import { preflight } from '../../apply';
import { syncPlan } from '../../plan';
import { detectRemote, fetchRemote } from '../../remote';
import { blockedByApply, type Host } from '../host';
import { confirmSync } from '../prompts';

/**
 * Go and ask the remote, then re-render.
 *
 * The only place Restack initiates network traffic on its own. Everything the
 * view shows about the remote — the ahead/behind counts, the sync banner, the
 * clobber warning — is read from local refs, so it is only ever as fresh as
 * the last fetch. This is the button that makes it fresh.
 */
export async function fetch(host: Host): Promise<void> {
  const cwd = host.cwd();
  if (!cwd) {
    return;
  }

  if (blockedByApply(host)) {
    return;
  }

  await host.guard(async () => {
    const remote = await detectRemote(cwd, host.stack?.trunk ?? 'main');
    if (!remote) {
      void vscode.window.showInformationMessage('Restack: no remote to fetch from.');
      return;
    }

    const failure = await vscode.window.withProgress(
      { location: { viewId: 'restack.stackView' }, title: `Fetching ${remote}…` },
      () => fetchRemote(cwd, remote),
    );
    if (failure) {
      void vscode.window.showErrorMessage(`Restack: ${failure}`);
      host.log.show(true);
    }

    // The switcher's PR and stack badges are the other half of "as of the
    // last fetch", and this button is what that phrase refers to.
    // Best-effort, like the fetch above: a failed call leaves the previous
    // badges rather than blanking every row.
    await host.loadGithub(cwd);

    // Either way: a partial fetch still moved some refs, and the counts
    // should reflect what is actually on disk.
    await host.refresh();
  });
}

/**
 * Bring the stack up to date with a trunk that has moved.
 *
 * Fetches first, always. A sync plan built from stale refs would fast-forward
 * the trunk to a commit that is no longer its tip, and the whole cascade would
 * replay onto the wrong place — so the network call is part of the action
 * rather than something the user is expected to have done first.
 *
 * The stack is re-read after the fetch for the same reason the plan is built
 * after it: `gh stack view`'s `needsRebase` and recorded bases both describe
 * the pre-fetch world.
 *
 * Everything after that is an ordinary apply — snapshot, conflict pause, undo,
 * reload persistence — because syncPlan produces an ordinary Plan.
 */
export async function handleSyncStack(host: Host): Promise<void> {
  const cwd = host.cwd();
  if (!cwd || !host.stack) {
    return;
  }

  if (blockedByApply(host, 'Use the buttons in the plan panel.')) {
    return;
  }

  await host.guard(async () => {
    const remote = await detectRemote(cwd, host.stack?.trunk ?? 'main');
    if (!remote) {
      void vscode.window.showErrorMessage('Restack: no remote to sync with.');
      return;
    }

    const failure = await vscode.window.withProgress(
      { location: { viewId: 'restack.stackView' }, title: `Fetching ${remote}…` },
      () => fetchRemote(cwd, remote),
    );
    if (failure) {
      void vscode.window.showErrorMessage(`Restack: ${failure}`);
      host.log.show(true);
      return;
    }

    // Re-read against post-fetch refs before planning anything.
    await host.refresh();
    const stack = host.stack;
    const remoteState = host.remote;
    if (!stack) {
      return;
    }

    if (!remoteState || remoteState.trunk.behind === 0) {
      void vscode.window.showInformationMessage(
        `Restack: ${stack.trunk} is already up to date with ${remote}.`,
      );
      return;
    }

    const onTrunk = stack.currentBranch === stack.trunk;
    const plan = syncPlan(stack, remote, onTrunk);
    if (plan.isNoop) {
      void vscode.window.showInformationMessage('Restack: nothing to replay.');
      return;
    }

    const order = stack.branches.map((b) => b.name);
    const blocked = await preflight(cwd, stack, 'local', order);
    if (blocked) {
      void vscode.window.showErrorMessage(`Restack: ${blocked}`);
      return;
    }

    const rebases = plan.steps.filter((s) => s.kind === 'rebase').map((s) => s.branch ?? '');
    const behind = remoteState.trunk.behind;
    if (!(await confirmSync(stack.trunk, remote, behind, rebases))) {
      return;
    }

    host.publishPlan(plan, order);

    await host.runner.start(cwd, host.ghPath(), stack, plan, order, 'local');
    await host.refresh();
  });
}
