import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { basesForOrder, rewriteMetadata } from './metadata.ts';
import { publishSteps } from './plan.ts';
import type { ApplyProgress, ApplyScope, Plan, PlanStep, Stack } from './model.ts';

const execFileAsync = promisify(execFile);

/**
 * Every child process runs with editors disabled. `git rebase --continue` opens
 * $EDITOR to confirm the commit message; from an extension host there is no
 * terminal attached, so it would block forever on a pipe nobody reads.
 * GIT_TERMINAL_PROMPT stops a credential prompt doing the same during push.
 */
const CHILD_ENV = {
  ...process.env,
  GIT_EDITOR: 'true',
  GIT_SEQUENCE_EDITOR: 'true',
  GIT_TERMINAL_PROMPT: '0',
};

const LOCAL_TIMEOUT_MS = 60_000;
/** Push and submit go over the network. */
const REMOTE_TIMEOUT_MS = 180_000;

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface ExecError extends Error {
  code?: number | string;
  stdout?: string;
  stderr?: string;
}

/**
 * Sink for the full command log. Set by ApplyRunner so the module-level `run`
 * can report every child process without every call site threading a logger
 * through. The UI only ever shows the first stderr line; the rest lands here.
 */
let logSink: ((line: string) => void) | undefined;

/**
 * Run a child process, mapping every failure to a code. Never rejects.
 *
 * Exported as `runCommand` for init.ts, so commands Restack runs outside an
 * apply session still land in the same output channel. A second exec path
 * would be a second thing to keep logging.
 */
async function run(
  file: string,
  args: string[],
  cwd: string,
  timeout = LOCAL_TIMEOUT_MS,
): Promise<RunResult> {
  const started = Date.now();
  const result = await execute(file, args, cwd, timeout);

  if (logSink) {
    const ms = Date.now() - started;
    logSink(`$ ${file} ${args.join(' ')}  (exit ${result.code}, ${ms}ms)`);
    for (const stream of [result.stdout, result.stderr]) {
      const text = stream.trim();
      if (text) {
        logSink(text.split('\n').map((l) => `    ${l}`).join('\n'));
      }
    }
  }

  return result;
}

async function execute(
  file: string,
  args: string[],
  cwd: string,
  timeout: number,
): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      cwd,
      env: CHILD_ENV,
      timeout,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as ExecError;
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message ?? '',
    };
  }
}

function firstLine(text: string): string {
  return text.trim().split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
}

/**
 * Snapshot taken before the first rebase, and the sole basis for undo.
 *
 * Branch SHAs alone are not enough: the metadata write has to be reversible
 * too, or an undo would leave gh-stack describing an order the refs no longer
 * have — the exact corruption this whole module exists to avoid.
 */
interface Snapshot {
  /** Branch name -> SHA before any rebase ran. */
  refs: Map<string, string>;
  /** Branch checked out when apply started, restored when it finishes. */
  branch?: string;
  /** Verbatim bytes of .git/gh-stack. */
  metadata: string;
  metadataPath: string;
}

interface Session {
  cwd: string;
  ghPath: string;
  stack: Stack;
  plan: Plan;
  order: string[];
  snapshot: Snapshot;
  /** Index of the next step to run. */
  cursor: number;
  statuses: ApplyProgress['statuses'];
  scope: ApplyScope;
  localComplete: boolean;
  /** Cleared once anything has been pushed — undo cannot reach the remote. */
  canUndo: boolean;
  /**
   * The last progress emitted. A webview that reloads mid-apply comes back with
   * no idea a session is running, so it has to be told again — otherwise the
   * panel that owns Continue / Abort / Dismiss never renders and the session
   * can only be escaped by restarting the window.
   */
  lastProgress?: ApplyProgress;
}

/**
 * A session flattened for `workspaceState`, so a *window* reload no longer
 * strands the repository mid-plan with no route to Undo. Everything here is
 * plain JSON; the only lossy field is `snapshot.refs`, a Map written as pairs.
 */
export interface PersistedSession {
  cwd: string;
  ghPath: string;
  stack: Stack;
  plan: Plan;
  order: string[];
  refs: Array<[string, string]>;
  branch?: string;
  metadata: string;
  metadataPath: string;
  cursor: number;
  statuses: ApplyProgress['statuses'];
  scope: ApplyScope;
  localComplete: boolean;
  canUndo: boolean;
  lastProgress?: ApplyProgress;
}

