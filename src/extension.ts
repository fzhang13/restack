import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readStack } from './stack';
import { readCandidates, readBranchCandidates } from './candidates';
import { computePlan, initArgs, unstackArgs } from './plan';
import { ApplyRunner, hasOrigin, preflight, type PersistedSession } from './apply';
import {
  detectTrunk,
  initPreflight,
  readLocalStacks,
  runInit,
  runUnstack,
  unstackPreflight,
  type UnstackScope,
} from './init';
import type {
  ApplyScope,
  CandidateBranch,
  HostMessage,
  Plan,
  Stack,
  StackResult,
  WebviewMessage,
} from './model';

const execFileAsync = promisify(execFile);

/** workspaceState key holding an apply session across a window reload. */
const SESSION_KEY = 'restack.session';

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
  private lastCandidates: CandidateBranch[] = [];
  private readonly runner: ApplyRunner;
  private readonly log: vscode.OutputChannel;

  constructor(
    private readonly context: vscode.ExtensionContext,
    log: vscode.OutputChannel,
  ) {
    this.log = log;
    this.runner = new ApplyRunner(
      (progress) => this.post({ type: 'apply', progress }),
      {
        persist: (state) => void this.context.workspaceState.update(SESSION_KEY, state),
        log: (line) => this.log.appendLine(line),
      },
    );
  }

  /**
   * Adopt a session left behind by a window reload, if the repository is still
   * where it was. A snapshot whose SHAs no longer resolve cannot roll anything
   * back, so it is surfaced for manual recovery rather than silently resumed.
   */
  async restoreSession(): Promise<void> {
    const state = this.context.workspaceState.get<PersistedSession>(SESSION_KEY);
    if (!state) {
      return;
    }

    const cwd = this.workspacePath();
    if (!cwd || state.cwd !== cwd) {
      return; // A different folder's session; leave it for that window.
    }

    this.runner.restore(state);
    this.log.appendLine(
      `Restored an apply session interrupted by a window reload (step ${state.cursor + 1} of ${state.plan.steps.length}).`,
    );

    const missing: string[] = [];
    for (const [branch, sha] of state.refs) {
      const found = await resolves(cwd, sha);
      if (!found) {
        missing.push(`${branch} → ${sha}`);
      }
    }

    if (missing.length > 0) {
      void vscode.window.showWarningMessage(
        'Restack: an interrupted apply was found, but its snapshot can no longer be restored. ' +
          'See the Restack output channel for the recorded SHAs.',
      );
      this.log.appendLine('Snapshot SHAs that no longer resolve — recover by hand:');
      missing.forEach((m) => this.log.appendLine(`    ${m}`));
      this.log.show(true);
    }
  }

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
        case 'initStack':
          void this.handleInitStack(message.trunk, message.branches);
          break;
        case 'rebaseStack':
          void this.handleRebaseStack();
          break;
        case 'removeStack':
          void this.handleRemoveStack();
          break;
        case 'publish':
          void this.handlePublish();
          break;
        case 'pushSubmit':
          void this.handlePushSubmit();
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
        case 'openUrl':
          void this.openUrl(message.url);
          break;
        case 'openFile':
          void this.openFile(message.path);
          break;
        case 'checkout':
          void this.handleCheckout(message.branch);
          break;
        case 'showLog':
          this.log.show(true);
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
    const plan = computePlan(this.lastStack, order, this.lastCandidates);
    this.lastPlan = plan;
    this.lastOrder = order;
    this.post({ type: 'plan', plan });
  }

  /** Open a PR in the browser. */
  private async openUrl(url: string): Promise<void> {
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
  private async openFile(relative: string): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return;
    }
    const target = vscode.Uri.joinPath(folder.uri, relative);
    const root = folder.uri.fsPath.replace(/\/*$/, '/');
    if (!target.fsPath.startsWith(root)) {
      return;
    }
    await this.guard(async () => {
      const doc = await vscode.workspace.openTextDocument(target);
      await vscode.window.showTextDocument(doc, { preview: true });
    });
  }

  /** Check a branch out, refusing anything that could lose work. */
  private async handleCheckout(branch: string): Promise<void> {
    const cwd = this.workspacePath();
    if (!cwd) {
      return;
    }
    if (this.runner.active) {
      void vscode.window.showWarningMessage(
        'Restack: an apply is in progress. Finish or dismiss it before switching branches.',
      );
      return;
    }

    await this.guard(async () => {
      const result = await checkout(cwd, branch);
      if (result) {
        void vscode.window.showErrorMessage(`Restack: ${result}`);
        return;
      }
      await this.refresh();
    });
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

  /**
   * Create a stack from the branches the user dragged into order.
   *
   * No confirmation modal, unlike apply: the webview shows the exact command
   * before the button is pressable, and init rewrites no commits — there is no
   * history to lose and so nothing to snapshot. The preflight is the guard, and
   * it runs here rather than in the webview because only the host can see the
   * working tree.
   */
  private async handleInitStack(trunk: string, branches: string[]): Promise<void> {
    const cwd = this.workspacePath();
    if (!cwd) {
      return;
    }

    if (this.runner.active) {
      void vscode.window.showWarningMessage(
        'Restack: an apply is in progress. Finish or dismiss it first.',
      );
      return;
    }

    await this.guard(async () => {
      const blocked = await initPreflight(cwd, trunk, branches);
      if (blocked) {
        void vscode.window.showErrorMessage(`Restack: ${blocked}`);
        return;
      }

      this.log.appendLine(`Creating a stack: gh ${initArgs(trunk, branches).join(' ')}`);
      const failure = await runInit(cwd, this.ghPath(), trunk, branches);
      if (failure) {
        void vscode.window.showErrorMessage(`Restack: ${failure}`);
        this.log.show(true);
      }

      // Refresh either way: a failed init can still have written part of the
      // stack, and the view must show what is actually there.
      await this.refresh();
    });
  }

  /**
   * Replay the stack onto itself to clear the drift gh-stack reports.
   *
   * `gh stack init` adopts branches into stack order without rebasing them, so
   * a freshly created stack is correct on paper and unbuilt in fact. A forced
   * plan is that rebase — and because it is an ordinary plan run through the
   * ordinary runner, it arrives with the snapshot, undo, conflict pause, and
   * reload persistence every other apply has.
   *
   * `gh stack rebase` would also do it, but it owns conflicts through its own
   * `--continue` protocol, which the runner does not speak; a paused rebase
   * would strand the user.
   */
  /** Palette entry point: the view may never have loaded a stack. */
  async rebaseStack(): Promise<void> {
    if (!this.lastStack) {
      await this.refresh();
    }
    await this.handleRebaseStack();
  }

  private async handleRebaseStack(): Promise<void> {
    const cwd = this.workspacePath();
    const stack = this.lastStack;
    if (!cwd || !stack) {
      return;
    }

    if (this.runner.active) {
      void vscode.window.showWarningMessage(
        'Restack: an apply is in progress. Use the buttons in the plan panel.',
      );
      return;
    }

    const order = stack.branches.map((b) => b.name);
    const plan = computePlan(stack, order, [], { force: true });
    if (plan.isNoop) {
      void vscode.window.showInformationMessage('Restack: the stack is already up to date.');
      return;
    }

    const blocked = await preflight(cwd, stack, 'local', order);
    if (blocked) {
      void vscode.window.showErrorMessage(`Restack: ${blocked}`);
      return;
    }

    const branches = plan.steps.filter((s) => s.kind === 'rebase').map((s) => s.branch ?? '');
    const confirmed = await vscode.window.showWarningMessage(
      `Rebase ${branches.length} branch${branches.length === 1 ? '' : 'es'} onto ${stack.trunk}?`,
      {
        modal: true,
        detail:
          `Replays ${branches.join(', ')} onto the branch below it, so each one ` +
          `actually sits on its recorded parent.\n\nThis rewrites local history. ` +
          `Restack snapshots every branch SHA first and can roll back.`,
      },
      'Rebase Stack',
    );
    if (confirmed !== 'Rebase Stack') {
      return;
    }

    // The panel renders from the host's plan, so publish it before the run
    // starts or the progress arrives with no steps to attach itself to.
    this.lastPlan = plan;
    this.lastOrder = order;
    this.post({ type: 'plan', plan });

    await this.guard(async () => {
      await this.runner.start(cwd, this.ghPath(), stack, plan, order, 'local');
      await this.refresh();
    });
  }

  /**
   * Dissolve the stack — the missing counterpart to init.
   *
   * Deliberately not an apply. `gh stack unstack` rewrites no commits and moves
   * no branch refs; it deletes a record. There is no cascade to plan, no
   * conflict to pause on, and nothing a snapshot could restore that is not
   * already sitting untouched on disk. So this follows runInit's shape: one
   * guarded command, then a refresh.
   *
   * The scope split mirrors apply's. Local stops at `.git/gh-stack`; remote also
   * detaches the pull requests on GitHub, which nothing here can take back.
   */
  /** Palette entry point: the view may never have loaded a stack. */
  async removeStack(): Promise<void> {
    if (!this.lastStack) {
      await this.refresh();
    }
    await this.handleRemoveStack();
  }

  private async handleRemoveStack(): Promise<void> {
    const cwd = this.workspacePath();
    const stack = this.lastStack;
    if (!cwd || !stack) {
      return;
    }

    if (this.runner.active) {
      void vscode.window.showWarningMessage(
        'Restack: an apply is in progress. Finish or dismiss it first.',
      );
      return;
    }

    const scope = await this.confirmRemove(cwd, stack);
    if (!scope) {
      return;
    }

    await this.guard(async () => {
      const blocked = await unstackPreflight(cwd, scope);
      if (blocked) {
        void vscode.window.showErrorMessage(`Restack: ${blocked}`);
        return;
      }

      const local = scope === 'local';
      this.log.appendLine(`Removing the stack: gh ${unstackArgs(local).join(' ')}`);
      const failure = await runUnstack(cwd, this.ghPath(), local);
      if (failure) {
        void vscode.window.showErrorMessage(`Restack: ${failure}`);
        this.log.show(true);
      }

      // Re-read either way. A remote unstack that GitHub only partly allowed —
      // queued PRs and ones with auto-merge on are left stacked — exits zero and
      // keeps the whole stack, local tracking included.
      await this.refresh();
      if (!failure && this.lastStack) {
        void vscode.window.showWarningMessage(
          'Restack: the stack is still here. GitHub leaves queued PRs and ones with ' +
            'auto-merge enabled stacked, and gh-stack then keeps local tracking too. ' +
            'See the Restack output channel.',
        );
        this.log.show(true);
      }
    });
  }

  private async confirmRemove(cwd: string, stack: Stack): Promise<UnstackScope | undefined> {
    const names = stack.branches.map((b) => b.name);
    const withPrs = stack.branches.filter((b) => b.prNumber);
    // The remote half only has something to do when there are PRs to detach,
    // and somewhere to reach them.
    const canUnstackRemote = withPrs.length > 0 && (await hasOrigin(cwd));

    const remoteNote = canUnstackRemote
      ? `"Remove & Unstack PRs" additionally runs \`gh stack unstack\`, which detaches ` +
        `${withPrs.map((b) => `#${b.prNumber}`).join(', ')} from the stack on GitHub. ` +
        `Restack cannot undo that.`
      : withPrs.length === 0
        ? `No branch here has a pull request, so there is nothing on GitHub to unstack.`
        : `This repository has no origin remote, so there is nothing on GitHub to unstack.`;

    const choice = await vscode.window.showWarningMessage(
      `Remove this stack of ${names.length} branch${names.length === 1 ? '' : 'es'}?`,
      {
        modal: true,
        detail:
          `Removes the stack from gh-stack's tracking. Every branch and every commit ` +
          `stays exactly where it is — ${names.join(', ')} remain as ordinary branches ` +
          `on ${stack.trunk}. Nothing is rebased and nothing is deleted.\n\n` +
          `"Remove Locally" runs \`gh stack unstack --local\`, which touches only ` +
          `.git/gh-stack.\n\n${remoteNote}`,
      },
      ...(canUnstackRemote ? ['Remove Locally', 'Remove & Unstack PRs'] : ['Remove Locally']),
    );

    if (choice === 'Remove Locally') return 'local';
    if (choice === 'Remove & Unstack PRs') return 'remote';
    return undefined;
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
    const scope = await this.confirmApply(
      rebases.map((s) => s.branch ?? ''),
      stack.trunk,
      canPublish,
      plan,
    );
    if (!scope) {
      return;
    }

    const blocked = await preflight(cwd, stack, scope, order);
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
    plan: Plan,
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

    // Membership changes are the part a reorder-shaped dialog would hide, so
    // they get their own line.
    const membership = [
      plan.insertedBranches.length > 0
        ? `Joining the stack: ${plan.insertedBranches.join(', ')}.`
        : '',
      plan.removedBranches.length > 0
        ? `Leaving the stack, rebased back onto ${trunk}: ${plan.removedBranches.join(', ')}.`
        : '',
    ]
      .filter(Boolean)
      .join('\n');

    const choice = await vscode.window.showWarningMessage(
      `Rewrite ${branches.length} branch${branches.length === 1 ? '' : 'es'} on ${trunk}?`,
      {
        modal: true,
        detail:
          `Restack will rebase ${list}, then update .git/gh-stack to record the new ` +
          `order.\n\n${membership}${membership ? '\n\n' : ''}This rewrites local history. ` +
          `Restack snapshots every branch SHA first and can roll back if a rebase ` +
          `conflicts.\n\n${publishNote}`,
      },
      ...(canPublish ? ['Apply Locally', 'Apply & Publish'] : ['Apply Locally']),
    );

    if (choice === 'Apply Locally') return 'local';
    if (choice === 'Apply & Publish') return 'publish';
    return undefined;
  }

  /**
   * Push & submit with no apply session behind it.
   *
   * The session-scoped publish below is only reachable from the panel a
   * successful apply leaves behind. Once that is dismissed — or the window is
   * reloaded — the rebased branches are still sitting there unpushed, so this
   * is the route to origin that does not depend on an apply having just run.
   */
  async pushSubmit(): Promise<void> {
    // The palette can reach this before the view has ever loaded a stack.
    if (!this.lastStack) {
      await this.refresh();
    }
    await this.handlePushSubmit();
  }

  private async handlePushSubmit(): Promise<void> {
    const cwd = this.workspacePath();
    const stack = this.lastStack;
    if (!cwd || !stack) {
      return;
    }

    if (this.runner.active) {
      void vscode.window.showWarningMessage(
        'Restack: an apply is in progress. Use the buttons in the plan panel.',
      );
      return;
    }

    if (!(await hasOrigin(cwd))) {
      void vscode.window.showErrorMessage('Restack: no `origin` remote to push to.');
      return;
    }

    const confirmed = await vscode.window.showWarningMessage(
      'Push the current stack to GitHub?',
      {
        modal: true,
        detail:
          'Runs `gh stack push` (per-branch --force-with-lease), then ' +
          '`gh stack submit --auto` to create or retarget each PR.\n\n' +
          'This pushes the stack as it is on disk right now, whether or not ' +
          'Restack applied it. It changes pull requests other people may already ' +
          'be reviewing, and Restack cannot undo it.',
      },
      'Push & Submit',
    );

    if (confirmed !== 'Push & Submit') {
      return;
    }

    await this.guard(async () => {
      await this.runner.publishOnly(cwd, this.ghPath(), stack);
      await this.refresh();
    });
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
        candidates: [],
        canPublish: false,
      });
      return;
    }

    this.post({ type: 'loading' });
    const cwd = folder.uri.fsPath;
    let result: StackResult = await readStack(cwd, this.ghPath());
    this.lastStack = result.kind === 'ok' ? result.stack : undefined;
    // The plan described the pre-refresh order; holding on to it would let a
    // later apply run stale commands.
    this.lastPlan = undefined;
    this.lastOrder = undefined;

    // With no stack to read, the view still needs branches to offer and a
    // trunk to base them on — and the stacks already on disk, which are what
    // separate "there is nothing here" from "you are just standing outside
    // one". Branches already in some other stack are excluded: adopting one
    // into a second stack is not something gh-stack models.
    let candidates: CandidateBranch[] = [];
    if (this.lastStack) {
      candidates = await readCandidates(cwd, this.lastStack);
    } else if (result.kind === 'no-stack') {
      const [{ trunk, localBranches }, stacks] = await Promise.all([
        detectTrunk(cwd),
        readLocalStacks(cwd),
      ]);
      candidates = await readBranchCandidates(cwd, trunk, new Set(stacks.flatMap((s) => s.branches)));
      result = { ...result, trunk, localBranches, stacks };
    }
    this.lastCandidates = candidates;

    this.post({ type: 'stack', result, candidates, canPublish: await hasOrigin(cwd) });
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

