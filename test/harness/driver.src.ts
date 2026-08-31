import { parseStack } from '../../src/parse';
import {
  changeBasePlan,
  computePlan,
  linkableBranches,
  publishSteps,
  syncPlan,
} from '../../src/plan';
import type {
  BranchChanges,
  CandidateBranch,
  RemoteStackSummary,
  RemoteState,
  StackBranch,
  StackSummary,
  Tracking,
  WorkingTree,
} from '../../src/model';
import fixture from '../../fixtures/stack-no-prs.json';

/**
 * Mutable, unlike the other fixtures here: `gh stack add` appends to the stack
 * on disk, so a harness that kept re-sending the parsed fixture would show the
 * button doing nothing. See handleAdd.
 */
const stack = parseStack(JSON.stringify(fixture));

/**
 * Stand-ins for what candidates.ts would report. The harness has no
 * repository, so these are invented — but they carry the same shape, including
 * a 40-char merge-base, so the tray and every plan drawn from it exercise the
 * real code paths.
 */
const candidates: CandidateBranch[] = [
  { name: 'spike/cache', base: 'f'.repeat(40), commitCount: 2 },
  { name: 'chore/deps', base: 'e'.repeat(40), commitCount: 1 },
  { name: 'wip/empty', base: 'd'.repeat(40), commitCount: 0 },
];

/**
 * What loadChanges answers with, per branch, for `?view=changes`.
 *
 * `feat/ui` is deliberately empty — the stack's top branch, and the one HEAD
 * sits on in the default fixture, so it is also where the working tree
 * fixture below shows up. Together they put both of ChangeTree's empty states
 * on screen at once.
 */
const harnessChanges: Record<string, BranchChanges> = {
  'feat/api': {
    branch: 'feat/api',
    base: 'a'.repeat(40),
    tip: 'b'.repeat(40),
    files: [
      { status: 'M', path: 'src/api.ts' },
      { status: 'A', path: 'src/route.ts' },
      { status: 'R', path: 'src/handlers/user.ts', oldPath: 'src/user.ts' },
    ],
    commits: [
      {
        sha: 'b'.repeat(40),
        shortSha: 'bbbbbbb',
        subject: 'fix types on the route handler',
        author: 'Ada',
        relativeDate: '2 hours ago',
        files: [{ status: 'M', path: 'src/api.ts' }],
      },
      {
        sha: 'c'.repeat(40),
        shortSha: 'ccccccc',
        subject: 'add route',
        author: 'Ada',
        relativeDate: '3 days ago',
        files: [
          { status: 'A', path: 'src/route.ts' },
          { status: 'R', path: 'src/handlers/user.ts', oldPath: 'src/user.ts' },
        ],
      },
    ],
  },
  // An empty branch, so the "no commits of its own yet" state is reachable.
  'feat/ui': { branch: 'feat/ui', base: 'd'.repeat(40), tip: 'd'.repeat(40), files: [], commits: [] },
};

const harnessWorkingTree: WorkingTree = {
  branch: 'feat/ui',
  staged: [{ status: 'M', path: 'src/webview/views/StackView.tsx' }],
  unstaged: [{ status: 'M', path: 'src/changes.ts' }],
  untracked: ['scratch.md'],
  head: {
    sha: '4f2a1c9e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39',
    shortSha: '4f2a1c9',
    subject: 'feat: add ui components',
  },
};

const harnessCounts: Record<string, number> = { 'feat/auth': 1, 'feat/api': 2, 'feat/ui': 0 };

