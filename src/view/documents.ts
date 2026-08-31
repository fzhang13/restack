import * as vscode from 'vscode';
import { git, resolveInWorkspace } from './git';
import type { Host } from './host';

/**
 * A file as of one commit, served read-only from `git show`.
 *
 * A scheme of our own rather than the built-in git extension's `toGitUri`.
 * That would be less code, but it makes every diff depend on an extension that
 * can be disabled, and it opens a second path to git objects beside git.ts.
 * `openMergeEditor` already carries a fallback for exactly that; this needs
 * none.
 */
export const RESTACK_SCHEME = 'restack';

/**
 * `restack:/<path>?<sha>`.
 *
 * The path goes in the URI path so VS Code picks the language mode from its
 * extension, and the revision in the query so two revisions of one file are
 * distinct documents rather than one that changes under the diff editor.
 */
export function blobUri(sha: string, path: string): vscode.Uri {
  return vscode.Uri.from({ scheme: RESTACK_SCHEME, path: `/${path}`, query: sha });
}

export class BlobProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly cwd: () => string | undefined) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const cwd = this.cwd();
    if (!cwd) {
      return '';
    }
    // Empty on failure, which is the correct answer for the common case: an
    // added file has no version in the parent commit, and `git show` fails
    // rather than returning nothing. The diff then reads as "all new", which
    // is what happened.
    const result = await git(cwd, ['show', `${uri.query}:${uri.path.slice(1)}`]);
    return result.ok ? result.stdout : '';
  }
}

/** Basename, for a diff tab title. */
function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * Whether git considers this path binary at this commit. One extra spawn, on a
 * click, which is the only place it matters — `--numstat` cannot be combined
 * with the `--name-status` the listing is built from, so detecting it up front
 * would have cost a second spawn per branch instead.
 */
async function isBinary(cwd: string, sha: string, path: string): Promise<boolean> {
  const result = await git(cwd, ['show', '--format=', '--numstat', sha, '--', path]);
  // A failed read is not evidence of binary; fall through to the text diff.
  if (!result.ok) {
    return false;
  }
  return result.stdout.trimStart().startsWith('-\t-');
}

/**
 * Open `sha`'s version of a file beside an earlier one.
 *
 * `base` names the left-hand ref when the caller has one — the branch-level
 * file list is a `base..tip` range, and its rows include files the tip commit
 * never touched. Without a base the left side is the tip's parent, which is
 * what a file row inside a single commit means.
 */
export async function openCommitDiff(
  host: Host,
  sha: string,
  path: string,
  oldPath?: string,
  base?: string,
): Promise<void> {
  const cwd = host.cwd();
  if (!cwd) {
    return;
  }

  await host.guard(async () => {
    const right = blobUri(sha, path);
    if (await isBinary(cwd, sha, path)) {
      // No useful text diff. Show the one side that exists rather than two
      // panes of mojibake.
      await vscode.window.showTextDocument(right, { preview: true });
      return;
    }
    const left = blobUri(base ?? `${sha}^`, oldPath ?? path);
    // A range is not "at" a commit, so it is titled as the range it is.
    const at = base ? `${base.slice(0, 7)}..${sha.slice(0, 7)}` : sha.slice(0, 7);
    await vscode.commands.executeCommand(
      'vscode.diff',
      left,
      right,
      `${fileName(path)} (${at})`,
      { preview: true },
    );
  });
}

/**
 * Open an uncommitted file beside HEAD's version of it.
 *
 * The right-hand side is the real file, not a `restack:` document, so what
 * opens is editable — the point of looking at an uncommitted change is usually
 * to keep working on it.
 */
export async function openWorkingDiff(host: Host, path: string): Promise<void> {
  const target = resolveInWorkspace(host.cwd(), path);
  if (!target) {
    return;
  }
  await host.guard(async () => {
    await vscode.commands.executeCommand(
      'vscode.diff',
      blobUri('HEAD', path),
      target,
      `${fileName(path)} (working tree)`,
      { preview: true },
    );
  });
}
