import * as vscode from 'vscode';
import { isMergeTab, resolveInWorkspace } from '../git';
import type { Host } from '../host';

/** Open a PR in the browser. */
export async function openUrl(url: string): Promise<void> {
  let parsed: vscode.Uri;
  try {
    parsed = vscode.Uri.parse(url, true);
  } catch {
    return;
  }
  if (parsed.scheme !== 'https' && parsed.scheme !== 'http') {
    return;
  }
  await vscode.env.openExternal(parsed);
}

/**
 * Open a conflicted file. The path comes from `git diff` in this workspace,
 * but it arrives over a message channel, so it is re-checked against the
 * folder root rather than trusted.
 */
export async function openFile(host: Host, relative: string): Promise<void> {
  const target = resolveInWorkspace(relative);
  if (!target) {
    return;
  }
  await host.guard(() => showAsText(target));
}

/**
 * Open a conflicted file in VS Code's three-way merge editor.
 *
 * `git.openMergeEditor` belongs to the built-in git extension, and it already
 * understands a rebase: it diffs against REBASE_HEAD rather than MERGE_HEAD
 * when one is in progress. Completing the merge there stages the file, which
 * is precisely what the runner's Continue requires — so the whole loop stays
 * in the editor.
 *
 * It resolves silently when it cannot do the job — git disabled, the file no
 * longer in the merge group, the extension's own state not yet refreshed — so
 * success is confirmed by looking at what actually opened, and plain text is
 * the fallback rather than a dead button.
 */
export async function openMergeEditor(host: Host, relative: string): Promise<void> {
  const target = resolveInWorkspace(relative);
  if (!target) {
    return;
  }

  await host.guard(async () => {
    try {
      await vscode.commands.executeCommand('git.openMergeEditor', target);
    } catch (err) {
      host.log.appendLine(
        `git.openMergeEditor failed for ${relative}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (isMergeTab(vscode.window.tabGroups.activeTabGroup.activeTab?.input)) {
      return;
    }
    await showAsText(target);
  });
}

/** Open `target` as an ordinary text document, conflict markers and all. */
export async function showAsText(target: vscode.Uri): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(target);
  await vscode.window.showTextDocument(doc, { preview: true });
}