/**
 * Which state to render, chosen with `?view=` so all of them are reachable
 * without editing this file:
 *
 *   (default)     the stack view — HEAD on feat/ui, the top branch
 *   ?view=init    no stack anywhere — the create-a-stack entry point
 *   ?view=outside a stack exists, but HEAD is not in it
 *   ?view=drift   a stack whose branches were adopted but never rebased
 *   ?view=trunk   HEAD on the trunk rather than on any stack branch
 *   ?view=away    HEAD on a branch gh-stack does not list at all
 *   ?view=amend   like ?view=changes; expand a row for the amend/reword buttons
 *   ?view=conflict a paused rebase, for the conflict panel
 *   ?view=rebase  the same pause, but with HEAD detached so the stack cannot be
 *                 read at all — the panel has to survive without it
 *   ?view=detached HEAD off a branch with no rebase behind it
 *   ?view=behind  the trunk moved under the stack — the sync banner
 *   ?view=diverged a stack branch is behind its upstream — the blocking banner
 *   ?view=remote-base a stack based on a colleague's branch, not on main
 *   ?view=no-remote no remote at all: Fetch disabled, no badges anywhere
 *   ?view=multi   three stacks in one repository — the switcher
 *   ?view=github  the same, plus what GitHub knows: stack numbers, drift, and a
 *                 stack that exists only on the remote
 *   ?view=setup   gh is installed, gh-stack is not — the install screen
 *   ?view=no-gh   no gh CLI at all, the one Restack cannot fix for you
 *   ?view=changes the stack view with counts and an expanded branch's contents
 *   ?view=folder  a multi-root workspace with no obvious repository to read
 */
const view = new URLSearchParams(location.search).get('view') ?? '';

/**
 * Stacks gh-stack has recorded, as readStackSummaries reports them.
 *
 * Three, because two would not show the difference between "the active one"
 * and "the rest". The second is `isActive` in the multi view, and the third is
 * deliberately merged-and-behind: the switcher's job is to make a stack you are
 * not standing in legible, and one wanting cleanup is the case that matters.
 */
const localStacks: StackSummary[] = [
  {
    index: 1,
    trunk: 'main',
    branches: ['feat/auth', 'feat/api', 'feat/ui'],
    isActive: false,
    prs: {
      'feat/auth': { number: 41, url: '', title: 'auth', state: 'open', isDraft: false },
      'feat/api': { number: 42, url: '', title: 'api', state: 'open', isDraft: true },
    },
    ahead: 3,
    behind: 0,
  },
  {
    index: 2,
    trunk: 'main',
    branches: ['db/schema', 'db/seed'],
    isActive: false,
    prs: { 'db/schema': { number: 38, url: '', title: 'schema', state: 'open', isDraft: false } },
    ahead: 2,
    behind: 0,
  },
  {
    index: 3,
    trunk: 'release/2.0',
    branches: ['hotfix/token-expiry'],
    isActive: false,
    prs: {
      'hotfix/token-expiry': { number: 35, url: '', title: 'expiry', state: 'merged', isDraft: false },
    },
    ahead: 0,
    behind: 4,
  },
];

/** The same list with one marked active, for views where HEAD is in a stack. */
function stacksWithActive(index: number): StackSummary[] {
  return localStacks.map((s) => ({ ...s, isActive: s.index === index }));
}

/**
 * The three things reading GitHub adds, one per stack, since the point is that
 * they are independent of each other:
 *
 *   1 — matched and in agreement: a stack number and nothing else.
 *   2 — matched and diverged: someone added a PR to it on GitHub.
 *   3 — not matched at all, which is the ordinary case for a stack whose PRs
 *       were opened by hand rather than through `gh stack`.
 */
function stacksWithGithub(): StackSummary[] {
  return stacksWithActive(1).map((s) => {
    if (s.index === 1) {
      return {
        ...s,
        remoteStackNumber: 1204,
        // #42 should target feat/auth, the branch below it. GitHub retargets a
        // PR to the trunk when its parent closes, and gh-stack records a base
        // SHA locally and never notices — so the column reads as fine.
        prs: {
          ...s.prs,
          'feat/api': { ...s.prs['feat/api'], baseRefName: 'main' },
        },
      };
    }
    if (s.index === 2) {
      return {
        ...s,
        remoteStackNumber: 1187,
        divergence: { onlyRemote: ['db/indexes'], onlyLocal: ['db/seed'] },
      };
    }
    return s;
  });
}