function serialize(session: Session): PersistedSession {
  return {
    cwd: session.cwd,
    ghPath: session.ghPath,
    stack: session.stack,
    plan: session.plan,
    order: session.order,
    refs: [...session.snapshot.refs],
    branch: session.snapshot.branch,
    metadata: session.snapshot.metadata,
    metadataPath: session.snapshot.metadataPath,
    cursor: session.cursor,
    statuses: session.statuses,
    scope: session.scope,
    localComplete: session.localComplete,
    canUndo: session.canUndo,
    lastProgress: session.lastProgress,
  };
}

export class ApplyError extends Error {}

/** Resolve `.git`, honouring worktrees and `.git`-as-a-file. */
async function gitCommonDir(cwd: string): Promise<string> {
  const result = await run('git', ['rev-parse', '--git-common-dir'], cwd);
  if (result.code !== 0) {
    throw new ApplyError('Not a git repository.');
  }
  const dir = result.stdout.trim();
  return isAbsolute(dir) ? dir : join(cwd, dir);
}

async function rebaseInProgress(cwd: string): Promise<boolean> {
  const gitDir = await gitCommonDir(cwd);
  // A worktree mid-rebase keeps these in its private dir, not the common one.
  const priv = await run('git', ['rev-parse', '--absolute-git-dir'], cwd);
  const dirs = [gitDir, priv.code === 0 ? priv.stdout.trim() : gitDir];
  return dirs.some((d) => existsSync(join(d, 'rebase-merge')) || existsSync(join(d, 'rebase-apply')));
}

