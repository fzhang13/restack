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

function sendStack() {
  window.postMessage(
    { type: 'stack', result: { kind: 'ok', stack }, candidates, canPublish: true },
    '*',
  );
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