/**
 * A stack on GitHub this clone has no branch for — a colleague's. The case
 * neither `gh stack view` nor `.git/gh-stack` can see, so it is the whole
 * subject of the "On GitHub only" list.
 */
const remoteOnly: RemoteStackSummary[] = [
  {
    number: 1163,
    baseRefName: 'main',
    checkoutPr: 27,
    entries: [
      { position: 1, number: 27, headRefName: 'sam/parser-errors', state: 'open' },
      { position: 2, number: 29, headRefName: 'sam/parser-recovery', state: 'open' },
    ],
  },
];

/** Remote-tracking refs, for the init view's remote optgroup. */
const remoteBranches = ['origin/main', 'origin/colleague/feature', 'origin/release/2.0'];

function track(branch: string, ahead: number, behind: number, extra: Partial<Tracking> = {}): Tracking {
  return { branch, upstream: `origin/${branch}`, ahead, behind, gone: false, ...extra };
}

/**
 * What readRemoteState would report, per view. Local reads in the real host, so
 * this arrives with every `stack` message rather than being fetched separately.
 *
 * `lastFetched` is stamped at load so the relative time renders as "just now"
 * rather than a fixed date drifting further into the past.
 */
function remoteFor(trunk: string): RemoteState | undefined {
  if (view === 'no-remote') {
    return undefined;
  }

  const branches: Tracking[] =
    view === 'diverged'
      ? [
          track('feat/auth', 0, 0),
          // Someone pushed to this one while we were working: the case
          // --force-with-lease cannot save us from.
          track('feat/api', 2, 1),
          { branch: 'feat/ui', ahead: 0, behind: 0, gone: false },
        ]
      : [
          track('feat/auth', 0, 0),
          track('feat/api', 1, 0),
          { branch: 'feat/ui', ahead: 0, behind: 0, gone: false },
        ];

  return {
    remote: 'origin',
    trunk: track(trunk, 0, view === 'behind' ? 3 : 0),
    branches,
    lastFetched: Date.now(),
  };
}

