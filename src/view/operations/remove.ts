import * as vscode from 'vscode';
import { unstackArgs } from '../../plan';
import { runUnstack, unstackPreflight } from '../../init';
import { blockedByApply, type Host } from '../host';
import { confirmRemove } from '../prompts';
import { offerStash, restoreStash } from './stash';

/**
 * Dissolve the stack — the missing counterpart to init.
 *
 * Deliberately not an apply. `gh stack unstack` rewrites no commits and moves
 * no branch refs; it deletes a record. There is no cascade to plan, no
 * conflict to pause on, and nothing a snapshot could restore that is not
 * already sitting untouched on disk. So this follows runInit's shape: one
 * guarded command, then a refresh.
 *
 * The scope split mirrors apply's. Local stops at `.git/gh-stack`; remote also
 * detaches the pull requests on GitHub, which nothing here can take back.
 */
export async function handleRemoveStack(host: Host): Promise<void> {
  const cwd = host.cwd();
  const stack = host.stack;
  if (!cwd || !stack) {
    return;
  }

  if (blockedByApply(host)) {
    return;
  }

  const scope = await confirmRemove(cwd, stack);
  if (!scope) {
    return;
  }

  await host.guard(async () => {
    // `gh stack unstack` may check out a branch, which is why its preflight
    // refuses a dirty tree; the offer goes in front of that refusal.
    const stash = await offerStash(cwd, host, 'Removing the stack');

    const blocked = await unstackPreflight(cwd, scope);
    if (blocked) {
      void vscode.window.showErrorMessage(`Restack: ${blocked}`);
      if (stash) {
        await restoreStash(cwd, host, stash);
      }
      return;
    }

    const local = scope === 'local';
    host.log.appendLine(`Removing the stack: gh ${unstackArgs(local).join(' ')}`);
    const failure = await runUnstack(cwd, host.ghPath(), local);
    if (failure) {
      void vscode.window.showErrorMessage(`Restack: ${failure}`);
      host.log.show(true);
    }

    if (stash) {
      await restoreStash(cwd, host, stash);
    }

    // Re-read either way. A remote unstack that GitHub only partly allowed —
    // queued PRs and ones with auto-merge on are left stacked — exits zero and
    // keeps the whole stack, local tracking included.
    await host.refresh();
    if (!failure && host.stack) {
      void vscode.window.showWarningMessage(
        'Restack: the stack is still here. GitHub leaves queued PRs and ones with ' +
          'auto-merge enabled stacked, and gh-stack then keeps local tracking too. ' +
          'See the Restack output channel.',
      );
      host.log.show(true);
    }
  });
}
