import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readStack } from './stack';
import { readCandidates, readBranchCandidates } from './candidates';
import { addArgs, changeBasePlan, computePlan, initArgs, syncPlan, unstackArgs } from './plan';
import {
  detectRemote,
  ensureBaseBranch,
  fetchRemote,
  readAllTracking,
  listRemoteBranches,
  listRemotes,
  localNameFor,
  readRemoteState,
} from './remote';
import {
  ApplyRunner,
  hasOrigin,
  preflight,
  rebaseInProgress,
  type PersistedSession,
} from './apply';
import {
  addPreflight,
  detectTrunk,
  initPreflight,
  listLocalBranches,
  readLocalStacks,
  runAdd,
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
  RemoteState,
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
  private lastRemote?: RemoteState;
  private readonly runner: ApplyRunner;
  private readonly log: vscode.OutputChannel;
  private readonly status: vscode.StatusBarItem;
  /** Watches `.git/index`; alive only while a conflict is paused. See watchIndex. */
  private indexWatcher?: vscode.Disposable;

  constructor(
    private readonly context: vscode.ExtensionContext,
    log: vscode.OutputChannel,
    status: vscode.StatusBarItem,
  ) {
    this.log = log;
    this.status = status;
    this.runner = new ApplyRunner(
      (progress) => {
        this.post({ type: 'apply', progress });
        // Staging is what ends a conflict, and it happens outside this
        // extension — in the merge editor, the SCM view, or a terminal. The
        // watcher is how the panel finds out.
        this.watchIndex(progress.phase === 'conflict');
      },
      {
        persist: (state) => void this.context.workspaceState.update(SESSION_KEY, state),
        log: (line) => this.log.appendLine(line),
      },
    );
  }

  /**
   * Start or stop watching the git index.
   *
   * Only runs while a conflict is open: outside one there is nothing to
   * recompute, and the index is written by every ordinary git operation in the
   * workspace. Staging rewrites it several times in a row, hence the debounce.
   */
  private watchIndex(wanted: boolean): void {
    if (wanted === (this.indexWatcher !== undefined)) {
      return;
    }
    if (!wanted) {
      this.indexWatcher?.dispose();
      this.indexWatcher = undefined;
      return;
    }

    const watcher = vscode.workspace.createFileSystemWatcher('**/.git/index');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bump = () => {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = undefined;
        void this.runner.refreshConflict();
      }, 250);
    };

    this.indexWatcher = vscode.Disposable.from(
      watcher,
      watcher.onDidChange(bump),
      watcher.onDidCreate(bump),
      new vscode.Disposable(() => timer && clearTimeout(timer)),
    );
    // A backstop only: the pair above is what normally disposes it.
    this.context.subscriptions.push(this.indexWatcher);
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
          void this.handleInitStack(message.trunk, message.branches, message.trunkIsRemote);
          break;
        case 'fetch':
          void this.fetch();
          break;
        case 'syncStack':
          void this.handleSyncStack();
          break;
        case 'changeBase':
          void this.handleChangeBase(message.base, message.isRemote);
          break;
        case 'pickBase':
          void this.changeBase();
          break;
        case 'addBranch':
          void this.handleAddBranch(message.branch);
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
        case 'openMergeEditor':
          void this.openMergeEditor(message.path);
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
    const target = this.resolveInWorkspace(relative);
    if (!target) {
      return;
    }
    await this.guard(() => this.showAsText(target));
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
  private async openMergeEditor(relative: string): Promise<void> {
    const target = this.resolveInWorkspace(relative);
    if (!target) {
      return;
    }

    await this.guard(async () => {
      try {
        await vscode.commands.executeCommand('git.openMergeEditor', target);
      } catch (err) {
        this.log.appendLine(
          `git.openMergeEditor failed for ${relative}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (isMergeTab(vscode.window.tabGroups.activeTabGroup.activeTab?.input)) {
        return;
      }
      await this.showAsText(target);
    });
  }

  /** Open `target` as an ordinary text document, conflict markers and all. */
  private async showAsText(target: vscode.Uri): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(target);
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  /**
   * Resolve a workspace-relative path, refusing anything that escapes the
   * folder. The path comes from `git diff` in this workspace, but it arrives
   * over a message channel, so it is re-checked rather than trusted.
   */
  private resolveInWorkspace(relative: string): vscode.Uri | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return undefined;
    }
    const target = vscode.Uri.joinPath(folder.uri, relative);
    const root = folder.uri.fsPath.replace(/\/*$/, '/');
    return target.fsPath.startsWith(root) ? target : undefined;
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
      // A rebase Restack did not start — left over from a terminal, say — is
      // invisible to the check above, and switching out of one strands it.
      if (await rebaseInProgress(cwd)) {
        void vscode.window.showErrorMessage(
          'Restack: a rebase is in progress. Finish it (`git rebase --continue`) or abort it before switching branches.',
        );
        return;
      }

      const result = await checkout(cwd, branch);
      if (result) {
        void vscode.window.showErrorMessage(`Restack: ${result}`);
        return;
      }
      await this.refresh();
    });
  }

  /**
   * Pick a branch to check out from the stack — the palette and status bar
   * route to the same place the view's per-row buttons post to.
   *
   * Listed top-down, matching the view, with the trunk last: it is where the
   * stack sits rather than a part of it, but it is still somewhere you stand.
   */
  async checkoutBranch(): Promise<void> {
    if (!this.lastStack) {
      await this.refresh();
    }
    const stack = this.lastStack;
    if (!stack) {
      void vscode.window.showInformationMessage(
        'Restack: no stack here to check out from. Open the Restack view to create one.',
      );
      return;
    }

    const current = stack.currentBranch;
    const items: Array<vscode.QuickPickItem & { branch: string }> = [
      ...[...stack.branches].reverse().map((b, i) => ({
        branch: b.name,
        label: `${b.name === current ? '$(check) ' : '$(circle-outline) '}${b.name}`,
        description: b.prNumber ? `#${b.prNumber}` : undefined,
        detail: [
          `${stack.branches.length - i} of ${stack.branches.length}`,
          b.isMerged ? 'merged' : b.isQueued ? 'queued' : '',
          b.needsRebase ? 'needs rebase' : '',
        ]
          .filter(Boolean)
          .join(' · '),
      })),
      {
        branch: stack.trunk,
        label: `${stack.trunk === current ? '$(check) ' : '$(circle-outline) '}${stack.trunk}`,
        description: 'trunk',
      },
    ];

    const picked = await vscode.window.showQuickPick(items, {
      title: 'Check out a branch in this stack',
      placeHolder: current ? `On ${current}` : 'Select a branch',
    });
    if (picked && picked.branch !== current) {
      await this.handleCheckout(picked.branch);
    }
  }

  /**
   * Mirror HEAD's position in the status bar, so the stack is legible without
   * the view open. Hidden whenever there is no stack to be positioned within.
   */
  private updateStatus(stack: Stack | undefined): void {
    if (!stack || !stack.currentBranch) {
      this.status.hide();
      return;
    }

    const total = stack.branches.length;
    const index = stack.branches.findIndex((b) => b.name === stack.currentBranch);
    const onTrunk = stack.currentBranch === stack.trunk;

    // Counted from the bottom, so it reads the same way the column does.
    const position = onTrunk ? 'trunk' : index >= 0 ? `${index + 1}/${total}` : 'outside';
    this.status.text = `$(git-branch) ${stack.currentBranch} ${position}`;
    this.status.tooltip =
      (onTrunk
        ? `On ${stack.trunk}, the trunk this stack sits on.`
        : index >= 0
          ? `On ${stack.currentBranch} — branch ${index + 1} of ${total} in the stack.`
          : `On ${stack.currentBranch}, which is not part of this stack.`) +
      '\n\nClick to check out another branch in the stack.';
    this.status.show();
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
   * Turn a picked remote-tracking ref into a local branch fit to base a stack
   * on, fetching first so "up to date" means it.
   *
   * Both entry points — init and change-base — need exactly this, and needed it
   * to be more than `git branch --track`. That command is right the first time
   * and wrong every time after: the local branch already exists, at whatever
   * commit it was created at, while its owner has moved on. Adopting it
   * silently would replay the whole stack onto a stale base with nothing on
   * screen saying so.
   *
   * The fetch is here rather than left to the user for the same reason
   * handleSyncStack fetches: a base resolved from stale refs is stale whether
   * or not anyone remembered to press the button. A failed fetch is reported
   * but not fatal — the refs on disk may still be recent enough, and refusing
   * outright would make an offline repository unusable for a local base.
   *
   * Returns the local branch name, or undefined when the caller should stop.
   */
  private async resolveRemoteBase(cwd: string, picked: string): Promise<string | undefined> {
    const remotes = await listRemotes(cwd);
    const local = localNameFor(picked, remotes);
    // Found by matching, not by slicing off the difference: when `picked` has
    // no remote prefix at all localNameFor returns it unchanged, and arithmetic
    // on the two lengths would invent a remote out of the branch name.
    const remote = remotes.find((r) => picked.startsWith(`${r}/`));

    if (remote) {
      const failure = await vscode.window.withProgress(
        { location: { viewId: 'restack.stackView' }, title: `Fetching ${remote}…` },
        () => fetchRemote(cwd, remote),
      );
      if (failure) {
        this.log.appendLine(`Could not fetch ${remote} before resolving ${picked}: ${failure}`);
      }
    }

    const result = await ensureBaseBranch(cwd, local, picked);
    switch (result.kind) {
      case 'failed':
        void vscode.window.showErrorMessage(`Restack: ${result.message}`);
        return undefined;

      case 'diverged': {
        // Local commits on a branch we do not own. Fast-forwarding is not an
        // option and rewriting it is not ours to do, so the stack would sit on
        // a base that is neither theirs nor cleanly ours — say so and stop.
        void vscode.window.showErrorMessage(
          `Restack: ${local} has ${result.ahead} commit${result.ahead === 1 ? '' : 's'} ` +
            `${picked} does not` +
            (result.behind > 0 ? `, and is ${result.behind} behind it` : '') +
            `. Reconcile it before basing a stack on it.`,
        );
        return undefined;
      }

      case 'fastForwarded':
        this.log.appendLine(
          `Fast-forwarded ${local} ${result.by} commit${result.by === 1 ? '' : 's'} to ${picked}.`,
        );
        return local;

      case 'created':
        this.log.appendLine(`Created ${local} tracking ${picked}.`);
        return local;

      default:
        return local;
    }
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
  private async handleInitStack(
    trunk: string,
    branches: string[],
    trunkIsRemote?: boolean,
  ): Promise<void> {
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
      let base = trunk;
      if (trunkIsRemote) {
        // A stack does not have to sit on the default branch, and the branch it
        // sits on often belongs to someone else and exists only on the remote.
        // gh-stack records a trunk by name and initPreflight resolves it
        // locally, so the local branch has to exist — and be current — first.
        // Failing here aborts before `gh stack init` runs; nothing is
        // half-created.
        const resolved = await this.resolveRemoteBase(cwd, trunk);
        if (!resolved) {
          return;
        }
        base = resolved;
      }

      const blocked = await initPreflight(cwd, base, branches);
      if (blocked) {
        void vscode.window.showErrorMessage(`Restack: ${blocked}`);
        return;
      }

      this.log.appendLine(`Creating a stack: gh ${initArgs(base, branches).join(' ')}`);
      const failure = await runInit(cwd, this.ghPath(), base, branches);
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
   * Extend an existing stack by one branch, on top of it.
   *
   * The counterpart to init's typed-in branch, which was only ever reachable
   * from the empty state — once a stack existed there was no way to say "and
   * one more on top" without a terminal. Dragging does not cover it either: a
   * branch created just now is fully merged into trunk, so readCandidates
   * filters it out of the tray and it never appears to drag.
   *
   * Top-only because gh-stack is: v0.1.0 exits 5 with `can only add branches to
   * the top of the stack` anywhere else. So we stand there first — which is a
   * checkout, and the reason addPreflight refuses a dirty tree even though
   * `gh stack add` itself does not.
   *
   * Not an apply: nothing is rebased and no commit is rewritten, so there is no
   * plan to preview and nothing to snapshot. An adopted branch lands flagged
   * `needsRebase`, exactly as init leaves one, and the drift banner's
   * *Rebase stack* button is the undoable step that replays it.
   */
  private async handleAddBranch(branch: string): Promise<void> {
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

    const name = branch.trim();
    const names = stack.branches.map((b) => b.name);

    await this.guard(async () => {
      const blocked = await addPreflight(cwd, stack.trunk, names, name);
      if (blocked) {
        void vscode.window.showErrorMessage(`Restack: ${blocked}`);
        return;
      }

      // gh stack add only works from the top. Doing this ourselves rather than
      // letting gh-stack refuse keeps the failure modes to one: the checkout is
      // guarded by the same dirty-tree check as every other checkout here.
      const top = names[names.length - 1];
      if (top && stack.currentBranch !== top) {
        this.log.appendLine(`Moving to the top of the stack to add ${name}: git checkout ${top}`);
        const moved = await checkout(cwd, top);
        if (moved) {
          void vscode.window.showErrorMessage(`Restack: ${moved}`);
          return;
        }
      }

      this.log.appendLine(`Adding a branch: gh ${addArgs(name).join(' ')}`);
      const failure = await runAdd(cwd, this.ghPath(), name);
      if (failure) {
        void vscode.window.showErrorMessage(`Restack: ${failure}`);
        this.log.show(true);
      }

      // Either way, for init's reason: a failed add can still have created the
      // branch, and the view has to show what is actually on disk. Success also
      // moves HEAD onto the new branch, which the indicator should follow.
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
   * Go and ask the remote, then re-render.
   *
   * The only place Restack initiates network traffic on its own. Everything the
   * view shows about the remote — the ahead/behind counts, the sync banner, the
   * clobber warning — is read from local refs, so it is only ever as fresh as
   * the last fetch. This is the button that makes it fresh.
   */
  async fetch(): Promise<void> {
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
      const remote = await detectRemote(cwd, this.lastStack?.trunk ?? 'main');
      if (!remote) {
        void vscode.window.showInformationMessage('Restack: no remote to fetch from.');
        return;
      }

      const failure = await vscode.window.withProgress(
        { location: { viewId: 'restack.stackView' }, title: `Fetching ${remote}…` },
        () => fetchRemote(cwd, remote),
      );
      if (failure) {
        void vscode.window.showErrorMessage(`Restack: ${failure}`);
        this.log.show(true);
      }

      // Either way: a partial fetch still moved some refs, and the counts
      // should reflect what is actually on disk.
      await this.refresh();
    });
  }

  /**
   * Bring the stack up to date with a trunk that has moved.
   *
   * Fetches first, always. A sync plan built from stale refs would fast-forward
   * the trunk to a commit that is no longer its tip, and the whole cascade would
   * replay onto the wrong place — so the network call is part of the action
   * rather than something the user is expected to have done first.
   *
   * The stack is re-read after the fetch for the same reason the plan is built
   * after it: `gh stack view`'s `needsRebase` and recorded bases both describe
   * the pre-fetch world.
   *
   * Everything after that is an ordinary apply — snapshot, conflict pause, undo,
   * reload persistence — because syncPlan produces an ordinary Plan.
   */
  /** Palette entry point: the view may never have loaded a stack. */
  async syncStack(): Promise<void> {
    if (!this.lastStack) {
      await this.refresh();
    }
    if (!this.lastStack) {
      void vscode.window.showInformationMessage('Restack: no stack here to sync.');
      return;
    }
    await this.handleSyncStack();
  }

  private async handleSyncStack(): Promise<void> {
    const cwd = this.workspacePath();
    if (!cwd || !this.lastStack) {
      return;
    }

    if (this.runner.active) {
      void vscode.window.showWarningMessage(
        'Restack: an apply is in progress. Use the buttons in the plan panel.',
      );
      return;
    }

    await this.guard(async () => {
      const remote = await detectRemote(cwd, this.lastStack?.trunk ?? 'main');
      if (!remote) {
        void vscode.window.showErrorMessage('Restack: no remote to sync with.');
        return;
      }

      const failure = await vscode.window.withProgress(
        { location: { viewId: 'restack.stackView' }, title: `Fetching ${remote}…` },
        () => fetchRemote(cwd, remote),
      );
      if (failure) {
        void vscode.window.showErrorMessage(`Restack: ${failure}`);
        this.log.show(true);
        return;
      }

      // Re-read against post-fetch refs before planning anything.
      await this.refresh();
      const stack = this.lastStack;
      const remoteState = this.lastRemote;
      if (!stack) {
        return;
      }

      if (!remoteState || remoteState.trunk.behind === 0) {
        void vscode.window.showInformationMessage(
          `Restack: ${stack.trunk} is already up to date with ${remote}.`,
        );
        return;
      }

      const onTrunk = stack.currentBranch === stack.trunk;
      const plan = syncPlan(stack, remote, onTrunk);
      if (plan.isNoop) {
        void vscode.window.showInformationMessage('Restack: nothing to replay.');
        return;
      }

      const order = stack.branches.map((b) => b.name);
      const blocked = await preflight(cwd, stack, 'local', order);
      if (blocked) {
        void vscode.window.showErrorMessage(`Restack: ${blocked}`);
        return;
      }

      const rebases = plan.steps.filter((s) => s.kind === 'rebase').map((s) => s.branch ?? '');
      const behind = remoteState.trunk.behind;
      const confirmed = await vscode.window.showWarningMessage(
        `Fast-forward ${stack.trunk} and replay ${rebases.length} branch${rebases.length === 1 ? '' : 'es'}?`,
        {
          modal: true,
          detail:
            `${stack.trunk} is ${behind} commit${behind === 1 ? '' : 's'} behind ` +
            `${remote}/${stack.trunk}. Restack will fast-forward it, then replay ` +
            `${rebases.join(', ')} on top.\n\nThis rewrites local history. Every branch SHA ` +
            `is snapshotted first and can be rolled back. Nothing is pushed.`,
        },
        'Sync Stack',
      );
      if (confirmed !== 'Sync Stack') {
        return;
      }

      this.lastPlan = plan;
      this.lastOrder = order;
      this.post({ type: 'plan', plan });

      await this.runner.start(cwd, this.ghPath(), stack, plan, order, 'local');
      await this.refresh();
    });
  }

  /**
   * Move the whole stack onto a different base.
   *
   * The counterpart to picking a base at init time: a stack built on a
   * colleague's branch has to move to `main` once that branch merges, and
   * before this there was no way to do it short of unstacking and starting
   * over.
   *
   * The entire change is `{...stack, trunk: base}` — computePlan reads the trunk
   * from the stack it is handed, and writeMetadata records the trunk from the
   * stack the session was started with. Passing the modified stack to both is
   * what makes this work; there is no new rebase arithmetic.
   */
  private async handleChangeBase(base: string, isRemote?: boolean): Promise<void> {
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

    await this.guard(async () => {
      let local = base;
      if (isRemote) {
        // Checked before the branch is created, not after: a name already in
        // the stack is a refusal, and creating it first would leave a branch
        // behind for a change that never happens.
        local = localNameFor(base, await listRemotes(cwd));
        if (stack.branches.some((b) => b.name === local)) {
          void vscode.window.showErrorMessage(
            `Restack: ${local} is in this stack, so it cannot also be its base.`,
          );
          return;
        }
        // Fetches, creates or catches up the local branch, and refuses if it
        // has drifted. gh-stack records a trunk by name and every check below
        // resolves it locally, so this comes before all of them.
        const resolved = await this.resolveRemoteBase(cwd, base);
        if (!resolved) {
          return;
        }
        local = resolved;
      }

      if (local === stack.trunk) {
        void vscode.window.showInformationMessage(
          `Restack: this stack is already based on ${local}.`,
        );
        return;
      }
      if (stack.branches.some((b) => b.name === local)) {
        void vscode.window.showErrorMessage(
          `Restack: ${local} is in this stack, so it cannot also be its base.`,
        );
        return;
      }

      const rebased: Stack = { ...stack, trunk: local };
      const order = stack.branches.map((b) => b.name);
      const plan = changeBasePlan(stack, local);
      if (plan.isNoop) {
        void vscode.window.showInformationMessage('Restack: nothing to replay.');
        return;
      }

      // Against the *new* trunk: its merge-base check is exactly the question
      // of whether these branches can be replayed onto it at all.
      const blocked = await preflight(cwd, rebased, 'local', order);
      if (blocked) {
        void vscode.window.showErrorMessage(`Restack: ${blocked}`);
        return;
      }

      // A *local* base gets no fetch above, so it may be well behind its own
      // upstream — and the stack is about to be replayed onto whatever commit
      // it is sitting on. Stated rather than refused: basing on a deliberately
      // older commit is legitimate, and Sync stack is the fix if it was not.
      const staleness = isRemote ? undefined : await this.baseStaleness(cwd, local);

      const bottom = order[0];
      const withPr = stack.branches[0]?.prNumber;
      const confirmed = await vscode.window.showWarningMessage(
        `Re-base this stack from ${stack.trunk} onto ${local}?`,
        {
          modal: true,
          detail:
            `Replays ${bottom} onto ${local}, and cascades every branch above it. ` +
            `.git/gh-stack is updated to record ${local} as the trunk.\n\n` +
            (staleness ? `${staleness}\n\n` : '') +
            (withPr
              ? `#${withPr} currently targets ${stack.trunk}; the next \`gh stack submit\` ` +
                `will retarget it to ${local}.\n\n`
              : '') +
            `This rewrites local history. Every branch SHA is snapshotted first and can ` +
            `be rolled back. Nothing is pushed.`,
        },
        'Change Base',
      );
      if (confirmed !== 'Change Base') {
        return;
      }

      this.lastPlan = plan;
      this.lastOrder = order;
      this.post({ type: 'plan', plan });

      // The modified stack, not the original: this is what writeMetadata reads
      // the trunk from, and so what lands in .git/gh-stack.
      await this.runner.start(cwd, this.ghPath(), rebased, plan, order, 'local');
      await this.refresh();
    });
  }

  /**
   * A sentence about a local base that has fallen behind its upstream, or
   * nothing when it has not.
   *
   * Local refs only, so this is as stale as the last fetch — which is exactly
   * what it is warning about, and why it is worded as of-the-last-fetch rather
   * than as fact.
   */
  private async baseStaleness(cwd: string, base: string): Promise<string | undefined> {
    const tracking = (await readAllTracking(cwd)).get(base);
    if (!tracking || tracking.gone || tracking.behind === 0) {
      return undefined;
    }
    return (
      `Note: ${base} is ${tracking.behind} commit${tracking.behind === 1 ? '' : 's'} behind ` +
      `${tracking.upstream ?? 'its upstream'} as of the last fetch, so the stack will land on ` +
      `that older commit. Sync stack afterwards to catch it up.`
    );
  }

  /** Palette entry point: pick a base rather than being handed one. */
  async changeBase(): Promise<void> {
    if (!this.lastStack) {
      await this.refresh();
    }
    const cwd = this.workspacePath();
    const stack = this.lastStack;
    if (!cwd || !stack) {
      void vscode.window.showInformationMessage('Restack: no stack here to re-base.');
      return;
    }

    const inStack = new Set(stack.branches.map((b) => b.name));
    const [locals, remotes] = await Promise.all([
      listLocalBranches(cwd),
      listRemoteBranches(cwd),
    ]);
    const remoteNames = await listRemotes(cwd);

    const items: Array<vscode.QuickPickItem & { base: string; isRemote: boolean }> = [
      ...locals
        .filter((n) => !inStack.has(n) && n !== stack.trunk)
        .map((n) => ({ base: n, isRemote: false, label: `$(git-branch) ${n}` })),
      ...remotes
        .filter((n) => !inStack.has(localNameFor(n, remoteNames)))
        .map((n) => ({
          base: n,
          isRemote: true,
          label: `$(cloud) ${n}`,
          description: 'creates a local tracking branch',
        })),
    ];

    if (items.length === 0) {
      void vscode.window.showInformationMessage('Restack: no other branch to base this stack on.');
      return;
    }

    const picked = await vscode.window.showQuickPick(items, {
      title: `Re-base this stack (currently on ${stack.trunk})`,
      placeHolder: 'Pick the branch the bottom of the stack should sit on',
    });
    if (picked) {
      await this.handleChangeBase(picked.base, picked.isRemote);
    }
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
      this.updateStatus(undefined);
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
    this.updateStatus(this.lastStack);
    // Local ref reads only — no network — so this is safe on the .git/HEAD
    // watcher path, which fires on every checkout and every rebase step.
    this.lastRemote = this.lastStack ? await readRemoteState(cwd, this.lastStack) : undefined;
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
      const [{ trunk, localBranches, remoteBranches }, stacks] = await Promise.all([
        detectTrunk(cwd),
        readLocalStacks(cwd),
      ]);
      candidates = await readBranchCandidates(cwd, trunk, new Set(stacks.flatMap((s) => s.branches)));
      result = { ...result, trunk, localBranches, remoteBranches, stacks };
    }
    this.lastCandidates = candidates;

    this.post({
      type: 'stack',
      result,
      candidates,
      canPublish: await hasOrigin(cwd),
      remote: this.lastRemote,
    });
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

/**
 * Whether the merge editor is what actually opened.
 *
 * `vscode.TabInputTextMerge` exists at runtime but is absent from
 * `@types/vscode` (checked against 1.125), so `instanceof` will not compile.
 * The shape is the check instead, and it is an unambiguous one: the merge input
 * is the only tab input carrying a base/input1/input2/result quadruple.
 */
function isMergeTab(input: unknown): boolean {
  if (typeof input !== 'object' || input === null) {
    return false;
  }
  const tab = input as Record<string, unknown>;
  return ['base', 'input1', 'input2', 'result'].every((key) => tab[key] instanceof vscode.Uri);
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
  // Left of centre, so it sits near the git extension's own branch indicator
  // rather than out at the far end with the language tools.
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'restack.checkoutBranch';
  const provider = new StackViewProvider(context, log, status);

  context.subscriptions.push(
    log,
    status,
    vscode.window.registerWebviewViewProvider('restack.stackView', provider),
    vscode.commands.registerCommand('restack.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('restack.pushSubmit', () => provider.pushSubmit()),
    vscode.commands.registerCommand('restack.rebaseStack', () => provider.rebaseStack()),
    vscode.commands.registerCommand('restack.fetch', () => provider.fetch()),
    vscode.commands.registerCommand('restack.syncStack', () => provider.syncStack()),
    vscode.commands.registerCommand('restack.changeBase', () => provider.changeBase()),
    vscode.commands.registerCommand('restack.removeStack', () => provider.removeStack()),
    vscode.commands.registerCommand('restack.checkoutBranch', () => provider.checkoutBranch()),
    vscode.commands.registerCommand('restack.showLog', () => log.show()),
  );

  // Before any refresh, so a webview connecting for the first time is replayed
  // the session this window was reloaded out of. The refresh that follows is
  // what the status bar is drawn from — without it the stack stays invisible
  // until the view is opened, which is the opposite of the point.
  void provider.restoreSession().then(() => provider.refresh());
}

export function deactivate(): void {}