function sendStack() {
  // A multi-root workspace Restack cannot resolve on its own. Ahead of the
  // setup states below for the same reason App.tsx puts it there: with no
  // folder settled, nothing has asked gh anything yet.
  if (view === 'folder') {
    window.postMessage(
      {
        type: 'stack',
        result: {
          kind: 'pick-folder',
          message:
            'This workspace has several folders, and more than one of them — or none of ' +
            'them — holds a stack. Pick the repository to read.',
          folders: [
            { name: 'restack', path: '/Users/you/code/restack' },
            { name: 'gh-stack', path: '/Users/you/code/gh-stack' },
            { name: 'notes', path: '/Users/you/Documents/notes' },
          ],
        },
        candidates: [],
        canPublish: false,
        stacks: [],
        remoteStacks: [],
        commitCounts: {},
      },
      '*',
    );
    return;
  }

  // A rebase stopped on a conflict: HEAD is detached, so gh-stack cannot name a
  // branch and there is no stack to render. The scene worth checking is what
  // follows the message — the paused apply's panel, which is the only way back
  // out and which this state used to hide behind a generic error screen.
  if (view === 'rebase' || view === 'detached') {
    window.postMessage(
      {
        type: 'stack',
        result: {
          kind: 'detached-head',
          message: 'failed to get current branch: failed to run git: not on any branch',
          sequencer: view === 'rebase',
        },
        candidates: [],
        canPublish: false,
        stacks: [],
        remoteStacks: [],
        commitCounts: {},
      },
      '*',
    );
    if (view === 'rebase') {
      sendConflict(['shared.txt', 'src/one.ts']);
    }
    return;
  }

  // Restack not set up yet. Neither carries a stack, candidates, or anything
  // else — that is the point: these are the states where nothing could be read.
  if (view === 'setup' || view === 'no-gh') {
    window.postMessage(
      {
        type: 'stack',
        result:
          view === 'setup'
            ? {
                kind: 'stack-missing',
                message: 'The gh CLI is installed, but the gh-stack extension is not.',
              }
            : {
                kind: 'gh-missing',
                message: 'Could not run "gh". Install the GitHub CLI, or set restack.ghPath.',
              },
        candidates: [],
        canPublish: false,
        stacks: [],
        remoteStacks: [],
        commitCounts: {},
      },
      '*',
    );
    return;
  }

  if (view === 'init' || view === 'outside') {
    window.postMessage(
      {
        type: 'stack',
        result: {
          kind: 'no-stack',
          message: 'current branch "main" is not part of a stack',
          trunk: 'main',
          localBranches: ['main', 'develop', 'spike/cache', 'chore/deps'],
          remoteBranches,
        },
        candidates,
        canPublish: true,
        stacks: view === 'outside' ? localStacks : [],
        remoteStacks: [],
        commitCounts: {},
      },
      '*',
    );
    return;
  }

  // gh-stack flags branches an init adopted but never rebased.
  const drifted = {
    ...stack,
    branches: stack.branches.map((b, i) => ({ ...b, needsRebase: i > 0 })),
  };

  // Both positions gh-stack reports without HEAD being on a stack branch: it
  // prints the stack either way, so each is a place to stand, not an error.
  const elsewhere = (currentBranch: string) => ({
    ...stack,
    currentBranch,
    branches: stack.branches.map((b) => ({ ...b, isCurrent: false })),
  });

  const stacks: Record<string, unknown> = {
    drift: drifted,
    trunk: elsewhere(stack.trunk),
    away: elsewhere('spike/cache'),
    // The whole point of --base: a stack sitting on a branch that is not the
    // default one, and whose own PR is still open.
    'remote-base': { ...stack, trunk: 'colleague/feature' },
  };

  // The github view is the one scene where the columns and the switcher are on
  // screen together, so the PR numbers have to agree — `no PR` in the column
  // beside `#42` in the row above it would read as a bug rather than as a
  // fixture that happens not to carry them.
  const prNumbers: Record<string, number> = { 'feat/auth': 41, 'feat/api': 42 };
  const submitted = {
    ...stack,
    branches: stack.branches.map((b) => ({ ...b, prNumber: prNumbers[b.name] })),
  };

  const shown = (view === 'github' ? submitted : (stacks[view] ?? stack)) as typeof stack;
  const result = { kind: 'ok', stack: shown };
  window.postMessage(
    {
      type: 'stack',
      result,
      candidates,
      canPublish: true,
      remote: remoteFor(shown.trunk),
      // Only the multi and github views have more than one stack; everywhere
      // else the switcher renders nothing, which is what a one-stack repository
      // should see. Stack 1 is the one this fixture describes.
      stacks:
        view === 'github' ? stacksWithGithub() : view === 'multi' ? stacksWithActive(1) : [],
      // Everywhere else this is empty, which is both the common repository and
      // what `restack.readRemoteStacks: false` produces.
      remoteStacks: view === 'github' ? remoteOnly : [],
      // Counts are always on in the real host, so they are on in every view
      // here too. The tree and the working tree are the changes view's own.
      commitCounts: harnessCounts,
      workingTree: view === 'changes' || view === 'amend' ? harnessWorkingTree : undefined,
    },
    '*',
  );

  if (view === 'conflict') {
    sendConflict(['shared.txt', 'src/one.ts']);
  }
}

/**
 * A paused rebase, so the conflict panel is reachable with no repository behind
 * it. `resolved` is what the index would now report as staged — the harness
 * moves files into it as Resolve is clicked, which is exactly what the real
 * `.git/index` watcher does via ApplyRunner.refreshConflict.
 */
let conflictFiles: string[] = [];
let resolvedFiles: string[] = [];

