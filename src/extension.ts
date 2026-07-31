import * as vscode from 'vscode';
import { readStack } from './stack';
import { computePlan } from './plan';
import { ApplyRunner, hasOrigin, preflight } from './apply';
import type { ApplyScope, HostMessage, Plan, Stack, StackResult, WebviewMessage } from './model';

/**
 * Restack: read the stack, let the user drag branches into a new order, render
 * the exact git plan that reorder requires, and run it.
 *
 * Applying is split in two. The local half — rebases plus the gh-stack metadata
 * write — is fully reversible from the snapshot in apply.ts. The remote half —
 * force-push and submit — is not, so it never runs without its own explicit
 * confirmation, even when the user picked "Apply & Publish" up front.
 */
class StackViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private lastStack?: Stack;
  private lastPlan?: Plan;
  private lastOrder?: string[];
  private readonly runner = new ApplyRunner((progress) => this.post({ type: 'apply', progress }));

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
          // A webview rebuilt mid-apply has no memory of the session still
          // running in this host. Without replaying it, ApplyPanel never
          // renders, so Continue / Abort / Dismiss are unreachable and every
          // later Apply is rejected as "already in progress".
          if (this.runner.current && this.runner.currentPlan) {
            this.post({ type: 'plan', plan: this.runner.currentPlan });
            this.post({ type: 'apply', progress: this.runner.current });
          }
          break;
        case 'reorder':
          this.handleReorder(message.order);
          break;
        case 'copyPlan':
          void vscode.env.clipboard.writeText(message.text);
          void vscode.window.showInformationMessage('Restack: plan copied to clipboard.');
          break;
        case 'apply':
          void this.handleApply(message.order);
          break;
        case 'publish':
          void this.handlePublish();
          break;
        case 'applyContinue':
          void this.guard(() => this.runner.resume());
          break;
        case 'applyAbort':
        case 'applyUndo':
          void this.guard(() => this.runner.abort());
          break;
        case 'applyDismiss':
          this.runner.dismiss();
          this.post({ type: 'applyCleared' });
          break;
      }
    });

    // Re-read when the user switches branches outside the editor. Rebasing
    // moves HEAD repeatedly, so stay quiet while an apply owns the repository —
    // refresh() would also drop the plan the apply is running from.
    const watcher = vscode.workspace.createFileSystemWatcher('**/.git/HEAD');
    watcher.onDidChange(() => {
      if (!this.runner.active) {
        void this.refresh();
      }
    });
    this.context.subscriptions.push(watcher);
  }

  private post(message: HostMessage): void {
    void this.view?.webview.postMessage(message);
  }

  private handleReorder(order: string[]): void {
    if (!this.lastStack) {
      return;
    }
    const plan = computePlan(this.lastStack, order);
    this.lastPlan = plan;
    this.lastOrder = order;
    this.post({ type: 'plan', plan });
  }

  /** Surface a thrown error as a notification instead of losing it in a promise. */
  private async guard(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Restack: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private workspacePath(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private ghPath(): string {
    return vscode.workspace.getConfiguration('restack').get<string>('ghPath', 'gh');
  }

  private async handleApply(order: string[]): Promise<void> {
    const cwd = this.workspacePath();
    const stack = this.lastStack;
    const plan = this.lastPlan;

    if (!cwd || !stack || !plan || plan.isNoop) {
      return;
    }

    // The order the webview asked to apply must be the one the shown plan was
    // computed from. If they differ the panel is stale, and applying would run
    // commands the user never saw.
    if (!this.lastOrder || this.lastOrder.join('\0') !== order.join('\0')) {
      void vscode.window.showWarningMessage('Restack: the plan is out of date. Refresh and retry.');
      return;
    }

    const rebases = plan.steps.filter((s) => s.kind === 'rebase');
    const canPublish = await hasOrigin(cwd);
    const scope = await this.confirmApply(rebases.map((s) => s.branch ?? ''), stack.trunk, canPublish);
    if (!scope) {
      return;
    }

    const blocked = await preflight(cwd, stack, scope);
    if (blocked) {
      void vscode.window.showErrorMessage(`Restack: ${blocked}`);
      return;
    }

    await this.guard(async () => {
      // Always run the local half first. Publishing is confirmed again after
      // the rebases land, when the user can see what actually happened.
      await this.runner.start(cwd, this.ghPath(), stack, plan, order, 'local');
      if (scope === 'publish') {
        await this.handlePublish();
      }
      await this.refresh();
    });
  }

  private async confirmApply(
    branches: string[],
    trunk: string,
    canPublish: boolean,
  ): Promise<ApplyScope | undefined> {
    const list = branches.join(', ');
    // Offering "Apply & Publish" without a remote is worse than useless:
    // preflight refuses the whole apply, so the local reorder the user also
    // asked for never runs either.
    const publishNote = canPublish
      ? `"Apply & Publish" additionally force-pushes and runs gh stack submit, ` +
        `which updates your pull requests on GitHub. You will be asked to confirm ` +
        `that separately.`
      : `This repository has no origin remote, so there is nothing to publish to.`;

    const choice = await vscode.window.showWarningMessage(
      `Rewrite ${branches.length} branch${branches.length === 1 ? '' : 'es'} on ${trunk}?`,
      {
        modal: true,
        detail:
          `Restack will rebase ${list}, then update .git/gh-stack to record the new ` +
          `order.\n\nThis rewrites local history. Restack snapshots every branch SHA ` +
          `first and can roll back if a rebase conflicts.\n\n${publishNote}`,
      },
      ...(canPublish ? ['Apply Locally', 'Apply & Publish'] : ['Apply Locally']),
    );

    if (choice === 'Apply Locally') return 'local';
    if (choice === 'Apply & Publish') return 'publish';
    return undefined;
  }

  private async handlePublish(): Promise<void> {
    const confirmed = await vscode.window.showWarningMessage(
      'Push the reordered stack to GitHub?',
      {
        modal: true,
        detail:
          'Force-pushes the rebased branches with --force-with-lease, then runs ' +
          '`gh stack submit --auto` to retarget each PR base.\n\n' +
          'This changes pull requests other people may already be reviewing, and ' +
          'Restack cannot undo it.',
      },
      'Push & Submit',
    );

    if (confirmed !== 'Push & Submit') {
      return;
    }

    await this.guard(async () => {
      await this.runner.publish();
      await this.refresh();
    });
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
    const result: StackResult = await readStack(folder.uri.fsPath, this.ghPath());
    this.lastStack = result.kind === 'ok' ? result.stack : undefined;
    // The plan described the pre-refresh order; holding on to it would let a
    // later apply run stale commands.
    this.lastPlan = undefined;
    this.lastOrder = undefined;
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