/** Run git. Never rejects. */
async function git(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; error: string }> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, timeout: 20_000 });
    return { ok: true, stdout, error: '' };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const error = (e.stderr || e.message || 'git failed.').trim().split('\n')[0];
    return { ok: false, stdout: '', error };
  }
}

/** Whether a recorded SHA still exists in the object database. */
async function resolves(cwd: string, sha: string): Promise<boolean> {
  return (await git(cwd, ['cat-file', '-e', `${sha}^{commit}`])).ok;
}

/** Check out `branch`, returning an error message rather than throwing. */
async function checkout(cwd: string, branch: string): Promise<string | undefined> {
  const status = await git(cwd, ['status', '--porcelain', '--untracked-files=no']);
  if (status.stdout.trim().length > 0) {
    return 'Working tree has uncommitted changes. Commit or stash them before switching branches.';
  }
  const result = await git(cwd, ['checkout', branch]);
  return result.ok ? undefined : result.error;
}

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Restack');
  const provider = new StackViewProvider(context, log);

  context.subscriptions.push(
    log,
    vscode.window.registerWebviewViewProvider('restack.stackView', provider),
    vscode.commands.registerCommand('restack.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('restack.pushSubmit', () => provider.pushSubmit()),
    vscode.commands.registerCommand('restack.rebaseStack', () => provider.rebaseStack()),
    vscode.commands.registerCommand('restack.removeStack', () => provider.removeStack()),
    vscode.commands.registerCommand('restack.showLog', () => log.show()),
  );

  // Before any refresh, so a webview connecting for the first time is replayed
  // the session this window was reloaded out of.
  void provider.restoreSession();
}

export function deactivate(): void {}