function sendConflict(files?: string[]) {
  if (files) {
    conflictFiles = files;
    resolvedFiles = [];
    // The panel renders against a plan, so publish the one being "applied".
    window.postMessage(
      { type: 'plan', plan: computePlan(stack, ['feat/api', 'feat/auth', 'feat/ui'], candidates) },
      '*',
    );
  }

  const unresolved = conflictFiles.filter((f) => !resolvedFiles.includes(f));
  const done = conflictFiles.length - unresolved.length;
  window.postMessage(
    {
      type: 'apply',
      progress: {
        phase: 'conflict',
        scope: 'local',
        stepIndex: 0,
        statuses: ['running', 'pending', 'pending'],
        canUndo: true,
        conflictFiles,
        unresolvedFiles: unresolved,
        message: unresolved.length
          ? `Conflict on feat/auth. ${done} of ${conflictFiles.length} files resolved.`
          : `Conflict on feat/auth. All ${conflictFiles.length} files resolved — continue to finish the rebase.`,
      },
    },
    '*',
  );
}

/**
 * What the host does for `addBranch`, minus the CLI: append on top, move HEAD
 * onto it, and flag it as drifted the way an adopted branch arrives.
 *
 * Mutating the stack rather than faking a message is the point — it is what
 * makes the drift banner appear afterwards, so the add → Rebase stack sequence
 * can be walked through here rather than only in a repository.
 */
function handleAdd(name: string) {
  if (stack.branches.some((b) => b.name === name)) {
    console.log('[harness] addBranch', name, '— already in the stack, host would refuse');
    return;
  }
  const top = stack.branches[stack.branches.length - 1];
  const added: StackBranch = {
    name,
    base: top?.base ?? 'a'.repeat(40),
    isCurrent: true,
    isMerged: false,
    isQueued: false,
    // Adopting does not rebase, so gh-stack flags it — which is what makes the
    // drift banner the next thing you see.
    needsRebase: true,
  };
  stack.branches = [...stack.branches.map((b) => ({ ...b, isCurrent: false })), added];
  stack.currentBranch = name;
  console.log('[harness] addBranch', name, '— appended on top and checked out');
  sendStack();
}

/**
 * Apply progress the host would emit. Nothing runs here — the harness has no
 * repository — but the panel has to be reachable to be eyeballed, and an
 * enabled button that did nothing would read as a bug.
 */
function fakeApply(order: string[]) {
  const plan = computePlan(stack, order, candidates);
  const statuses = plan.steps.map((s) =>
    s.kind === 'push' || s.kind === 'submit' || s.kind === 'link' ? 'skipped' : 'done',
  );
  window.postMessage(
    {
      type: 'apply',
      progress: {
        phase: 'done',
        scope: 'local',
        stepIndex: plan.steps.length,
        statuses,
        localComplete: true,
        canUndo: true,
        message: 'Reorder applied locally. Nothing has been pushed. (harness: simulated)',
      },
    },
    '*',
  );
}

/** The standalone toolbar action: the remote steps with no reorder in front. */
function fakePushSubmit() {
  const steps = publishSteps(
    stack.trunk,
    linkableBranches(stack, stack.branches.map((b) => b.name)),
  );
  window.postMessage(
    {
      type: 'apply',
      progress: {
        phase: 'done',
        scope: 'publish',
        stepIndex: steps.length,
        statuses: steps.map(() => 'done'),
        localComplete: true,
        canUndo: false,
        message: 'Pushed and submitted. (harness: simulated)',
      },
    },
    '*',
  );
}

