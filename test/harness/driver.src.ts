import { parseStack } from '../../src/parse';
import { computePlan, publishSteps } from '../../src/plan';
import type { CandidateBranch } from '../../src/model';
import fixture from '../../fixtures/stack-no-prs.json';

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
 * Which empty state to render, chosen with `?view=` so all three are
 * reachable without editing this file:
 *
 *   (default)     the stack view
 *   ?view=init    no stack anywhere — the create-a-stack entry point
 *   ?view=outside a stack exists, but HEAD is not in it
 *   ?view=drift   a stack whose branches were adopted but never rebased
 */
const view = new URLSearchParams(location.search).get('view') ?? '';

/** Stacks gh-stack has recorded, for the "standing outside one" case. */
const localStacks = [{ trunk: 'main', branches: ['feat/auth', 'feat/api', 'feat/ui'] }];

function sendStack() {
  if (view === 'init' || view === 'outside') {
    window.postMessage(
      {
        type: 'stack',
        result: {
          kind: 'no-stack',
          message: 'current branch "main" is not part of a stack',
          trunk: 'main',
          localBranches: ['main', 'develop', 'spike/cache', 'chore/deps'],
          stacks: view === 'outside' ? localStacks : [],
        },
        candidates,
        canPublish: true,
      },
      '*',
    );
    return;
  }

  // gh-stack flags branches an init adopted but never rebased.
  const result =
    view === 'drift'
      ? {
          kind: 'ok',
          stack: {
            ...stack,
            branches: stack.branches.map((b, i) => ({ ...b, needsRebase: i > 0 })),
          },
        }
      : { kind: 'ok', stack };

  window.postMessage({ type: 'stack', result, candidates, canPublish: true }, '*');
}

/**
 * Apply progress the host would emit. Nothing runs here — the harness has no
 * repository — but the panel has to be reachable to be eyeballed, and an
 * enabled button that did nothing would read as a bug.
 */
function fakeApply(order: string[]) {
  const plan = computePlan(stack, order, candidates);
  const statuses = plan.steps.map((s) =>
    s.kind === 'push' || s.kind === 'submit' ? 'skipped' : 'done',
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

/** The standalone toolbar action: a two-step plan with no reorder in front. */
function fakePushSubmit() {
  const steps = publishSteps();
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
  } else if (m.type === 'initStack' || m.type === 'rebaseStack') {
    // Both are host-side: one shells out to gh, the other opens an apply
    // session. Logged so the button is visibly wired.
    console.log('[harness]', m.type, m.trunk ?? '', (m.branches ?? []).join(' '));
  } else if (m.type === 'openUrl' || m.type === 'openFile' || m.type === 'checkout') {
    // Host-side effects with no browser equivalent. Logged so a dead click is
    // distinguishable from one that fired.
    console.log('[harness]', m.type, m.url ?? m.path ?? m.branch);
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
