import * as vscode from 'vscode';
import { readStack } from '../stack';
import { readBranchCandidates } from '../candidates';
import { computePlan } from '../plan';
import { readRemoteState } from '../remote';
import { ApplyRunner, hasOrigin, type PersistedSession } from '../apply';
import { ChangesReader, readTips } from '../changes';
import { detectTrunk } from '../init';
import { emptyGraph, readGithubGraph } from '../github';
import { readPullRequests, readStackSummaries, remoteOnlyStacks } from '../stacks';
import type {
  CandidateBranch,
  GithubGraph,
  HostMessage,
  Plan,
  RemoteState,
  RemoteStackSummary,
  Stack,
  StackResult,
  StackSummary,
  WebviewMessage,
  WorkingTree,
} from '../model';
import { git, resolves } from './git';
import type { Host } from './host';
import { webviewHtml } from './html';
import { pickBase, pickBranch, pickStack } from './picks';
import { updateStatus } from './status';
import { handleAddBranch } from './operations/add';
import { handleApply, handlePublish, handlePushSubmit } from './operations/apply';
import { handleChangeBase } from './operations/base';
import { handleLoadChanges } from './operations/changes';
import { openCommitDiff, openWorkingDiff } from './documents';
import {
  handleCheckout,
  handleCheckoutRemoteStack,
  handleNewStack,
  handleSwitchStack,
} from './operations/checkout';
import { openFile, openMergeEditor, openUrl } from './operations/files';
import { handleInitStack } from './operations/init';
import { handleRebaseStack } from './operations/rebase';
import { handleRemoveStack } from './operations/remove';
import { GH_CLI_URL, handleInstallGhStack, openGhPathSetting } from './operations/setup';
import { fetch as fetchRemoteState, handleSyncStack } from './operations/sync';

/** workspaceState key holding an apply session across a window reload. */
const SESSION_KEY = 'restack.session';

/**
 * globalState key: whether the "gh-stack is missing" notice has been shown.
 *
 * Global rather than per-workspace, and cleared the moment a stack reads
 * successfully — the dependency is a property of the machine, so being told
 * once per machine is the right dose, and being told again after uninstalling
 * it is better than silence.
 */
const SETUP_NOTICE_KEY = 'restack.setupNoticeShown';

/**
 * Restack: read the stack, let the user drag branches into a new order, render
 * the exact git plan that reorder requires, and run it.
 *
 * Applying is split in two. The local half — rebases plus the gh-stack metadata
 * write — is fully reversible from the snapshot in apply.ts. The remote half —
 * force-push and submit — is not, so it never runs without its own explicit
 * confirmation, even when the user picked "Apply & Publish" up front.
 *
 * The operations themselves live in `operations/`, and reach back in here
 * through the `Host` interface this implements — see host.ts.
 */
export class StackViewProvider implements vscode.WebviewViewProvider, Host {
  private view?: vscode.WebviewView;
  private lastStack?: Stack;
  private lastPlan?: Plan;
  private lastOrder?: string[];
  private lastCandidates: CandidateBranch[] = [];
  private lastRemote?: RemoteState;
  /** Every stack in the repository, for the switcher. See stacks.ts. */
  private lastStacks: StackSummary[] = [];
  /** Stacks GitHub knows about and this clone does not. See stacks.ts. */
  private lastRemoteStacks: RemoteStackSummary[] = [];
  /** Reads and caches per-branch commits and counts. See changes.ts. */
  private readonly changesReader = new ChangesReader();
  private lastTips = new Map<string, string>();
  private lastCounts: Record<string, number> = {};
  private lastWorkingTree?: WorkingTree;
  /**
   * What GitHub says about this repository: its pull requests keyed by head
   * branch, and the stacks those PRs belong to.
   *
   * Cached because refresh() runs on every `.git/HEAD` change — once per rebase
   * step during an apply — and this is the only part of it that reaches the
   * network. Refilled by fetch() and by an explicit stack switch, which are the
   * two moments the user has asked for current information, plus one deferred
   * read after the first refresh so a freshly opened window is not blank.
   */
  private github: GithubGraph = emptyGraph();
  /** Whether the deferred first read has been started. See loadGithub. */
  private githubLoaded = false;
  readonly runner: ApplyRunner;
  readonly log: vscode.OutputChannel;
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