// Play the extension host: answer 'ready'/'refresh' with the stack, and
// 'reorder' with a plan computed by the real computePlan.
(window as any).__onSend = (m: any) => {
  if (m.type === 'ready' || m.type === 'refresh') {
    sendStack();
  } else if (m.type === 'reorder') {
    window.postMessage({ type: 'plan', plan: computePlan(stack, m.order, candidates) }, '*');
  } else if (m.type === 'apply') {
    fakeApply(m.order);
  } else if (m.type === 'publish' || m.type === 'pushSubmit') {
    fakePushSubmit();
  } else if (m.type === 'applyDismiss') {
    window.postMessage({ type: 'applyCleared' }, '*');
  } else if (m.type === 'addBranch') {
    handleAdd(m.branch);
  } else if (m.type === 'initStack' || m.type === 'rebaseStack') {
    // Both are host-side: one shells out to gh, the other opens an apply
    // session. Logged so the button is visibly wired.
    console.log(
      '[harness]',
      m.type,
      m.trunk ?? '',
      m.trunkIsRemote ? '(remote — host creates the tracking branch)' : '',
      (m.branches ?? []).join(' '),
    );
  } else if (m.type === 'fetch') {
    // The one network call. Nothing to reach here, so the counts just come
    // back as they were — enough to see the button is wired and re-renders.
    console.log('[harness] fetch — no remote to reach, re-sending state');
    sendStack();
  } else if (m.type === 'syncStack') {
    // The real host fetches, re-reads, then runs this plan. Rendering the plan
    // is the part worth eyeballing: trunk step first, then the cascade.
    const plan = syncPlan(stack, 'origin', false);
    console.log('[harness] syncStack —', plan.steps.length, 'steps');
    window.postMessage({ type: 'plan', plan }, '*');
  } else if (m.type === 'pickBase') {
    // A native QuickPick in the host. Stand in for a choice so the plan the
    // pick would produce is still reachable.
    console.log('[harness] pickBase — picking origin/release/2.0 on your behalf');
    window.postMessage({ type: 'plan', plan: changeBasePlan(stack, 'release/2.0') }, '*');
  } else if (m.type === 'changeBase') {
    console.log('[harness] changeBase', m.base, m.isRemote ? '(remote)' : '');
    window.postMessage({ type: 'plan', plan: changeBasePlan(stack, m.base) }, '*');
  } else if (m.type === 'openMergeEditor') {
    // Stand in for the whole loop: the merge editor opens, the merge is
    // completed, the file is staged, and the index watcher reports it back.
    console.log('[harness] openMergeEditor', m.path, '— treating as resolved');
    if (!resolvedFiles.includes(m.path)) {
      resolvedFiles.push(m.path);
    }
    setTimeout(() => sendConflict(), 250);
  } else if (m.type === 'applyContinue') {
    console.log('[harness] applyContinue');
    fakeApply(['feat/api', 'feat/auth', 'feat/ui']);
  } else if (m.type === 'applyAbort') {
    console.log('[harness] applyAbort');
    window.postMessage({ type: 'applyCleared' }, '*');
  } else if (m.type === 'openUrl' || m.type === 'openFile' || m.type === 'checkout') {
    // Host-side effects with no browser equivalent. Logged so a dead click is
    // distinguishable from one that fired.
    console.log('[harness]', m.type, m.url ?? m.path ?? m.branch);
  } else if (m.type === 'loadChanges') {
    // The host would spawn git here. A branch with no fixture answers with
    // nothing at all, which is the same thing the real host does when the
    // request races a refresh — and leaves the row's "Reading…" state visible.
    const found = harnessChanges[m.branch];
    if (found) {
      window.postMessage({ type: 'changes', changes: found }, '*');
    } else {
      console.log('[harness] loadChanges', m.branch, '— no fixture');
    }
  } else if (m.type === 'openCommitFile' || m.type === 'openWorkingFile') {
    // Host-side: there is no editor here to open a diff in.
    // A branch-range row carries the base it should diff against; a per-commit
    // row carries none and means the commit's parent.
    console.log('[harness]', m.type, m.path, m.sha ?? '', m.base ?? '');
  }
};

// The webview bundle loads first and posts 'ready' before this handler exists,
// so replay any already-queued messages, then push the stack unconditionally.
const queued = (window as any).__sent ?? [];
if (queued.some((m: any) => m.type === 'ready')) {
  sendStack();
}
(window as any).__stack = stack;
(window as any).__candidates = candidates;
