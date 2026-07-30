import { parseStack } from '../../src/parse';
import { computePlan } from '../../src/plan';
import fixture from '../../fixtures/stack-no-prs.json';

const stack = parseStack(JSON.stringify(fixture));

function sendStack() {
  window.postMessage({ type: 'stack', result: { kind: 'ok', stack } }, '*');
}

// Play the extension host: answer 'ready'/'refresh' with the stack, and
// 'reorder' with a plan computed by the real computePlan.
(window as any).__onSend = (m: any) => {
  if (m.type === 'ready' || m.type === 'refresh') {
    sendStack();
  } else if (m.type === 'reorder') {
    window.postMessage({ type: 'plan', plan: computePlan(stack, m.order) }, '*');
  }
};

// The webview bundle loads first and posts 'ready' before this handler exists,
// so replay any already-queued messages, then push the stack unconditionally.
const queued = (window as any).__sent ?? [];
if (queued.some((m: any) => m.type === 'ready')) {
  sendStack();
}
(window as any).__stack = stack;
