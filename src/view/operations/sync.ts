import * as vscode from 'vscode';
import { preflight } from '../../apply';
import { syncPlan } from '../../plan';
import {
  MIN_AUTO_FETCH_SECONDS,
  autoFetchInterval,
  detectRemote,
  fetchRemote,
} from '../../remote';
import { blockedByApply, type Host } from '../host';
import { confirmSync } from '../prompts';
import { offerStash, restoreStash, startWithStash } from './stash';

/**
 * Go and ask the remote, then re-render.
 *
 * The place Restack initiates network traffic on its own. Everything the view
 * shows about the remote — the ahead/behind counts, the sync banner, the
 * clobber warning — is read from local refs, so it is only ever as fresh as
 * the last fetch. This is the button that makes it fresh.
 */
export function fetch(host: Host): Promise<void> {
  return runFetch(host, false);
}

/**
 * The same fetch, on the `restack.autoFetch` timer, with nothing to look at.
 *
 * Every difference from the button is about noise. A spinner appearing on the
 * view every few minutes would be a lie about the user having asked for it; an
 * error toast would fire on a repeating timer, so a laptop off the network
 * would raise a notification every interval until it reconnected. Failures go
 * to the output channel, which is the record that background work happened at
 * all. See watchAutoFetch in provider.ts for when this is allowed to run.
 */
export function autoFetch(host: Host): Promise<void> {
  return runFetch(host, true);
}

