import type { RemoteState } from '../../model';
import { since } from '../lib/order';
import { vscodeApi } from '../vscode';

/**
 * The stack-wide actions. Everything here is disabled while an apply owns the
 * repository — the host refuses these anyway, and a button that can only be
 * rejected is worse than one that is visibly unavailable.
 */
export function Toolbar({
  busy,
  dirty,
  canPublish,
  remote,
  onReset,
}: {
  busy: boolean;
  dirty: boolean;
  canPublish: boolean;
  remote: RemoteState | null;
  onReset: () => void;
}) {
  return (
    <div className="toolbar">
      <button
        type="button"
        onClick={() => vscodeApi.postMessage({ type: 'refresh' })}
        disabled={busy}
      >
        Refresh
      </button>
      {/*
        Refresh re-reads local refs; this is the only control that talks to
        the network. Every count on this screen is as old as the last one.
      */}
      <button
        type="button"
        onClick={() => vscodeApi.postMessage({ type: 'fetch' })}
        disabled={busy || !remote?.remote}
        title={
          remote?.remote
            ? `git fetch --prune ${remote.remote}` +
              (remote.lastFetched ? ` — last fetched ${since(remote.lastFetched)}` : '')
            : 'No remote to fetch from'
        }
      >
        Fetch
      </button>
      <button type="button" onClick={onReset} disabled={!dirty || busy}>
        Reset
      </button>
      {/*
        `gh stack init` refuses while HEAD is in a stack, so the host parks
        on the trunk first — stated here rather than discovered after the
        click, since it moves the working tree.
      */}
      <button
        type="button"
        onClick={() => vscodeApi.postMessage({ type: 'newStack' })}
        disabled={busy}
        title="Start a second stack in this repository. Checks out the trunk first, since a new stack cannot be started from inside an existing one."
      >
        + New stack
      </button>
      <button
        type="button"
        className="toolbar__remove"
        onClick={() => vscodeApi.postMessage({ type: 'removeStack' })}
        disabled={busy}
        title="Remove this stack from gh-stack's tracking. Every branch and commit is kept."
      >
        Remove stack
      </button>
      <button
        type="button"
        className="publish toolbar__publish"
        onClick={() => vscodeApi.postMessage({ type: 'pushSubmit' })}
        disabled={!canPublish || busy}
        title={
          canPublish
            ? 'Run gh stack push, gh stack submit --auto, then gh stack link — opens the PRs and joins them into a stack on GitHub, for the stack as it is on disk now'
            : 'No origin remote to push to'
        }
      >
        Push &amp; submit
      </button>
    </div>
  );
}
