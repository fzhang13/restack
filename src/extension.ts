import * as vscode from 'vscode';
import { handleInstallGhStack } from './view/operations/setup';
import { chooseAutoFetch } from './view/operations/sync';
import { StackViewProvider } from './view/provider';
import { BlobProvider, RESTACK_SCHEME } from './view/documents';

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Restack');
  // Left of centre, so it sits near the git extension's own branch indicator
  // rather than out at the far end with the language tools.
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'restack.checkoutBranch';
  const provider = new StackViewProvider(context, log, status);

  context.subscriptions.push(
    log,
    status,
    vscode.window.registerWebviewViewProvider('restack.stackView', provider),
    vscode.workspace.registerTextDocumentContentProvider(
      RESTACK_SCHEME,
      // The provider's folder, not the first one: in a multi-root workspace
      // those differ, and a blob read against the wrong repository silently
      // renders an empty diff. See view/folder.ts.
      new BlobProvider(() => provider.cwd()),
    ),
    vscode.commands.registerCommand('restack.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('restack.pushSubmit', () => provider.pushSubmit()),
    vscode.commands.registerCommand('restack.rebaseStack', () => provider.rebaseStack()),
    vscode.commands.registerCommand('restack.fetch', () => provider.fetch()),
    vscode.commands.registerCommand('restack.autoFetch', () => chooseAutoFetch()),
    vscode.commands.registerCommand('restack.syncStack', () => provider.syncStack()),
    vscode.commands.registerCommand('restack.changeBase', () => provider.changeBase()),
    vscode.commands.registerCommand('restack.removeStack', () => provider.removeStack()),
    vscode.commands.registerCommand('restack.checkoutBranch', () => provider.checkoutBranch()),
    vscode.commands.registerCommand('restack.switchStack', () => provider.switchStack()),
    vscode.commands.registerCommand('restack.newStack', () => provider.newStack()),
    vscode.commands.registerCommand('restack.selectFolder', () => provider.pickFolder()),
    vscode.commands.registerCommand('restack.installGhStack', () =>
      handleInstallGhStack(provider),
    ),
    vscode.commands.registerCommand('restack.showLog', () => log.show()),

    // Adding or removing a folder can change the answer to "which repository",
    // and removing the selected one changes it for certain. refresh() re-runs
    // the whole resolution, so there is nothing to invalidate by hand.
    vscode.workspace.onDidChangeWorkspaceFolders(() => void provider.refresh()),
  );

  // Before any refresh, so a webview connecting for the first time is replayed
  // the session this window was reloaded out of. The refresh that follows is
  // what the status bar is drawn from — without it the stack stays invisible
  // until the view is opened, which is the opposite of the point.
  void provider.restoreSession().then(() => provider.refresh());
}

export function deactivate(): void {}