  // The Host surface. The `lastX` fields stay private: several operations
  // deliberately re-read these after an `await refresh()`, so they have to be
  // live reads rather than values captured at call time.
  get stack(): Stack | undefined {
    return this.lastStack;
  }
  get stacks(): StackSummary[] {
    return this.lastStacks;
  }
  get remoteStacks(): RemoteStackSummary[] {
    return this.lastRemoteStacks;
  }
  get remote(): RemoteState | undefined {
    return this.lastRemote;
  }
  get plan(): Plan | undefined {
    return this.lastPlan;
  }
  get order(): string[] | undefined {
    return this.lastOrder;
  }
  get changes(): ChangesReader {
    return this.changesReader;
  }
  get tips(): Map<string, string> {
    return this.lastTips;
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
   * Keep the working-tree section current.
   *
   * Two signals, because neither is sufficient. `.git/index` moves when a file
   * is staged but not when it is edited; a save moves the file but not the
   * index. Both post only the working tree — a full refresh here would re-read
   * the stack, and reach gh, every time the user hits save.
   *
   * Silent while an apply owns the repository: a rebase writes the index
   * constantly, and none of it is the user's uncommitted work.
   */
  private watchWorkingTree(): vscode.Disposable {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bump = () => {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = undefined;
        void this.postWorkingTree();
      }, 250);
    };

