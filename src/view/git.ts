import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Whether the merge editor is what actually opened.
 *
 * `vscode.TabInputTextMerge` exists at runtime but is absent from
 * `@types/vscode` (checked against 1.125), so `instanceof` will not compile.
 * The shape is the check instead, and it is an unambiguous one: the merge input
 * is the only tab input carrying a base/input1/input2/result quadruple.
 */
export function isMergeTab(input: unknown): boolean {
  if (typeof input !== 'object' || input === null) {
    return false;
  }
  const tab = input as Record<string, unknown>;
  return ['base', 'input1', 'input2', 'result'].every((key) => tab[key] instanceof vscode.Uri);
}

/** Run git. Never rejects. */
export async function git(
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; error: string }> {
  try {
    // maxBuffer matches git.ts and changes.ts. It is not decoration here: this
    // helper now carries whole file contents for the diff panes, not just the
    // one-line plumbing it started as, and Node's 1 MiB default would kill git
    // mid-read and leave an ordinary large file rendering as an empty diff.
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: 20_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true, stdout, error: '' };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const error = (e.stderr || e.message || 'git failed.').trim().split('\n')[0];
    return { ok: false, stdout: '', error };
  }
}

/** Whether a recorded SHA still exists in the object database. */
export async function resolves(cwd: string, sha: string): Promise<boolean> {
  return (await git(cwd, ['cat-file', '-e', `${sha}^{commit}`])).ok;
}

/** Check out `branch`, returning an error message rather than throwing. */
export async function checkout(cwd: string, branch: string): Promise<string | undefined> {
  const status = await git(cwd, ['status', '--porcelain', '--untracked-files=no']);
  if (status.stdout.trim().length > 0) {
    return 'Working tree has uncommitted changes. Commit or stash them before switching branches.';
  }
  const result = await git(cwd, ['checkout', branch]);
  return result.ok ? undefined : result.error;
}

/**
 * Resolve a workspace-relative path, refusing anything that escapes the
 * folder. The path comes from `git diff` in this workspace, but it arrives
 * over a message channel, so it is re-checked rather than trusted.
 */
export function resolveInWorkspace(relative: string): vscode.Uri | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return undefined;
  }
  const target = vscode.Uri.joinPath(folder.uri, relative);
  const root = folder.uri.fsPath.replace(/\/*$/, '/');
  return target.fsPath.startsWith(root) ? target : undefined;
}
