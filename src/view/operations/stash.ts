import * as vscode from 'vscode';
import { runCommand } from '../../apply';
import { stashPush, stashRestore, stashSelector } from '../../stash';
import type { Host } from '../host';

/**
 * The offer Restack makes instead of simply refusing a dirty tree.
 *
 * Every operation that moves HEAD refuses while the working tree is dirty, and
 * the refusal ends "commit or stash them first". This is that second option,
 * offered rather than described — the same two git commands the user would run
 * by hand, around the operation they already asked for.
 *
 * Deliberately *not* wired into `preflight` itself. That function is pure, it
 * returns a bare string, and four call sites plus the test suite depend on
 * both. So the offer happens before the preflight instead: accept it and the
 * tree is clean by the time the preflight runs, decline it and the preflight
 * produces exactly the message it always did. Nothing changes unless the user
 * says yes.
 */

/** Tracked, uncommitted paths — the set every dirty check in Restack means. */
export async function dirtyFiles(cwd: string): Promise<string[]> {
  const status = await runCommand('git', ['status', '--porcelain', '--untracked-files=no'], cwd);
  return status.stdout
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

/**
 * Ask whether to stash, and do it. Returns the stash sha, or undefined.
 *
 * Undefined covers every "carry on as before" case — a clean tree, a declined
 * prompt, a stash that failed — because all three mean the same thing to the
 * caller: run the preflight and let it decide. Only the failure says anything,
 * since a clean tree is unremarkable and a declined prompt is about to produce
 * the refusal that explains itself.
 */
export async function offerStash(
  cwd: string,
  host: Host,
  action: string,
): Promise<string | undefined> {
  const files = await dirtyFiles(cwd);
  if (files.length === 0) {
    return undefined;
  }

  const count = `${files.length} file${files.length === 1 ? '' : 's'}`;
  const choice = await vscode.window.showWarningMessage(
    `${action} needs a clean working tree, and ${count} ${files.length === 1 ? 'has' : 'have'} uncommitted changes.`,
    {
      modal: true,
      detail:
        `Stash and continue runs \`git stash push\`, then restores your changes with ` +
        `\`git stash pop\` once it is done.\n\n` +
        `Untracked files are left alone. ${files.slice(0, 8).join(', ')}` +
        `${files.length > 8 ? `, and ${files.length - 8} more` : ''}`,
    },
    'Stash and continue',
  );
  if (choice !== 'Stash and continue') {
    return undefined;
  }

  const pushed = await stashPush(cwd, `restack: ${action}`);
  if (pushed.kind === 'stashed') {
    return pushed.sha;
  }
  if (pushed.kind === 'failed') {
    void vscode.window.showErrorMessage(`Restack: could not stash — ${pushed.message}`);
    host.log.show(true);
  }
  // 'clean' means the tree emptied between the status read and the push. Rare,
  // and harmless: there is nothing to put back.
  return undefined;
}

/**
 * Put a stash back and say what happened.
 *
 * Never throws and never fails the operation that ran in between: by the time
 * this is called that operation has already succeeded, and a pop that cannot
 * apply is a fact about the user's own saved work, not about the operation.
 */
export async function restoreStash(cwd: string, host: Host, sha: string): Promise<void> {
  const result = await stashRestore(cwd, sha);
  switch (result.kind) {
    case 'restored':
      // Worth a word: Restack moved the user's files twice, and silence would
      // leave them wondering whether the edits survived.
      void vscode.window.showInformationMessage('Restack: your stashed changes are back.');
      return;
    case 'conflict':
      void vscode.window.showWarningMessage(
        `Restack: your stashed changes conflict with the result. Nothing is lost — the stash ` +
          `is still at ${result.selector}. Resolve the conflicts, then \`git stash drop ${result.selector}\`.`,
      );
      return;
    case 'missing':
      host.log.appendLine(
        `Stash ${sha} is no longer in the stash list; nothing to restore. ` +
          'It was most likely popped or dropped by hand.',
      );
      return;
    case 'failed':
      void vscode.window.showErrorMessage(
        `Restack: could not restore your stash — ${result.message}.` +
          (result.selector ? ` It is still at ${result.selector}.` : ''),
      );
      host.log.show(true);
  }
}

/**
 * Hand a stash to an apply, and take it back if the apply never started.
 *
 * From `runner.start` onward the session owns the sha and settles it on
 * whichever terminal path it reaches — done, rolled back, or dismissed. But
 * start() can throw before a session exists: a branch that disappeared between
 * the preflight and the run leaves nothing owning the stash at all. This is
 * the seam where that gap is closed.
 */
export async function startWithStash(
  cwd: string,
  host: Host,
  stash: string | undefined,
  start: () => Promise<void>,
): Promise<void> {
  try {
    await start();
  } catch (err) {
    if (stash && !host.runner.active) {
      await restoreStash(cwd, host, stash);
    }
    throw err;
  }
}

/**
 * Say where an unrestored stash went, for the paths that deliberately leave it.
 *
 * Dismissing an apply is defined as dropping the session without touching the
 * repository, and dismissing one paused on a conflict means the tree cannot
 * take a pop anyway. So the stash stays put and the user is told where.
 */
export async function reportHeldStash(cwd: string, host: Host, sha: string): Promise<void> {
  const selector = await stashSelector(cwd, sha);
  if (!selector) {
    return;
  }
  void vscode.window.showWarningMessage(
    `Restack: your changes are still stashed at ${selector}. Run \`git stash pop ${selector}\` ` +
      'when the working tree is ready for them.',
  );
  host.log.appendLine(`Left the stash in place at ${selector} (${sha}).`);
}
