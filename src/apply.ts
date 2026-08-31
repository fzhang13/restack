import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ApplyError,
  LOCAL_TIMEOUT_MS,
  REMOTE_TIMEOUT_MS,
  firstLine,
  gitCommonDir,
  hasOrigin,
  run,
  setLogSink,
  type RunResult,
} from './git.ts';
import { PARKED_REF, type AmendTarget } from './amend.ts';
import { basesForOrder, rewriteMetadata } from './metadata.ts';
import { linkableBranches, publishSteps } from './plan.ts';
import { branchesBehind, readAllTracking } from './remote.ts';
import type { ApplyProgress, ApplyScope, Plan, PlanStep, Stack } from './model.ts';

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
   * Commit sha of a stash taken to clear the tree before this apply, if any.
   *
   * Held for the whole session rather than popped after the first rebase: a
   * conflict pauses the plan for as long as the user needs, and a stash popped
   * into a half-rebased tree is exactly the mess the dirty-tree refusal exists
   * to prevent. It is a sha and not `stash@{0}` because the user has a
   * terminal — see stash.ts.
   */
  stash?: string;
  /** Set once the stash has been dealt with, so no path pops it twice. */
  stashSettled?: boolean;
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
  /** See Session.stash. Persisted so a window reload cannot orphan it. */
  stash?: string;
  stashSettled?: boolean;
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
    stash: session.stash,
    stashSettled: session.stashSettled,
    lastProgress: session.lastProgress,
  };
}

async function rebaseInProgress(cwd: string): Promise<boolean> {
  const gitDir = await gitCommonDir(cwd);
  // A worktree mid-rebase keeps these in its private dir, not the common one.
  const priv = await run('git', ['rev-parse', '--absolute-git-dir'], cwd);
  const dirs = [gitDir, priv.code === 0 ? priv.stdout.trim() : gitDir];
  return dirs.some((d) => existsSync(join(d, 'rebase-merge')) || existsSync(join(d, 'rebase-apply')));
}

/**
 * A cherry-pick that stopped on a conflict.
 *
 * Keyed on `CHERRY_PICK_HEAD`, not on `.git/sequencer/`: verified against git
 * 2.50.1, a single-commit pick leaves no sequencer directory at all, so the
 * check `rebaseInProgress` uses would miss it entirely. Same two-directory
 * search as that function, for the same reason — a worktree mid-pick keeps this
 * in its private git dir.
 */
async function cherryPickInProgress(cwd: string): Promise<boolean> {
  const gitDir = await gitCommonDir(cwd);
  const priv = await run('git', ['rev-parse', '--absolute-git-dir'], cwd);
  const dirs = [gitDir, priv.code === 0 ? priv.stdout.trim() : gitDir];
  return dirs.some((d) => existsSync(join(d, 'CHERRY_PICK_HEAD')));
}

/** Either sequencer holding the repository open, mid-operation. */
async function sequencerInProgress(cwd: string): Promise<boolean> {
  return (await rebaseInProgress(cwd)) || (await cherryPickInProgress(cwd));
}

