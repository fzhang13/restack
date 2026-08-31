import * as vscode from 'vscode';
import { preflight } from '../../apply';
import { changeBasePlan } from '../../plan';
import {
  ensureBaseBranch,
  fetchRemote,
  listRemotes,
  localNameFor,
  readAllTracking,
} from '../../remote';
import type { Stack } from '../../model';
import { blockedByApply, type Host } from '../host';
import { confirmChangeBase } from '../prompts';
import { offerStash, restoreStash, startWithStash } from './stash';

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
export async function resolveRemoteBase(
  host: Host,
  cwd: string,
  picked: string,
): Promise<string | undefined> {
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
      host.log.appendLine(`Could not fetch ${remote} before resolving ${picked}: ${failure}`);
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
      host.log.appendLine(
        `Fast-forwarded ${local} ${result.by} commit${result.by === 1 ? '' : 's'} to ${picked}.`,
      );
      return local;

    case 'created':
      host.log.appendLine(`Created ${local} tracking ${picked}.`);
      return local;

    default:
      return local;
  }
}

/**
 * A sentence about a local base that has fallen behind its upstream, or
 * nothing when it has not.
 *
 * Local refs only, so this is as stale as the last fetch — which is exactly
 * what it is warning about, and why it is worded as of-the-last-fetch rather
 * than as fact.
 */
export async function baseStaleness(cwd: string, base: string): Promise<string | undefined> {
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
export async function handleChangeBase(
  host: Host,
  base: string,
  isRemote?: boolean,
): Promise<void> {
  const cwd = host.cwd();
  const stack = host.stack;
  if (!cwd || !stack) {
    return;
  }

  if (blockedByApply(host)) {
    return;
  }

  await host.guard(async () => {
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
      const resolved = await resolveRemoteBase(host, cwd, base);
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

    const stash = await offerStash(cwd, host, `Moving the stack onto ${local}`);

    // Against the *new* trunk: its merge-base check is exactly the question
    // of whether these branches can be replayed onto it at all.
    const blocked = await preflight(cwd, rebased, 'local', order);
    if (blocked) {
      void vscode.window.showErrorMessage(`Restack: ${blocked}`);
      if (stash) {
        await restoreStash(cwd, host, stash);
      }
      return;
    }

    // A *local* base gets no fetch above, so it may be well behind its own
    // upstream — and the stack is about to be replayed onto whatever commit
    // it is sitting on. Stated rather than refused: basing on a deliberately
    // older commit is legitimate, and Sync stack is the fix if it was not.
    const staleness = isRemote ? undefined : await baseStaleness(cwd, local);

    const bottom = order[0];
    const withPr = stack.branches[0]?.prNumber;
    if (!(await confirmChangeBase(stack.trunk, local, bottom, staleness, withPr))) {
      if (stash) {
        await restoreStash(cwd, host, stash);
      }
      return;
    }

    host.publishPlan(plan, order);

    // The modified stack, not the original: this is what writeMetadata reads
    // the trunk from, and so what lands in .git/gh-stack.
    await startWithStash(cwd, host, stash, () =>
      host.runner.start(cwd, host.ghPath(), rebased, plan, order, 'local', stash),
    );
    await host.refresh();
  });
}
