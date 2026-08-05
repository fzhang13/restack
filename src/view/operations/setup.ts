import * as vscode from 'vscode';
import { homedir } from 'node:os';
import { firstLine, runCommand } from '../../apply';
import { REMOTE_TIMEOUT_MS } from '../../git';
import { installArgs } from '../../plan';
import { blockedByApply, type Host } from '../host';

/**
 * The one thing Restack can do before it can do anything else: install the tool
 * it is a front end for.
 *
 * `gh stack view` failing with `unknown command` is the only failure here with
 * a one-command fix, so it is the only one that gets a button. A missing `gh`
 * itself is not actionable from in here — Restack would need the CLI it is
 * trying to install — so that case stays a link and a path setting.
 */

/** Where the gh CLI is documented, for the case Restack cannot fix. */
export const GH_CLI_URL = 'https://cli.github.com/';

/**
 * Run `gh extension install github/gh-stack`, then re-read the stack.
 *
 * Goes through runCommand like every other command, so the argv, exit code, and
 * both streams land in the output channel. The remote timeout rather than the
 * local one: this downloads a release. `GIT_TERMINAL_PROMPT=0` is already set
 * on every child process, so an unauthenticated gh fails rather than blocking
 * on a prompt no one can answer from an extension host.
 */
export async function handleInstallGhStack(host: Host): Promise<void> {
  if (blockedByApply(host)) {
    return;
  }

  // The install is repository-independent, so an empty window is no reason to
  // refuse it — the palette command is reachable from one.
  const cwd = host.cwd() ?? homedir();

  await host.guard(async () => {
    const args = installArgs();
    host.log.appendLine(`Installing gh-stack: gh ${args.join(' ')}`);
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Restack: installing gh-stack…' },
      () => runCommand(host.ghPath(), args, cwd, REMOTE_TIMEOUT_MS),
    );

    if (result.code !== 0) {
      // gh says plainly what went wrong — no such release, not authenticated,
      // no network — so its own first line beats anything invented here.
      // Note an already-installed extension is *not* one of these: gh exits 0
      // with a `!` warning, which is the right outcome anyway, since the
      // refresh below then finds the stack.
      void vscode.window.showErrorMessage(
        `Restack: ${firstLine(result.stderr) || firstLine(result.stdout) || 'gh extension install failed.'}`,
      );
      host.log.show(true);
      // Refreshed anyway: the setup screen is what offers the command to run by
      // hand, and it must still be there rather than stale behind a toast.
      await host.refresh();
      return;
    }

    void vscode.window.showInformationMessage('Restack: gh-stack installed.');
    await host.refresh();
  });
}

/** Open the `restack.ghPath` setting, for a gh that is installed elsewhere. */
export async function openGhPathSetting(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.openSettings', 'restack.ghPath');
}
