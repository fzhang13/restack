import * as vscode from 'vscode';
import { handleInstallGhStack } from './view/operations/setup';
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
      new BlobProvider(() => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath),
    ),
    vscode.commands.registerCommand('restack.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('restack.pushSubmit', () => provider.pushSubmit()),
    vscode.commands.registerCommand('restack.rebaseStack', () => provider.rebaseStack()),
    vscode.commands.registerCommand('restack.fetch', () => provider.fetch()),
    vscode.commands.registerCommand('restack.syncStack', () => provider.syncStack()),
    vscode.commands.registerCommand('restack.changeBase', () => provider.changeBase()),
    vscode.commands.registerCommand('restack.removeStack', () => provider.removeStack()),
    vscode.commands.registerCommand('restack.checkoutBranch', () => provider.checkoutBranch()),
    vscode.commands.registerCommand('restack.switchStack', () => provider.switchStack()),
    vscode.commands.registerCommand('restack.newStack', () => provider.newStack()),
    vscode.commands.registerCommand('restack.installGhStack', () =>
      handleInstallGhStack(provider),
    ),
    vscode.commands.registerCommand('restack.showLog', () => log.show()),
  );

  // Before any refresh, so a webview connecting for the first time is replayed
  // the session this window was reloaded out of. The refresh that follows is
  // what the status bar is drawn from — without it the stack stays invisible
  // until the view is opened, which is the opposite of the point.
  void provider.restoreSession().then(() => provider.refresh());
}

export function deactivate(): void {}
