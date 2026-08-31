import * as vscode from 'vscode';
import { firstLine, run, type RunResult } from '../../git';
import { stagePaths, unstagePaths } from '../../worktree';
import { blockedByApply, type Host } from '../host';

/**
 * Stage, unstage, and commit — the three things the working-tree section does
 * that are not plans.
 *
 * Deliberately not routed through `ApplyRunner`. A plan exists so a cascade of
 * rebases can be read before it runs and rolled back after; `git add` is one
 * command, instantly reversible by the button next to it, and wrapping it in a
 * session would put a Dismiss button in front of staging a file.
 *
 * The two git wrappers live in `src/worktree.ts` rather than here, so the tests
 * can reach them without resolving `vscode`.
 */

async function afterWrite(host: Host, result: RunResult, what: string): Promise<void> {
  if (result.code !== 0) {
    void vscode.window.showErrorMessage(
      `Restack: could not ${what}. ${firstLine(result.stderr) || firstLine(result.stdout)}`,
    );
    return;
  }
  // The index watcher would catch this within its 250ms debounce, but a button
  // press should not wait on a filesystem event to look like it worked.
  await host.refresh({ quiet: true });
}

export async function handleStage(host: Host, paths: string[]): Promise<void> {
  const cwd = host.cwd();
  if (!cwd || blockedByApply(host)) {
    return;
  }
  await afterWrite(host, await stagePaths(cwd, paths), 'stage those changes');
}

export async function handleUnstage(host: Host, paths: string[]): Promise<void> {
  const cwd = host.cwd();
  if (!cwd || blockedByApply(host)) {
    return;
  }
  await afterWrite(host, await unstagePaths(cwd, paths), 'unstage those changes');
}

/**
 * Commit what is staged, on whatever branch HEAD is on.
 *
 * No `-a`: the section has a Stage all button and the distinction between
 * staged and unstaged is on screen, so a commit that silently swept up
 * unstaged edits would contradict it.
 */
export async function handleCommit(host: Host, message: string): Promise<void> {
  const cwd = host.cwd();
  if (!cwd || blockedByApply(host)) {
    return;
  }

  const trimmed = message.trim();
  if (trimmed.length === 0) {
    void vscode.window.showErrorMessage('Restack: a commit needs a message.');
    return;
  }

  const staged = await run('git', ['diff', '--cached', '--name-only'], cwd);
  if (staged.stdout.trim().length === 0) {
    void vscode.window.showErrorMessage('Restack: nothing staged to commit.');
    return;
  }

  await host.guard(async () => {
    const result = await run('git', ['commit', '-m', trimmed], cwd);
    if (result.code !== 0) {
      void vscode.window.showErrorMessage(
        `Restack: commit failed. ${firstLine(result.stderr) || firstLine(result.stdout)}`,
      );
      return;
    }
    await host.refresh();
  });
}
