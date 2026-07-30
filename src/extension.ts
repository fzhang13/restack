import * as vscode from 'vscode';
import { readStack } from './stack';
import { computePlan } from './plan';
import type { HostMessage, Stack, StackResult, WebviewMessage } from './model';

/**
 * Restack v0: read the stack, let the user drag branches into a new order,
 * and render the exact git plan that reorder would require.
 *
 * Nothing here writes to the repository. Execution is deliberately deferred
 * to v1, behind the conflict-resume state machine.
 */
class StackViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private lastStack?: Stack;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };
    view.webview.html = this.html(view.webview);

    view.webview.onDidReceiveMessage((message: WebviewMessage) => {
      switch (message.type) {
        case 'ready':
        case 'refresh':
          void this.refresh();
          break;
        case 'reorder':
          this.handleReorder(message.order);
          break;
        case 'copyPlan':
          void vscode.env.clipboard.writeText(message.text);
          void vscode.window.showInformationMessage('Restack: plan copied to clipboard.');
          break;
      }
    });

    // Re-read when the user switches branches outside the editor.
    const watcher = vscode.workspace.createFileSystemWatcher('**/.git/HEAD');
    watcher.onDidChange(() => void this.refresh());
    this.context.subscriptions.push(watcher);
  }

  private post(message: HostMessage): void {
    void this.view?.webview.postMessage(message);
  }

  private handleReorder(order: string[]): void {
    if (!this.lastStack) {
      return;
    }
    this.post({ type: 'plan', plan: computePlan(this.lastStack, order) });
  }

  async refresh(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.post({
        type: 'stack',
        result: { kind: 'error', message: 'Open a folder to read its stack.' },
      });
      return;
    }

    this.post({ type: 'loading' });
    const ghPath = vscode.workspace.getConfiguration('restack').get<string>('ghPath', 'gh');
    const result: StackResult = await readStack(folder.uri.fsPath, ghPath);
    this.lastStack = result.kind === 'ok' ? result.stack : undefined;
    this.post({ type: 'stack', result });
  }

  private html(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'),
    );
    // esbuild emits imported CSS as a sibling file; it must be linked explicitly.
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.css'),
    );
    const nonce = String(Math.random()).slice(2) + String(Date.now());
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${styleUri}">
<title>Restack</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new StackViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('restack.stackView', provider),
    vscode.commands.registerCommand('restack.refresh', () => provider.refresh()),
  );
}

export function deactivate(): void {}