async function runFetch(host: Host, silent: boolean): Promise<void> {
  const cwd = host.cwd();
  if (!cwd) {
    return;
  }

  // blockedByApply warns as a side effect, which the timer must not do — it
  // would warn about an apply the user is already looking at, on a loop.
  if (silent ? host.runner.active : blockedByApply(host)) {
    return;
  }

  const body = async (): Promise<void> => {
    const remote = await detectRemote(cwd, host.stack?.trunk ?? 'main');
    if (!remote) {
      if (!silent) {
        void vscode.window.showInformationMessage('Restack: no remote to fetch from.');
      }
      return;
    }

    const failure = silent
      ? await fetchRemote(cwd, remote)
      : await vscode.window.withProgress(
          { location: { viewId: 'restack.stackView' }, title: `Fetching ${remote}…` },
          () => fetchRemote(cwd, remote),
        );
    if (failure) {
      if (silent) {
        host.log.appendLine(`Background fetch of ${remote} failed: ${failure}`);
      } else {
        void vscode.window.showErrorMessage(`Restack: ${failure}`);
        host.log.show(true);
      }
    }

    // The switcher's PR and stack badges are the other half of "as of the
    // last fetch", and this is what that phrase refers to.
    // Best-effort, like the fetch above: a failed call leaves the previous
    // badges rather than blanking every row.
    await host.loadGithub(cwd);

    // Either way: a partial fetch still moved some refs, and the counts
    // should reflect what is actually on disk. Quiet on the timer, or the
    // view would flash its loading state every interval.
    await host.refresh({ quiet: silent });
  };

  if (!silent) {
    await host.guard(body);
    return;
  }
  // host.guard shows the error, which is the one thing this path must not do.
  try {
    await body();
  } catch (err) {
    host.log.appendLine(
      `Background fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** The intervals the picker offers. 180 matches VS Code's own git.autofetchPeriod. */
const AUTO_FETCH_PRESETS: { label: string; description: string; seconds: number }[] = [
  { label: 'Off', description: 'Fetch only when you press Fetch', seconds: 0 },
  { label: 'Every 3 minutes', description: '180 seconds', seconds: 180 },
  { label: 'Every 10 minutes', description: '600 seconds', seconds: 600 },
  { label: 'Every 30 minutes', description: '1800 seconds', seconds: 1800 },
];

interface AutoFetchItem extends vscode.QuickPickItem {
  seconds?: number;
  custom?: boolean;
}

/**
 * Turn background fetch on or off from the view, rather than from Settings.
 *
 * `restack.autoFetch` defaults to 0 on purpose — Restack promises to make no
 * network call you did not ask for — but a setting that defaults to off is
 * only ever found by someone who already knows it exists. This is the command
 * that makes it findable: it sits in the view's ⋯ menu, next to the Fetch it
 * automates, which is where the question occurs to you.
 *
 * Writes to Global so the choice follows the machine. Background fetch is a
 * preference about how much network you want, not a property of one checkout.
 */
export async function chooseAutoFetch(): Promise<void> {
  const config = vscode.workspace.getConfiguration('restack');
  const current = autoFetchInterval(config.get<number>('autoFetch', 0));

  const items: AutoFetchItem[] = AUTO_FETCH_PRESETS.map((preset) => ({
    label: preset.label,
    description: preset.seconds === current ? 'current' : preset.description,
    seconds: preset.seconds,
  }));
  // A custom value has no preset to mark, so it gets a row of its own rather
  // than leaving the list looking as though nothing is set.
  if (current !== 0 && !AUTO_FETCH_PRESETS.some((preset) => preset.seconds === current)) {
    items.push({ label: `Every ${current} seconds`, description: 'current', seconds: current });
  }
  items.push({ label: 'Custom…', description: 'Set an interval in seconds', custom: true });

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Restack: background fetch',
    placeHolder:
      current === 0
        ? 'Off — Restack fetches only when you ask it to'
        : `Currently every ${current} seconds`,
  });
  if (!picked) {
    return;
  }

  let seconds = picked.seconds ?? 0;
  if (picked.custom) {
    const typed = await vscode.window.showInputBox({
      title: 'Restack: background fetch',
      prompt:
        `Seconds between fetches. 0 turns it off; ` +
        `anything below ${MIN_AUTO_FETCH_SECONDS} is treated as ${MIN_AUTO_FETCH_SECONDS}.`,
      value: String(current),
      validateInput: (value) =>
        /^\d+$/.test(value.trim()) ? undefined : 'Enter a whole number of seconds.',
    });
    if (typed === undefined) {
      return;
    }
    seconds = autoFetchInterval(Number(typed.trim()));
  }

  await config.update('autoFetch', seconds, vscode.ConfigurationTarget.Global);
  // The timer re-arms off onDidChangeConfiguration, so there is nothing to do
  // here but say what happened — the change is otherwise invisible by design.
  void vscode.window.showInformationMessage(
    seconds === 0
      ? 'Restack: background fetch is off.'
      : `Restack: fetching every ${seconds} seconds.`,
  );
}

/**
 * Bring the stack up to date with a trunk that has moved.
 *
 * Fetches first, always. A sync plan built from stale refs would fast-forward
 * the trunk to a commit that is no longer its tip, and the whole cascade would
 * replay onto the wrong place — so the network call is part of the action
 * rather than something the user is expected to have done first.
 *
 * The stack is re-read after the fetch for the same reason the plan is built
 * after it: `gh stack view`'s `needsRebase` and recorded bases both describe
 * the pre-fetch world.
 *
 * Everything after that is an ordinary apply — snapshot, conflict pause, undo,
 * reload persistence — because syncPlan produces an ordinary Plan.
 */
export async function handleSyncStack(host: Host): Promise<void> {
  const cwd = host.cwd();
  if (!cwd || !host.stack) {
    return;
  }

  if (blockedByApply(host, 'Use the buttons in the plan panel.')) {
    return;
  }

  await host.guard(async () => {
    const remote = await detectRemote(cwd, host.stack?.trunk ?? 'main');
    if (!remote) {
      void vscode.window.showErrorMessage('Restack: no remote to sync with.');
      return;
    }

    const failure = await vscode.window.withProgress(
      { location: { viewId: 'restack.stackView' }, title: `Fetching ${remote}…` },
      () => fetchRemote(cwd, remote),
    );
    if (failure) {
      void vscode.window.showErrorMessage(`Restack: ${failure}`);
      host.log.show(true);
      return;
    }

    // Re-read against post-fetch refs before planning anything.
    await host.refresh();
    const stack = host.stack;
    const remoteState = host.remote;
    if (!stack) {
      return;
    }

    if (!remoteState || remoteState.trunk.behind === 0) {
      void vscode.window.showInformationMessage(
        `Restack: ${stack.trunk} is already up to date with ${remote}.`,
      );
      return;
    }

    const onTrunk = stack.currentBranch === stack.trunk;
    const plan = syncPlan(stack, remote, onTrunk);
    if (plan.isNoop) {
      void vscode.window.showInformationMessage('Restack: nothing to replay.');
      return;
    }

    const order = stack.branches.map((b) => b.name);
    const stash = await offerStash(cwd, host, `Syncing with ${remote}`);
    const blocked = await preflight(cwd, stack, 'local', order);
    if (blocked) {
      void vscode.window.showErrorMessage(`Restack: ${blocked}`);
      if (stash) {
        await restoreStash(cwd, host, stash);
      }
      return;
    }

    const rebases = plan.steps.filter((s) => s.kind === 'rebase').map((s) => s.branch ?? '');
    const behind = remoteState.trunk.behind;
    if (!(await confirmSync(stack.trunk, remote, behind, rebases))) {
      if (stash) {
        await restoreStash(cwd, host, stash);
      }
      return;
    }

    host.publishPlan(plan, order);

    await startWithStash(cwd, host, stash, () =>
      host.runner.start(cwd, host.ghPath(), stack, plan, order, 'local', stash),
    );
    await host.refresh();
  });
}
