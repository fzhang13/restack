import * as vscode from 'vscode';
import { firstLine, rebaseInProgress, runCommand } from '../../apply';
import { REMOTE_TIMEOUT_MS } from '../../git';
import { topBranchOf } from '../../stacks';
import { checkout } from '../git';
import { blockedByApply, type Host } from '../host';
import { confirmCheckoutRemoteStack, confirmNewStack } from '../prompts';

/** Check a branch out, refusing anything that could lose work. */
export async function handleCheckout(host: Host, branch: string): Promise<void> {
  const cwd = host.cwd();
  if (!cwd) {
    return;
  }
  if (blockedByApply(host, 'Finish or dismiss it before switching branches.')) {
    return;
  }

  await host.guard(async () => {
    // A rebase Restack did not start — left over from a terminal, say — is
    // invisible to the check above, and switching out of one strands it.
    if (await rebaseInProgress(cwd)) {
      void vscode.window.showErrorMessage(
        'Restack: a rebase is in progress. Finish it (`git rebase --continue`) or abort it before switching branches.',
      );
      return;
    }

    const result = await checkout(cwd, branch);
    if (result) {
      void vscode.window.showErrorMessage(`Restack: ${result}`);
      return;
    }
    await host.refresh();
  });
}

/**
 * Make another stack the active one.
 *
 * A checkout, not a mode switch. `gh stack view` reports the stack HEAD is in
 * and no other, so standing in a stack is what makes it renderable in full —
 * with its recorded base SHAs, its drift flags, and its PR state. Rendering a
 * stack we are *not* standing in would mean synthesizing all of that from
 * `.git/gh-stack`, which is gh-stack's job and not ours.
 *
 * The top branch, for topBranchOf's reason: it is the one branch that can
 * only belong to this stack. Everything else here is handleCheckout's, which
 * already refuses a dirty tree, a foreign rebase, and an apply in flight.
 */
export async function handleSwitchStack(host: Host, index: number): Promise<void> {
  const target = host.stacks.find((s) => s.index === index);
  if (!target || target.isActive) {
    return;
  }

  const top = topBranchOf(target);
  if (!top) {
    // readLocalStacks drops branchless entries, so this is unreachable —
    // but the switcher would otherwise check out `undefined`.
    void vscode.window.showErrorMessage(`Restack: stack ${index} has no branches to check out.`);
    return;
  }

  // The user asked to look at a different stack, so the badges on it should
  // not be from whenever the window happened to open. Best-effort: a failed
  // call leaves the previous index in place rather than blanking the rows.
  await host.loadGithub(host.cwd() ?? '');
  await handleCheckout(host, top);
}

/**
 * Materialize a stack that exists only on GitHub.
 *
 * The counterpart to handleSwitchStack, and a different kind of action.
 * Switching is a checkout of branches this clone already has; this is
 * `gh stack checkout <pr>`, which queries GitHub for the stack, fetches every
 * branch in it, and writes `.git/gh-stack`. It creates local state that was
 * not there before, so it is confirmed rather than done on one click.
 *
 * The PR number is always passed. `gh stack checkout` with no argument opens
 * an interactive picker, which from an extension host would block on a
 * terminal nobody can see.
 */
export async function handleCheckoutRemoteStack(host: Host, pr: number): Promise<void> {
  const cwd = host.cwd();
  if (!cwd) {
    return;
  }
  if (blockedByApply(host)) {
    return;
  }

  const target = host.remoteStacks.find((s) => s.checkoutPr === pr);

  await host.guard(async () => {
    // handleCheckout's guard, for its reason: a rebase Restack did not start
    // is invisible to `runner.active`, and gh-stack's checkout would strand
    // it just as a plain checkout would.
    if (await rebaseInProgress(cwd)) {
      void vscode.window.showErrorMessage(
        'Restack: a rebase is in progress. Finish it (`git rebase --continue`) or abort it before checking out a stack.',
      );
      return;
    }

    if (!(await confirmCheckoutRemoteStack(pr, target))) {
      return;
    }

    const result = await vscode.window.withProgress(
      { location: { viewId: 'restack.stackView' }, title: `Checking out the stack for #${pr}…` },
      () => runCommand(host.ghPath(), ['stack', 'checkout', String(pr)], cwd, REMOTE_TIMEOUT_MS),
    );
    if (result.code !== 0) {
      void vscode.window.showErrorMessage(
        `Restack: ${firstLine(result.stderr) || `gh stack checkout ${pr} failed.`}`,
      );
      host.log.show(true);
      return;
    }

    // The stack is local now, so the graph that called it remote-only is out
    // of date — and its branches have PRs the badges should be showing.
    await host.loadGithub(cwd);
    await host.refresh();
  });
}

/**
 * Start a stack alongside the ones already here.
 *
 * `gh stack init` exits with `current branch %q is already part of a stack`,
 * so a second stack cannot be created from inside the first. That is a real
 * gh-stack rule and not one to work around — the answer is to leave, which is
 * a checkout of the trunk and therefore something to confirm rather than do
 * quietly.
 *
 * Nothing is created here. Once HEAD is outside every stack the ordinary
 * no-stack path renders InitView, which is where a stack is actually made.
 */
export async function handleNewStack(host: Host): Promise<void> {
  const cwd = host.cwd();
  if (!cwd) {
    return;
  }

  if (blockedByApply(host)) {
    return;
  }

  // Already outside a stack: the view is showing InitView, and there is
  // nothing to step out of.
  const stack = host.stack;
  if (!stack) {
    await host.refresh();
    return;
  }

  const trunk = stack.trunk;
  if (!(await confirmNewStack(trunk))) {
    return;
  }

  // Via handleCheckout for its guards — a dirty tree blocks `gh stack init`
  // anyway (initPreflight), so being refused here costs nothing.
  await handleCheckout(host, trunk);
}
