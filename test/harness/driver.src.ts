import { parseStack } from '../../src/parse';
import { computePlan } from '../../src/plan';
import fixture from '../../fixtures/stack-no-prs.json';

const stack = parseStack(JSON.stringify(fixture));

function sendStack() {
  window.postMessage({ type: 'stack', result: { kind: 'ok', stack } }, '*');
}

/**
 * Apply progress the host would emit. Nothing runs here — the harness has no
 * repository — but the panel has to be reachable to be eyeballed, and an
 * enabled button that did nothing would read as a bug.
 */
function fakeApply(order: string[]) {
  const plan = computePlan(stack, order);
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

// Play the extension host: answer 'ready'/'refresh' with the stack, and
// 'reorder' with a plan computed by the real computePlan.
(window as any).__onSend = (m: any) => {
  if (m.type === 'ready' || m.type === 'refresh') {
    sendStack();
  } else if (m.type === 'reorder') {
    window.postMessage({ type: 'plan', plan: computePlan(stack, m.order) }, '*');
  } else if (m.type === 'apply') {
    fakeApply(m.order);
  } else if (m.type === 'applyDismiss') {
    window.postMessage({ type: 'applyCleared' }, '*');
  }
};

// The webview bundle loads first and posts 'ready' before this handler exists,
// so replay any already-queued messages, then push the stack unconditionally.
const queued = (window as any).__sent ?? [];
if (queued.some((m: any) => m.type === 'ready')) {
  sendStack();
}
(window as any).__stack = stack;
