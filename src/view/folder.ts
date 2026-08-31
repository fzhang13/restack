import * as vscode from 'vscode';
import { readLocalStacks } from '../init';
import { chooseFolder } from '../workspace';

/**
 * The folder-resolution rule from workspace.ts, bound to the open workspace and
 * to `workspaceState`.
 *
 * `current()` is synchronous because `Host.cwd()` is, and every operation reads
 * it. That works because the only case needing async work — several folders and
 * no remembered choice — is also the only case where the view is showing the
 * folder list rather than a stack, so no operation is reachable until it is
 * settled.
 */

/** workspaceState key holding the chosen folder, as `uri.toString()`. */
const FOLDER_KEY = 'restack.folder';

/** One folder as the view needs to render it. */
export interface FolderChoice {
  name: string;
  path: string;
}

export class FolderSelection {
  private resolved?: vscode.WorkspaceFolder;

  constructor(private readonly state: vscode.Memento) {}

  private open(): readonly vscode.WorkspaceFolder[] {
    return vscode.workspace.workspaceFolders ?? [];
  }

  /**
   * The folder to read, or undefined when that is not settled.
   *
   * Re-checks that the resolution is still open rather than trusting it, so a
   * folder removed from the workspace stops being the answer immediately —
   * before any listener has had a chance to run.
   */
  current(): vscode.WorkspaceFolder | undefined {
    const open = this.open();
    if (open.length === 1) {
      return open[0];
    }
    const id = this.resolved?.uri.toString();
    return id !== undefined && open.some((f) => f.uri.toString() === id) ? this.resolved : undefined;
  }

  /** Every open folder, in workspace order — the list the picker offers. */
  options(): FolderChoice[] {
    return this.open().map((f) => ({ name: f.name, path: f.uri.fsPath }));
  }

  /**
   * Settle `current()`, probing only if the rule asks for it.
   *
   * The probe is `readLocalStacks`: one `git rev-parse --git-common-dir` and one
   * file read per folder, no `gh` and no network. It runs once per workspace,
   * because an auto-pick is written back below.
   */
  async resolve(): Promise<void> {
    const open = this.open();
    const ids = open.map((f) => f.uri.toString());
    const stored = this.state.get<string>(FOLDER_KEY);

    let outcome = chooseFolder(ids, stored);
    if (outcome.kind === 'probe') {
      const withStacks: string[] = [];
      for (const folder of open) {
        if ((await readLocalStacks(folder.uri.fsPath)).length > 0) {
          withStacks.push(folder.uri.toString());
        }
      }
      outcome = chooseFolder(ids, stored, withStacks);
    }

    this.resolved =
      outcome.kind === 'folder' ? open.find((f) => f.uri.toString() === outcome.id) : undefined;

    // Remember an auto-pick, so the probe's answer cannot change underneath the
    // user when a second folder later grows a stack of its own. Skipped for the
    // single-folder shortcut, which is not a choice anyone made — pinning it
    // would silently decide a multi-root workspace that has not happened yet.
    if (outcome.kind === 'folder' && open.length > 1 && stored !== outcome.id) {
      await this.state.update(FOLDER_KEY, outcome.id);
    }
  }

  /** Record an explicit choice by index into `options()`. */
  async select(index: number): Promise<boolean> {
    const folder = this.open()[index];
    if (!folder) {
      return false;
    }
    this.resolved = folder;
    await this.state.update(FOLDER_KEY, folder.uri.toString());
    return true;
  }
}