async function unmergedFiles(cwd: string): Promise<string[]> {
  const result = await run('git', ['diff', '--name-only', '--diff-filter=U'], cwd);
  return result.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

async function revParse(cwd: string, ref: string): Promise<string | undefined> {
  const result = await run('git', ['rev-parse', '--verify', `${ref}^{commit}`], cwd);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

export { run as runCommand, firstLine, gitCommonDir };

/**
 * Whether there is anywhere to push. Checked before the confirmation modal so
 * a remote-less repository is never offered "Apply & Publish" — being refused
 * after choosing it costs the user the local reorder too, since preflight
 * blocks the whole apply rather than silently downgrading the scope.
 */
export async function hasOrigin(cwd: string): Promise<boolean> {
  const remote = await run('git', ['remote', 'get-url', 'origin'], cwd);
  return remote.code === 0;
}

/**
 * Refuse to start unless the repository is in a state where every step is
 * recoverable. A rebase over a dirty tree is the fastest way to lose work that
 * was never committed, and no snapshot can bring that back.
 */
export async function preflight(
  cwd: string,
  stack: Stack,
  scope: ApplyScope,
  order: string[] = stack.branches.map((b) => b.name),
): Promise<string | undefined> {
  const repo = await run('git', ['rev-parse', '--is-inside-work-tree'], cwd);
  if (repo.code !== 0) {
    return 'Not a git repository.';
  }

  const status = await run('git', ['status', '--porcelain', '--untracked-files=no'], cwd);
  if (status.stdout.trim().length > 0) {
    return 'Working tree has uncommitted changes. Commit or stash them first — a rebase over a dirty tree can lose work Restack cannot restore.';
  }

  if (await rebaseInProgress(cwd)) {
    return 'A rebase is already in progress. Finish or abort it first (`git rebase --abort`).';
  }

  const merged = stack.branches.filter((b) => b.isMerged).map((b) => b.name);
  if (merged.length > 0) {
    return `Stack contains merged branches (${merged.join(', ')}). gh-stack rejects reordering around them.`;
  }

  // Branches joining the stack are not in `stack.branches`, so nothing has
  // checked they exist or share history with trunk. A missing ref would fail
  // mid-cascade, after earlier branches had already been rewritten.
  for (const name of order) {
    if (!(await revParse(cwd, name))) {
      return `Branch ${name} does not exist locally.`;
    }
    const shared = await run('git', ['merge-base', name, stack.trunk], cwd);
    if (shared.code !== 0) {
      return `Branch ${name} shares no history with ${stack.trunk}, so it cannot be rebased onto the stack.`;
    }
  }

  const gitDir = await gitCommonDir(cwd);
  if (!existsSync(join(gitDir, 'gh-stack'))) {
    return 'No .git/gh-stack file. Restack cannot update gh-stack’s state, and rebasing without it would leave the stack describing the old order.';
  }

  if (scope === 'publish' && !(await hasOrigin(cwd))) {
    return 'No `origin` remote to push to.';
  }

  return undefined;
}

/**
 * Drives one reorder from start to finish, surviving conflicts in between.
 *
 * The state lives here rather than in the webview because a conflict pauses
 * mid-plan for as long as the user needs to resolve it — possibly across
 * panel hides and reopens, which throw away webview state.
 */
export interface RunnerOptions {
  /**
   * Persist the session so it survives a window reload, or `undefined` once it
   * ends. Kept as a callback because this module must stay free of `vscode` —
   * test/apply.test.ts imports it directly under `node --test`.
   */
  persist?: (state: PersistedSession | undefined) => void;
  /** Full command log: file, argv, exit code, and both output streams. */
  log?: (line: string) => void;
}

export class ApplyRunner {
  private session?: Session;
  /**
   * Written out longhand rather than as a constructor parameter property:
   * `node --test --experimental-strip-types` runs this file directly and
   * strip-only mode cannot desugar those.
   */
  private readonly emit: (progress: ApplyProgress) => void;
  private readonly options: RunnerOptions;

  constructor(emit: (progress: ApplyProgress) => void, options: RunnerOptions = {}) {
    this.emit = emit;
    this.options = options;
    if (options.log) {
      logSink = options.log;
    }
  }

  get active(): boolean {
    return this.session !== undefined;
  }

  /** Progress to replay to a webview that reconnected mid-apply. */
  get current(): ApplyProgress | undefined {
    return this.session?.lastProgress;
  }

  /** The plan that progress refers to, so replayed steps have labels. */
  get currentPlan(): Plan | undefined {
    return this.session?.plan;
  }

  /** Snapshot, then run rebases and the metadata write. Stops before push. */
  async start(
    cwd: string,
    ghPath: string,
    stack: Stack,
    plan: Plan,
    order: string[],
    scope: ApplyScope,
  ): Promise<void> {
    if (this.session) {
      throw new ApplyError(
        'An apply is already in progress. Finish it, or use Abort / Dismiss in the plan panel.',
      );
    }

    const gitDir = await gitCommonDir(cwd);
    const metadataPath = join(gitDir, 'gh-stack');

    // Snapshot the union of what is in the stack and what is being applied.
    // A branch joining the stack is absent from `stack.branches` but is about
    // to be rewritten, so without it here Undo could not put it back.
    const refs = new Map<string, string>();
    for (const name of new Set([...stack.branches.map((b) => b.name), ...order])) {
      const sha = await revParse(cwd, name);
      if (!sha) {
        throw new ApplyError(`Branch ${name} does not exist locally.`);
      }
      refs.set(name, sha);
    }

    const head = await run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd);

    this.session = {
      cwd,
      ghPath,
      stack,
      plan,
      order,
      snapshot: {
        refs,
        branch: head.code === 0 ? head.stdout.trim() : undefined,
        metadata: await readFile(metadataPath, 'utf8'),
        metadataPath,
      },
      cursor: 0,
      statuses: plan.steps.map(() => 'pending' as const),
      scope,
      localComplete: false,
      canUndo: true,
    };

    await this.drive();
  }

  /** Resume after the user resolved a conflict in the editor. */
  async resume(): Promise<void> {
    const session = this.require();

    if (!(await rebaseInProgress(session.cwd))) {
      // Resolved and continued outside Restack. Treat the paused step as done.
      session.statuses[session.cursor] = 'done';
      session.cursor += 1;
      await this.drive();
      return;
    }

    const unmerged = await unmergedFiles(session.cwd);
    if (unmerged.length > 0) {
      this.publishProgress({
        phase: 'conflict',
        message: `Still unresolved: ${unmerged.join(', ')}. Stage the fixes (\`git add\`), then continue.`,
        conflictFiles: unmerged,
        conflictBranch: session.plan.steps[session.cursor]?.branch,
      });
      return;
    }

    const result = await run('git', ['rebase', '--continue'], session.cwd);
    if (result.code !== 0) {
      await this.reportRebaseFailure(result);
      return;
    }

    session.statuses[session.cursor] = 'done';
    session.cursor += 1;
    await this.drive();
  }

  /**
   * Push and submit with no reorder in front of them.
   *
   * Opens a session over a synthetic two-step plan so the existing progress,
   * step-status, and failure rendering all apply unchanged. The snapshot is
   * empty and `canUndo` is false: nothing local was rewritten, and nothing
   * pushed can be taken back.
   */
  async publishOnly(cwd: string, ghPath: string, stack: Stack): Promise<void> {
    if (this.session) {
      throw new ApplyError(
        'An apply is already in progress. Finish it, or use Abort / Dismiss in the plan panel.',
      );
    }

    const steps = publishSteps();
    const order = stack.branches.map((b) => b.name);
    const head = await run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd);

    this.session = {
      cwd,
      ghPath,
      stack,
      plan: {
        steps,
        proposedOrder: order,
        isNoop: false,
        mergedBranches: [],
        insertedBranches: [],
        removedBranches: [],
      },
      order,
      snapshot: {
        refs: new Map(),
        branch: head.code === 0 ? head.stdout.trim() : undefined,
        metadata: '',
        metadataPath: '',
      },
      cursor: 0,
      statuses: steps.map(() => 'pending' as const),
      scope: 'publish',
      localComplete: true,
      canUndo: false,
    };

    await this.drive();
  }

  /** Adopt a session persisted before a window reload. */
  restore(state: PersistedSession): void {
    this.session = {
      cwd: state.cwd,
      ghPath: state.ghPath,
      stack: state.stack,
      plan: state.plan,
      order: state.order,
      snapshot: {
        refs: new Map(state.refs),
        branch: state.branch,
        metadata: state.metadata,
        metadataPath: state.metadataPath,
      },
      cursor: state.cursor,
      statuses: state.statuses,
      scope: state.scope,
      localComplete: state.localComplete,
      canUndo: state.canUndo,
      lastProgress: state.lastProgress,
    };
  }

  /** Roll every branch back to its pre-apply SHA and restore the metadata. */
  async abort(): Promise<void> {
    const session = this.require();
    const { cwd, snapshot } = session;

    // A publish-only session rewrote nothing locally, so there is nothing to
    // restore — and its empty metadataPath must not be written to.
    if (snapshot.refs.size === 0 && !snapshot.metadataPath) {
      this.publishProgress({ phase: 'failed', message: 'Nothing to roll back.' });
      this.clear();
      return;
    }

    if (await rebaseInProgress(cwd)) {
      await run('git', ['rebase', '--abort'], cwd);
    }

    // Detach first: update-ref refuses to move the branch HEAD points at.
    await run('git', ['checkout', '--detach', '--quiet'], cwd);
    for (const [branch, sha] of snapshot.refs) {
      await run('git', ['update-ref', `refs/heads/${branch}`, sha], cwd);
    }
    await writeFile(snapshot.metadataPath, snapshot.metadata, 'utf8');

    if (snapshot.branch) {
      await run('git', ['checkout', '--force', '--quiet', snapshot.branch], cwd);
    }

    this.publishProgress({ phase: 'failed', message: 'Rolled back. Every branch is back where it started.' });
    this.clear();
  }

  /** Push and submit, once the local reorder has landed. */
  async publish(): Promise<void> {
    const session = this.require();
    if (!session.localComplete) {
      throw new ApplyError('Apply the local reorder before publishing.');
    }
    session.scope = 'publish';
    await this.drive();
  }

  /** Drop the session without touching the repository. */
  dismiss(): void {
    this.clear();
  }

  /** End the session and drop the persisted copy along with it. */
  private clear(): void {
    this.session = undefined;
    this.options.persist?.(undefined);
  }

  private require(): Session {
    if (!this.session) {
      throw new ApplyError('No apply in progress.');
    }
    return this.session;
  }

  /** Run steps from the cursor until the scope ends, a conflict, or a failure. */
  private async drive(): Promise<void> {
    const session = this.require();

    while (session.cursor < session.plan.steps.length) {
      const step = session.plan.steps[session.cursor];
      const remote = step.kind === 'push' || step.kind === 'submit';

      if (remote && session.scope === 'local') {
        // Local scope stops here; the UI offers publish as a separate action.
        break;
      }

      session.statuses[session.cursor] = 'running';
      this.publishProgress({ phase: 'running' });

      const failure = await this.runStep(session, step);
      if (failure) {
        return;
      }

      session.statuses[session.cursor] = 'done';
      if (step.kind === 'metadata') {
        session.localComplete = true;
      }
      if (step.kind === 'push') {
        // Remote history has moved; a local ref reset can no longer undo this.
        session.canUndo = false;
      }
      session.cursor += 1;
    }

    await this.finish(session);
  }

  /** Returns true when the step failed and progress has already been emitted. */
  private async runStep(session: Session, step: PlanStep): Promise<boolean> {
    if (step.kind === 'metadata') {
      try {
        await this.writeMetadata(session);
      } catch (err) {
        session.statuses[session.cursor] = 'failed';
        this.publishProgress({
          phase: 'failed',
          message: err instanceof Error ? err.message : 'Failed to update .git/gh-stack.',
        });
        return true;
      }
      return false;
    }

    if (!step.exec) {
      return false;
    }

    const file = step.exec.file === 'gh' ? session.ghPath : 'git';
    const timeout = step.kind === 'rebase' ? LOCAL_TIMEOUT_MS : REMOTE_TIMEOUT_MS;
    const result = await run(file, step.exec.args, session.cwd, timeout);

    if (result.code === 0) {
      return false;
    }

    if (step.kind === 'rebase') {
      await this.reportRebaseFailure(result);
      return true;
    }

    session.statuses[session.cursor] = 'failed';
    this.publishProgress({
      phase: 'failed',
      message: firstLine(result.stderr) || firstLine(result.stdout) || `${step.command} failed.`,
    });
    return true;
  }

  /**
   * A non-zero rebase means one of two very different things: it stopped on a
   * conflict and left the repository mid-rebase (recoverable — the user
   * resolves and continues), or it refused outright (not recoverable in place).
   * The rebase directory is what tells them apart.
   */
  private async reportRebaseFailure(result: RunResult): Promise<void> {
    const session = this.require();
    const step = session.plan.steps[session.cursor];

    if (await rebaseInProgress(session.cwd)) {
      const files = await unmergedFiles(session.cwd);
      session.statuses[session.cursor] = 'running';
      this.publishProgress({
        phase: 'conflict',
        conflictBranch: step?.branch,
        conflictFiles: files,
        message: files.length
          ? `Conflict on ${step?.branch ?? 'a branch'}. Resolve the files below, stage them, then continue.`
          : `Rebase of ${step?.branch ?? 'a branch'} paused. Resolve, stage, then continue.`,
      });
      return;
    }

    session.statuses[session.cursor] = 'failed';
    this.publishProgress({
      phase: 'failed',
      message: firstLine(result.stderr) || firstLine(result.stdout) || 'Rebase failed.',
    });
  }

  private async writeMetadata(session: Session): Promise<void> {
    const { cwd, order, stack, snapshot } = session;

    const trunkHead = await revParse(cwd, stack.trunk);
    if (!trunkHead) {
      throw new ApplyError(`Could not resolve trunk ${stack.trunk}.`);
    }

    // Resolve every tip *after* the rebases, so recorded bases match reality.
    const tips = new Map<string, string>();
    for (const branch of order) {
      const sha = await revParse(cwd, branch);
      if (!sha) {
        throw new ApplyError(`Could not resolve ${branch} after rebasing.`);
      }
      tips.set(branch, sha);
    }

    const raw = await readFile(snapshot.metadataPath, 'utf8');
    const next = rewriteMetadata(raw, {
      trunk: stack.trunk,
      trunkHead,
      branches: basesForOrder(order, trunkHead, (b) => tips.get(b)),
      // Find the stack by the names still on disk. With a branch joining or
      // leaving, the written set no longer matches what gh-stack recorded.
      match: stack.branches.map((b) => b.name),
    });
    await writeFile(snapshot.metadataPath, next, 'utf8');
  }

  private async finish(session: Session): Promise<void> {
    // Rebasing checks out each branch in turn; put the user back where they were.
    if (session.snapshot.branch) {
      await run('git', ['checkout', '--quiet', session.snapshot.branch], session.cwd);
    }

    const published = session.statuses.some(
      (s, i) => s === 'done' && session.plan.steps[i].kind === 'submit',
    );

    for (let i = 0; i < session.statuses.length; i += 1) {
      if (session.statuses[i] === 'pending') {
        session.statuses[i] = 'skipped';
      }
    }

    this.publishProgress({
      phase: 'done',
      message: published
        ? 'Stack reordered and published.'
        : 'Reorder applied locally. Nothing has been pushed.',
    });

    if (published) {
      this.clear();
    }
  }

  private publishProgress(patch: Partial<ApplyProgress> & { phase: ApplyProgress['phase'] }): void {
    const session = this.require();
    const progress: ApplyProgress = {
      scope: session.scope,
      stepIndex: session.cursor,
      statuses: [...session.statuses],
      localComplete: session.localComplete,
      canUndo: session.canUndo,
      ...patch,
    };
    session.lastProgress = progress;
    // Persist before emitting: if the host dies rendering this, the state on
    // disk is still the newer of the two.
    this.options.persist?.(serialize(session));
    this.emit(progress);
  }
}
