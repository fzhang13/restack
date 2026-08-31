import type { Host } from '../host';

/**
 * Answer a webview's request for what one branch changed.
 *
 * Silent on every miss rather than posting an error: the request races a
 * refresh, so a branch that has just left the stack, or a tip the last
 * `for-each-ref` did not see, is an ordinary outcome and not something to put
 * a notification in front of the user for. The row simply stays empty, and an
 * open one asks again on the next refresh — ChangeTree re-requests whenever the
 * webview's cache is invalidated, so a miss here is not a dead end.
 */
export async function handleLoadChanges(host: Host, branch: string): Promise<void> {
  const cwd = host.cwd();
  const entry = host.stack?.branches.find((b) => b.name === branch);
  const tip = host.tips.get(branch);
  if (!cwd || !entry || !tip) {
    return;
  }

  const changes = await host.changes.branchChanges(cwd, branch, entry.base, tip);
  host.post({ type: 'changes', changes });
}