    const watcher = vscode.workspace.createFileSystemWatcher('**/.git/index');
    return vscode.Disposable.from(
      watcher,
      watcher.onDidChange(bump),
      watcher.onDidCreate(bump),
      vscode.workspace.onDidSaveTextDocument(bump),
      new vscode.Disposable(() => timer && clearTimeout(timer)),
    );
  }

  private async postWorkingTree(): Promise<void> {
    const cwd = this.cwd();
    if (!cwd || this.runner.active) {
      return;
    }
    this.lastWorkingTree = await this.changesReader.workingTree(cwd);
    this.post({ type: 'workingTree', workingTree: this.lastWorkingTree });
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

    const cwd = this.cwd();
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
    view.webview.html = webviewHtml(view.webview, this.context.extensionUri);

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
          void handleApply(this, message.order);
          break;
        case 'initStack':
          void handleInitStack(this, message.trunk, message.branches, message.trunkIsRemote);
          break;
        case 'fetch':
          void this.fetch();
          break;
        case 'syncStack':
          void handleSyncStack(this);
          break;
        case 'changeBase':
          void handleChangeBase(this, message.base, message.isRemote);
          break;
        case 'pickBase':
          void this.changeBase();
          break;
        case 'addBranch':
          void handleAddBranch(this, message.branch);
          break;
        case 'rebaseStack':
          void handleRebaseStack(this);
          break;
        case 'removeStack':
          void handleRemoveStack(this);
          break;
        case 'publish':
          void handlePublish(this);
          break;
        case 'pushSubmit':
          void handlePushSubmit(this);
          break;
        case 'applyContinue':
          void this.guard(() => this.runner.resume());
          break;
        case 'applyAbort':
        case 'applyUndo':
          // Refreshed like every other operation that moves refs. A rollback
          // puts the branches and .git/gh-stack back, but nothing re-reads
          // them, so the rows would keep rendering the order the apply
          // produced — the repository restored and the view still showing the
          // change undone.
          void this.guard(async () => {
            await this.runner.abort();
            await this.refresh();
          });
          break;
        case 'applyDismiss':
          this.runner.dismiss();
          this.post({ type: 'applyCleared' });
          break;
        case 'openUrl':
          void openUrl(message.url);
          break;
        case 'openFile':
          void openFile(this, message.path);
          break;
        case 'openMergeEditor':
          void openMergeEditor(this, message.path);
          break;
        case 'openCommitFile':
          void openCommitDiff(this, message.sha, message.path, message.oldPath, message.base);
          break;
        case 'openWorkingFile':
          void openWorkingDiff(this, message.path);
          break;
        case 'checkout':
          void handleCheckout(this, message.branch);
          break;
        case 'loadChanges':
          void handleLoadChanges(this, message.branch);
          break;
        case 'switchStack':
          void handleSwitchStack(this, message.index);
          break;
        case 'checkoutRemoteStack':
          void handleCheckoutRemoteStack(this, message.pr);
          break;
        case 'newStack':
          void handleNewStack(this);
          break;
        case 'installGhStack':
          void handleInstallGhStack(this);
          break;
        case 'openGhPathSetting':
          void openGhPathSetting();
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
    this.context.subscriptions.push(this.watchWorkingTree());
  }

  post(message: HostMessage): void {
    void this.view?.webview.postMessage(message);
  }

  private handleReorder(order: string[]): void {
    if (!this.lastStack) {
      return;
    }
    const plan = computePlan(this.lastStack, order, this.lastCandidates);
    this.publishPlan(plan, order);
  }

  /**
   * Record the plan the panel renders from, before a run starts. Publishing it
   * late would let the progress arrive with no steps to attach itself to.
   */
  publishPlan(plan: Plan, order: string[]): void {
    this.lastPlan = plan;
    this.lastOrder = order;
    this.post({ type: 'plan', plan });
  }

  /**
   * Pick a branch to check out from the stack — the palette and status bar
   * route to the same place the view's per-row buttons post to.
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

    const picked = await pickBranch(stack);
    if (picked) {
      await handleCheckout(this, picked);
    }
  }

  /** Palette entry point: pick a stack rather than being handed one. */
  async switchStack(): Promise<void> {
    if (this.lastStacks.length === 0) {
      await this.refresh();
    }
    if (this.lastStacks.length === 0) {
      void vscode.window.showInformationMessage(
        'Restack: no stacks in this repository yet. Open the Restack view to create one.',
      );
      return;
    }

    const picked = await pickStack(this.lastStacks);
    if (picked !== undefined) {
      await handleSwitchStack(this, picked);
    }
  }

  /** Palette entry point for the toolbar's New stack button. */
  async newStack(): Promise<void> {
    if (!this.lastStack) {
      await this.refresh();
    }
    await handleNewStack(this);
  }

  /** Palette entry point: the view may never have loaded a stack. */
  async rebaseStack(): Promise<void> {
    if (!this.lastStack) {
      await this.refresh();
    }
    await handleRebaseStack(this);
  }

  /** Palette entry point: the view may never have loaded a stack. */
  async syncStack(): Promise<void> {
    if (!this.lastStack) {
      await this.refresh();
    }
    if (!this.lastStack) {
      void vscode.window.showInformationMessage('Restack: no stack here to sync.');
      return;
    }
    await handleSyncStack(this);
  }

  /** Palette entry point: pick a base rather than being handed one. */
  async changeBase(): Promise<void> {
    if (!this.lastStack) {
      await this.refresh();
    }
    const cwd = this.cwd();
    const stack = this.lastStack;
    if (!cwd || !stack) {
      void vscode.window.showInformationMessage('Restack: no stack here to re-base.');
      return;
    }

    const picked = await pickBase(cwd, stack);
    if (picked) {
      await handleChangeBase(this, picked.base, picked.isRemote);
    }
  }

  /** Palette entry point: the view may never have loaded a stack. */
  async removeStack(): Promise<void> {
    if (!this.lastStack) {
      await this.refresh();
    }
    await handleRemoveStack(this);
  }

  /** Palette entry point: the view may never have loaded a stack. */
  async pushSubmit(): Promise<void> {
    if (!this.lastStack) {
      await this.refresh();
    }
    await handlePushSubmit(this);
  }

  fetch(): Promise<void> {
    return fetchRemoteState(this);
  }

  /** Surface a thrown error as a notification instead of losing it in a promise. */
  async guard(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Restack: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  cwd(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  ghPath(): string {
    return vscode.workspace.getConfiguration('restack').get<string>('ghPath', 'gh');
  }

  /**
   * Ask GitHub what it knows, and remember it.
   *
   * The one network read outside git, and the only place `this.github` is
   * written. Two paths behind one call: the GraphQL read, which brings back
   * stacks as well as PRs, and the `gh pr list` read it falls back to on a
   * server that has never heard of `PullRequest.stack`. The fallback keeps the
   * PR badges Restack has always shown rather than letting a newer query take
   * a working feature down with it on GitHub Enterprise.
   *
   * Best-effort throughout: a failed call leaves the previous graph in place,
   * because stale badges beat a row that suddenly has none.
   */
  async loadGithub(cwd: string): Promise<void> {
    if (!this.readsRemoteStacks()) {
      return;
    }
    this.githubLoaded = true;

    const graph = await readGithubGraph(cwd, this.ghPath());
    if (!graph.supported) {
      this.log.appendLine(
        'This GitHub API does not expose PullRequest.stack; falling back to `gh pr list`. ' +
          'PR badges will show, stack badges will not.',
      );
      const prs = await readPullRequests(cwd, this.ghPath());
      this.github = { ...emptyGraph(), prs };
      return;
    }

    for (const number of graph.truncated) {
      this.log.appendLine(
        `GitHub stack ${number} has more pull requests than Restack asked for; ` +
          'its row lists the first 50.',
      );
    }
    this.github = graph;
  }

  /**
   * Say something when the tool Restack depends on is not there.
   *
   * The setup screen covers the user who opens the view; this covers the one
   * who does not. Without it a missing gh-stack looks like an extension that
   * silently does nothing — the status bar hides with no stack to report, so
   * there is nothing else on screen to notice.
   *
   * Deliberately quiet. Once per machine, and only inside a git repository:
   * opening an unrelated folder is not a moment to be told about a stacking
   * tool. The flag is cleared on the first successful read, so this speaks
   * again if gh-stack later goes away.
   */
  private async setupNotice(cwd: string, result: StackResult): Promise<void> {
    if (result.kind === 'ok') {
      // Guarded: refresh() runs on every `.git/HEAD` change, and an
      // unconditional write would be one per rebase step for no reason.
      if (this.context.globalState.get<boolean>(SETUP_NOTICE_KEY)) {
        void this.context.globalState.update(SETUP_NOTICE_KEY, undefined);
      }
      return;
    }
    if (result.kind !== 'gh-missing' && result.kind !== 'stack-missing') {
      return;
    }
    if (this.context.globalState.get<boolean>(SETUP_NOTICE_KEY)) {
      return;
    }
    if (!(await git(cwd, ['rev-parse', '--is-inside-work-tree'])).ok) {
      return;
    }

    void this.context.globalState.update(SETUP_NOTICE_KEY, true);

    // Not awaited: a modal-less notification can sit unanswered indefinitely,
    // and refresh() must not be held open behind one.
    const fix = result.kind === 'stack-missing' ? 'Install gh-stack' : 'Get the gh CLI';
    void vscode.window
      .showWarningMessage(`Restack: ${result.message}`, fix, 'Show Restack')
      .then((choice) => {
        if (choice === 'Install gh-stack') {
          return handleInstallGhStack(this);
        }
        if (choice === 'Get the gh CLI') {
          return vscode.env.openExternal(vscode.Uri.parse(GH_CLI_URL));
        }
        if (choice === 'Show Restack') {
          return vscode.commands.executeCommand('restack.stackView.focus');
        }
      });
  }

  /** The escape hatch for a repository where reaching GitHub is unwelcome. */
  private readsRemoteStacks(): boolean {
    return vscode.workspace.getConfiguration('restack').get<boolean>('readRemoteStacks', true);
  }

  async refresh(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      updateStatus(this.status, undefined, this.lastStacks);
      this.post({
        type: 'stack',
        result: { kind: 'error', message: 'Open a folder to read its stack.' },
        candidates: [],
        canPublish: false,
        stacks: [],
        remoteStacks: [],
        commitCounts: {},
      });
      return;
    }

    this.post({ type: 'loading' });
    const cwd = folder.uri.fsPath;
    let result: StackResult = await readStack(cwd, this.ghPath());
    this.lastStack = result.kind === 'ok' ? result.stack : undefined;
    // Local ref reads only — no network — so this is safe on the .git/HEAD
    // watcher path, which fires on every checkout and every rebase step.
    this.lastRemote = this.lastStack ? await readRemoteState(cwd, this.lastStack) : undefined;
    // One `for-each-ref` for every branch head, and the working tree, together
    // — then the per-branch counts, which need the tips and are memoised on
    // `<base>..<tip>`. A refresh where nothing moved therefore spawns two
    // processes here in total, not one per branch.
    [this.lastTips, this.lastWorkingTree] = await Promise.all([
      readTips(cwd),
      this.changesReader.workingTree(cwd),
    ]);
    const stackBranches = this.lastStack?.branches ?? [];
    this.lastCounts = await this.changesReader.commitCounts(
      cwd,
      stackBranches.map((b) => ({ name: b.name, base: b.base })),
      this.lastTips,
    );
    // Anything cached for a branch that has left the stack is dead weight now.
    this.changesReader.prune(stackBranches.map((b) => b.name));
    // The plan described the pre-refresh order; holding on to it would let a
    // later apply run stale commands.
    this.lastPlan = undefined;
    this.lastOrder = undefined;

    // Every stack in the repository, not just the one HEAD is in — the
    // switcher renders the same list from inside a stack and from outside one.
    // Reads `.git/gh-stack` plus local refs; the PR badges come from the cache,
    // so this stays free of network calls on the .git/HEAD watcher path.
    this.lastStacks = await readStackSummaries(
      cwd,
      this.lastStack?.branches.map((b) => b.name) ?? [],
      this.github,
    );
    // Stacks GitHub has and this clone does not. Derived from the same cached
    // graph, so this stays as free as the summaries above.
    this.lastRemoteStacks = remoteOnlyStacks(this.github, this.lastStacks);
    // Late, because it reads lastStacks for the "stack N of M" suffix.
    updateStatus(this.status, this.lastStack, this.lastStacks);

    // Branches already in *some* stack are excluded from the tray, not just the
    // ones in this stack: dropping another stack's branch into this one would
    // put it in two, which is the ambiguity gh-stack refuses with `branch %q
    // belongs to multiple stacks`. With no stack to read, the view still needs
    // branches to offer and a trunk to base them on.
    const claimed = new Set(this.lastStacks.flatMap((s) => s.branches));
    let candidates: CandidateBranch[] = [];
    if (this.lastStack) {
      candidates = await readBranchCandidates(cwd, this.lastStack.trunk, claimed);
    } else if (result.kind === 'no-stack') {
      const { trunk, localBranches, remoteBranches } = await detectTrunk(cwd);
      candidates = await readBranchCandidates(cwd, trunk, claimed);
      result = { ...result, trunk, localBranches, remoteBranches };
    }
    this.lastCandidates = candidates;

    this.post({
      type: 'stack',
      result,
      candidates,
      canPublish: await hasOrigin(cwd),
      remote: this.lastRemote,
      stacks: this.lastStacks,
      remoteStacks: this.lastRemoteStacks,
      commitCounts: this.lastCounts,
      workingTree: this.lastWorkingTree,
    });

    // After the post, like the GitHub read below: the setup screen is the
    // useful half of this, and it should not wait on a `rev-parse`.
    void this.setupNotice(cwd, result);

    // The first read of GitHub, once — deliberately after the post above, and
    // deliberately not awaited. Everything up to here is local, so the view is
    // already on screen; making it wait on a network round trip would put a
    // spinner in front of information that does not need one. Later refreshes
    // reuse the cache, which is what keeps the `.git/HEAD` watcher path free of
    // the network.
    //
    // The flag is set inside loadGithub rather than here, so turning
    // `readRemoteStacks` on mid-session is picked up by the next refresh
    // instead of needing a window reload.
    if (!this.githubLoaded && this.readsRemoteStacks()) {
      void this.guard(async () => {
        await this.loadGithub(cwd);
        if (this.github.prs.size > 0 || this.github.stacks.size > 0) {
          await this.refresh();
        }
      });
    }
  }
}
