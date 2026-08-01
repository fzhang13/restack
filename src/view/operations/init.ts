import * as vscode from 'vscode';
import { initArgs } from '../../plan';
import { initPreflight, runInit } from '../../init';
import { blockedByApply, type Host } from '../host';
import { resolveRemoteBase } from './base';

/**
 * Create a stack from the branches the user dragged into order.
 *
 * No confirmation modal, unlike apply: the webview shows the exact command
 * before the button is pressable, and init rewrites no commits — there is no
 * history to lose and so nothing to snapshot. The preflight is the guard, and
 * it runs here rather than in the webview because only the host can see the
 * working tree.
 */
export async function handleInitStack(
  host: Host,
  trunk: string,
  branches: string[],
  trunkIsRemote?: boolean,
): Promise<void> {
  const cwd = host.cwd();
  if (!cwd) {
    return;
  }

  if (blockedByApply(host)) {
    return;
  }

  await host.guard(async () => {
    let base = trunk;
    if (trunkIsRemote) {
      // A stack does not have to sit on the default branch, and the branch it
      // sits on often belongs to someone else and exists only on the remote.
      // gh-stack records a trunk by name and initPreflight resolves it
      // locally, so the local branch has to exist — and be current — first.
      // Failing here aborts before `gh stack init` runs; nothing is
      // half-created.
      const resolved = await resolveRemoteBase(host, cwd, trunk);
      if (!resolved) {
        return;
      }
      base = resolved;
    }

    const blocked = await initPreflight(cwd, base, branches);
    if (blocked) {
      void vscode.window.showErrorMessage(`Restack: ${blocked}`);
      return;
    }

    host.log.appendLine(`Creating a stack: gh ${initArgs(base, branches).join(' ')}`);
    const failure = await runInit(cwd, host.ghPath(), base, branches);
    if (failure) {
      void vscode.window.showErrorMessage(`Restack: ${failure}`);
      host.log.show(true);
    }

    // Refresh either way: a failed init can still have written part of the
    // stack, and the view must show what is actually there.
    await host.refresh();
  });
}