async function unmergedFiles(cwd: string): Promise<string[]> {
  const result = await run('git', ['diff', '--name-only', '--diff-filter=U'], cwd);
  return result.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

async function revParse(cwd: string, ref: string): Promise<string | undefined> {
  const result = await run('git', ['rev-parse', '--verify', `${ref}^{commit}`], cwd);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

// Re-exported rather than moved-and-forgotten: init.ts, extension.ts, and the
// tests all reach for these here, and git.ts is an implementation detail of
// where the subprocess actually happens.
export { run as runCommand, firstLine, gitCommonDir, hasOrigin, ApplyError } from './git.ts';
export type { RunResult } from './git.ts';
export { rebaseInProgress, cherryPickInProgress, sequencerInProgress, unmergedFiles };

/**
 * Steps that stay on this machine. Everything not in here reaches GitHub, which
 * is what `drive()` stops at for a `local` scope and what gets the longer
 * timeout.
 */
const LOCAL_KINDS = new Set<PlanStep['kind']>([
  'rebase',
  'metadata',
  'trunk',
  'stage',
  'commit',
  'ref',
  'checkout',
  'pick',
  'autosquash',
]);

/** The two that can stop half-done and be resumed rather than simply failing. */
const RESUMABLE_KINDS = new Set<PlanStep['kind']>(['rebase', 'pick', 'autosquash']);

/**
 * gh-stack reports a stack it could not create or update as a *warning* and
 * still exits 0. Verified against v0.1.0: `runSubmit` reaches `createNewStack`
 * through `syncStack` -> `updateStack`, and both report through
 * `config.Warningf` on a path that leaves the exit code alone. So a submit
 * that opens every pull request and links none of them is, by exit code,
 * indistinguishable from one that worked — which is how a stack ends up on
 * GitHub as a row of unrelated PRs while the panel says it was published.
 *
 * Matching another tool's prose is a liability and this is deliberately only a
 * safety net; the `link` step is what actually creates the stack. So it is
 * scoped to the two steps that can print these, and kept to the explicit
 * failure wordings — a phrasing change costs a missed warning, never a false
 * failure on a publish that worked. "Skipping stack recreation" is left out on
 * purpose: it is also printed when there is legitimately nothing to recreate.
 */
const STACK_NOT_LINKED = /^[^\n]*\b(?:could not|cannot|failed to) (?:create|update) stack\b[^\n]*/im;

export function stackWarning(step: PlanStep, result: RunResult): string | undefined {
  if (step.kind !== 'submit' && step.kind !== 'link') {
    return undefined;
  }
  const match = STACK_NOT_LINKED.exec(`${result.stdout}\n${result.stderr}`);
  return match ? match[0].trim() : undefined;
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

  // The clobber case. `gh stack push` uses --force-with-lease, which compares
  // against the remote-tracking ref — so a branch that is behind means someone
  // pushed commits we have not fetched, the stale ref satisfies the lease, and
  // their work is overwritten with no warning. Rewriting first would make that
  // certain, so it is refused here rather than survived later.
  //
  // Local ref reads only, so this stays a preflight and not a network call.
  const behind = branchesBehind(await readAllTracking(cwd), order);
  if (behind.length > 0) {
    const list = behind
      .map((t) => `${t.branch} is ${t.behind} behind ${t.upstream ?? 'its upstream'}`)
      .join('; ');
    return (
      `${list}. Fetch and sync before rewriting — \`gh stack push\` force-pushes ` +
      `with a lease against a stale remote ref, which would drop those commits.`
    );
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
 * The amend counterpart to `preflight`. Same contract: a string refuses.
 *
 * It inverts exactly one of the reorder rules — the clean-tree refusal, since a
 * dirty tree is the whole input to an amend — and narrows a second. Everything
 * else is kept, and the behind-upstream rule matters *more* here rather than
 * less: `gh stack push` force-pushes with a lease against a stale remote ref.
 */
export async function amendPreflight(
  cwd: string,
  stack: Stack,
  target: AmendTarget,
  scope: ApplyScope,
  options: { message?: string },
): Promise<string | undefined> {
  const repo = await run('git', ['rev-parse', '--is-inside-work-tree'], cwd);
  if (repo.code !== 0) {
    return 'Not a git repository.';
  }

  if (await sequencerInProgress(cwd)) {
    return 'A rebase or cherry-pick is already in progress. Finish or abort it first.';
  }

  const staged = await run('git', ['diff', '--cached', '--name-only'], cwd);
  const unstaged = await run('git', ['diff', '--name-only'], cwd);
  const hasStaged = staged.stdout.trim().length > 0;
  const hasUnstaged = unstaged.stdout.trim().length > 0;

  if (!hasStaged && !hasUnstaged && options.message === undefined) {
    return 'Nothing to fold in. Stage a change, or edit the message, first.';
  }

  // Restack folds what is staged, and the rebase that follows needs a clean
  // tree — leftover unstaged changes would fail it mid-cascade, with branches
  // already rewritten. Refused up front, naming both fixes.
  if (hasStaged && hasUnstaged) {
    return (
      'The working tree is both staged and unstaged. Restack folds in what is staged, ' +
      'and the rebase that follows needs a clean tree — stage the rest, or stash it.'
    );
  }

  // Merged branches, precisely. The blanket rule in `preflight()` exists
  // because gh-stack rejects reordering around a merged branch; an amend does
  // not reorder, and branches *below* the target are never rewritten. The
  // distinction matters: a merged bottom branch with live work above it is the
  // single most common state a stack is in, and the blanket rule would make
  // amend useless there.
  const names = stack.branches.map((b) => b.name);
  const from = names.indexOf(target.branch);
  if (from < 0) {
    return `Branch ${target.branch} is not part of this stack.`;
  }
  const mergedAbove = stack.branches
    .slice(from)
    .filter((b) => b.isMerged)
    .map((b) => b.name);
  if (mergedAbove.length > 0) {
    return `${mergedAbove.join(', ')} ${mergedAbove.length === 1 ? 'is' : 'are'} already merged, and amending would rewrite ${mergedAbove.length === 1 ? 'it' : 'them'}.`;
  }

  const behind = branchesBehind(await readAllTracking(cwd), names.slice(from));
  if (behind.length > 0) {
    const list = behind
      .map((t) => `${t.branch} is ${t.behind} behind ${t.upstream ?? 'its upstream'}`)
      .join('; ');
    return (
      `${list}. Fetch and sync before rewriting — \`gh stack push\` force-pushes ` +
      `with a lease against a stale remote ref, which would drop those commits.`
    );
  }

  // `amend!` is matched by subject, so a duplicated subject in the range being
  // autosquashed would silently fold the reword into the wrong commit. Only
  // rewords are affected — `--fixup=<sha>` names its target outright.
  if (options.message !== undefined) {
    const base = stack.branches[from].base;
    const same = await run('git', ['log', '--format=%s', `${base}..${target.branch}`], cwd);
    const matches = same.stdout
      .split('\n')
      .filter((line) => line.trim() === target.subject.trim()).length;
    if (matches > 1) {
      return (
        `More than one commit on ${target.branch} has the subject “${target.subject}”. ` +
        'Autosquash matches a reword by subject, so it cannot tell them apart. ' +
        'Reword one of them from a terminal first.'
      );
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
  /**
   * Put back the stash taken before this apply, and tell the user how it went.
   *
   * A callback for the same reason `persist` is one: restoring is a git
   * operation this module could do itself, but reporting a conflicted pop is a
   * notification, and notifications are `vscode`. Absent in tests, where the
   * assertion is that the sha reached the terminal path at all.
   */
  restoreStash?: (cwd: string, sha: string) => Promise<void>;
  /**
   * Say where a stash was left, for the one path that deliberately keeps it.
   * See dismiss().
   */
  reportStash?: (cwd: string, sha: string) => Promise<void>;
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
      setLogSink(options.log);
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
    /** Sha of a stash the caller took to clear the tree. See Session.stash. */
    stash?: string,
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
      stash,
    };

    await this.drive();
  }

  /**
   * Re-read the index and re-emit the paused state, without advancing the plan.
   *
   * Called whenever `.git/index` changes while a conflict is open, so staging a
   * file — from the merge editor, the SCM view, or a terminal, indifferently —
   * shows up in the panel instead of only being discovered when Continue is
   * pressed. A no-op unless a conflict is actually open, since the index moves
   * constantly for reasons that are none of this session's business.
   */
  async refreshConflict(): Promise<void> {
    const session = this.session;
    if (!session || session.lastProgress?.phase !== 'conflict') {
      return;
    }
    // The sequencer ending underneath us — someone ran `git rebase --continue`
    // themselves — is resume()'s case to handle, not a state to re-render.
    if (!(await sequencerInProgress(session.cwd))) {
      return;
    }
    this.emitConflict(session, await unmergedFiles(session.cwd));
  }

  /**
   * Emit the paused state with a fresh view of what is left to resolve.
   *
   * `conflictFiles` is whatever the pause first reported, carried forward
   * unchanged so the panel keeps listing files that have already been staged;
   * `unresolvedFiles` is the part that moves. See the note in model.ts.
   */
  private emitConflict(
    session: Session,
    unresolved: string[],
    options: { initial?: string[]; refused?: boolean } = {},
  ): void {
    const conflictFiles = options.initial ?? session.lastProgress?.conflictFiles ?? unresolved;
    const branch = session.plan.steps[session.cursor]?.branch ?? 'a branch';
    const total = conflictFiles.length;

    let message: string;
    if (options.refused) {
      // A Continue that could not proceed. Says so plainly rather than
      // re-rendering the same state and looking like a dead button.
      message = `Still unresolved: ${unresolved.join(', ')}. Stage the fixes (\`git add\`), then continue.`;
    } else if (total === 0) {
      message = `Rebase of ${branch} paused. Resolve, stage, then continue.`;
    } else if (unresolved.length === 0) {
      message = `Conflict on ${branch}. All ${total} file${total === 1 ? '' : 's'} resolved — continue to finish the rebase.`;
    } else if (unresolved.length < total) {
      message = `Conflict on ${branch}. ${total - unresolved.length} of ${total} file${total === 1 ? '' : 's'} resolved — ${unresolved.length} to go.`;
    } else {
      message = `Conflict on ${branch}. Resolve the file${total === 1 ? '' : 's'} below, stage ${total === 1 ? 'it' : 'them'}, then continue.`;
    }

    this.publishProgress({
      phase: 'conflict',
      conflictBranch: session.plan.steps[session.cursor]?.branch,
      conflictFiles,
      unresolvedFiles: unresolved,
      message,
    });
  }

  /** Resume after the user resolved a conflict in the editor. */
  async resume(): Promise<void> {
    const session = this.require();

    const picking = await cherryPickInProgress(session.cwd);
    if (!picking && !(await rebaseInProgress(session.cwd))) {
      // Resolved and continued outside Restack. Treat the paused step as done.
      session.statuses[session.cursor] = 'done';
      session.cursor += 1;
      await this.drive();
      return;
    }

    const unmerged = await unmergedFiles(session.cwd);
    if (unmerged.length > 0) {
      this.emitConflict(session, unmerged, { refused: true });
      return;
    }

    // Which one, by which is open. A cherry-pick during an amend is a distinct
    // sequencer from the rebase that follows it, and `rebase --continue`
    // against an open pick fails with "no rebase in progress".
    const args = picking ? ['cherry-pick', '--continue'] : ['rebase', '--continue'];
    const result = await run('git', args, session.cwd);
    if (result.code !== 0) {
      await this.reportSequencerFailure(result);
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

    const order = stack.branches.map((b) => b.name);
    const steps = publishSteps(stack.trunk, linkableBranches(stack, order));
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
      stash: state.stash,
      stashSettled: state.stashSettled,
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
    if (await cherryPickInProgress(cwd)) {
      await run('git', ['cherry-pick', '--abort'], cwd);
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

    await this.restoreParked(session);

    // Every branch is back at its pre-apply sha and HEAD is home, so the tree
    // is in the state the stash was taken from — the cleanest pop there is.
    await this.settleStash(session);

    // `canUndo: false` because the rollback just happened and the session is
    // about to be cleared. Left true, the panel offers Roll back a second time
    // for a session that no longer exists, and the click reports "No apply in
    // progress." — which reads as a failure when nothing failed.
    this.publishProgress({
      phase: 'failed',
      canUndo: false,
      message: 'Rolled back. Every branch is back where it started.',
    });
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

  /**
   * Drop the session. Touches the repository only to give a stash back.
   *
   * Dismiss after a successful local apply is the ordinary way to end, and the
   * user's stashed work has to come back with it. The exception is a session
   * dismissed while a rebase is still open — walking away from a conflict
   * rather than resolving it — where the tree cannot take a pop at all. There
   * the stash stays put and reportStash says where it is.
   */
  async dismiss(): Promise<void> {
    const session = this.session;
    if (session?.stash && !session.stashSettled) {
      if (await rebaseInProgress(session.cwd)) {
        session.stashSettled = true;
        await this.options.reportStash?.(session.cwd, session.stash);
      } else {
        await this.settleStash(session);
      }
    }
    this.clear();
  }

  /**
   * Give a stash back, once and only once across a session's life.
   *
   * The flag matters because the terminal paths are not mutually exclusive: a
   * local apply finishes, the panel stays open, and Roll back is still there
   * to be pressed. Without it the second path would pop a stash that is no
   * longer in the list, or worse, one the user has since reused the slot for.
   */
  private async settleStash(session: Session): Promise<void> {
    if (!session.stash || session.stashSettled) {
      return;
    }
    session.stashSettled = true;
    await this.options.restoreStash?.(session.cwd, session.stash);
  }

  /**
   * Put an amend's folded-in change back in the working tree.
   *
   * The reason undo needed touching at all. Rolling back is `update-ref` then
   * `checkout --force`, which for an amend would erase the very work that was
   * just folded in — the change exists only inside the rewritten commit by the
   * time this runs.
   *
   * The parked commit's parent *is* the tip that was just restored, so the diff
   * applies exactly: `--no-commit` leaves it staged with HEAD unmoved, which is
   * the state the user was in before pressing Amend. `--quit` clears the
   * sequencer state a `--no-commit` pick leaves behind; `--abort` would undo
   * the restore.
   */
  private async restoreParked(session: Session): Promise<void> {
    if (!session.plan.amend?.parked) {
      return;
    }
    const picked = await run('git', ['cherry-pick', '--no-commit', PARKED_REF], session.cwd);
    await run('git', ['cherry-pick', '--quit'], session.cwd);
    if (picked.code !== 0) {
      this.options.log?.(
        `Could not restore the parked change: ${firstLine(picked.stderr)}. ` +
          `It is still reachable as ${PARKED_REF}.`,
      );
    }
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

      if (!LOCAL_KINDS.has(step.kind) && session.scope === 'local') {
        // Local scope stops here; the UI offers publish as a separate action.
        // Reaching the boundary *is* the local half finishing — an amend at the
        // top of a stack has no metadata step to say so, because no branch's
        // recorded base moved.
        session.localComplete = true;
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
    const timeout = LOCAL_KINDS.has(step.kind) ? LOCAL_TIMEOUT_MS : REMOTE_TIMEOUT_MS;
    const result = await run(file, step.exec.args, session.cwd, timeout);

    if (result.code === 0) {
      // Exit 0 is not the whole story for submit and link — see stackWarning.
      const warning = stackWarning(step, result);
      if (!warning) {
        return false;
      }
      session.statuses[session.cursor] = 'failed';
      this.publishProgress({
        phase: 'failed',
        message:
          `${warning} The pull requests are on GitHub but are not joined into a stack. ` +
          'Nothing local was lost; retrying Push & submit is safe.',
      });
      return true;
    }

    if (RESUMABLE_KINDS.has(step.kind)) {
      await this.reportSequencerFailure(result);
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
   * A non-zero rebase or cherry-pick means one of two very different things: it
   * stopped on a conflict and left the repository mid-sequencer (recoverable —
   * the user resolves and continues), or it refused outright (not recoverable
   * in place). Whether a sequencer is open is what tells them apart.
   */
  private async reportSequencerFailure(result: RunResult): Promise<void> {
    const session = this.require();

    if (await sequencerInProgress(session.cwd)) {
      const files = await unmergedFiles(session.cwd);
      session.statuses[session.cursor] = 'running';
      // This is where the pause begins, so these files *are* the conflict set
      // the rest of it is measured against.
      this.emitConflict(session, files, { initial: files });
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

    // Only when the session is actually over. A local apply leaves the panel
    // open with Roll back still live, and abort() reaches its snapshot through
    // `git checkout --force` — which discards uncommitted work. Popping here
    // would put the user's changes directly in front of that, so the stash
    // waits for whichever of publish, roll back, or dismiss comes first.
    if (published) {
      await this.settleStash(session);
    }

    const held = session.stash && !session.stashSettled;
    this.publishProgress({
      phase: 'done',
      message:
        (published
          ? 'Stack reordered and published.'
          : 'Reorder applied locally. Nothing has been pushed.') +
        (held ? ' Your changes are still stashed — publish, roll back, or dismiss to get them back.' : ''),
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
