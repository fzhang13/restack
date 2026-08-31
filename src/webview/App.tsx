import type { Stack } from '../model';
import { Message } from './components/primitives';
import { useHostState } from './hooks/useHostState';
import { FolderView } from './views/FolderView';
import { InitView } from './views/InitView';
import { RebaseView } from './views/RebaseView';
import { SetupView } from './views/SetupView';
import { StackView } from './views/StackView';
import { vscodeApi } from './vscode';
import './styles.css';

/**
 * The gates in front of the two real views.
 *
 * Everything here is a state the host can report instead of a stack: still
 * reading, no stack yet, or an error. Only the last case is a dead end — a
 * repository with no stack gets InitView, which is an entry point.
 */
export function App() {
  const host = useHostState();
  const { result, loading, candidates, stacks, remoteStacks } = host;

  if (loading && !result) {
    return <div className="app"><p className="empty">Reading stack…</p></div>;
  }

  // No stack under the current branch is not an error — it is where every
  // repository starts, so it gets an entry point rather than a dead end.
  if (result?.kind === 'no-stack') {
    return (
      <InitView
        message={result.message}
        trunk={result.trunk}
        localBranches={result.localBranches ?? []}
        remoteBranches={result.remoteBranches ?? []}
        stacks={stacks}
        remoteStacks={remoteStacks}
        candidates={candidates}
      />
    );
  }

  // Before the setup gates: with no folder settled there is no repository to
  // have asked `gh` about, so those states cannot be reached from here anyway.
  if (result?.kind === 'pick-folder') {
    return <FolderView message={result.message} folders={result.folders} />;
  }

  // Neither is an error in the stack — they are Restack not being set up yet,
  // and both have something to do about it. Before the generic gate below,
  // which has only a Retry button to offer.
  if (result?.kind === 'gh-missing' || result?.kind === 'stack-missing') {
    return <SetupView kind={result.kind} message={result.message} />;
  }

  // Deliberately its own gate rather than falling into the one below: this is
  // where a conflicted rebase parks the repository, and the generic screen has
  // only Retry — which cannot succeed until the rebase is over, and which would
  // be sitting on top of the paused apply's Continue and Abort buttons.
  if (result?.kind === 'detached-head') {
    return <RebaseView message={result.message} sequencer={result.sequencer} host={host} />;
  }

  if (result && result.kind !== 'ok') {
    const titles: Record<string, string> = {
      'not-a-repo': 'Not a git repository',
      error: 'Could not read stack',
    };
    return (
      <div className="app">
        <Message title={titles[result.kind] ?? 'Error'} body={result.message} />
        <button type="button" onClick={() => vscodeApi.postMessage({ type: 'refresh' })}>
          Retry
        </button>
      </div>
    );
  }

  const stack: Stack | undefined = result?.kind === 'ok' ? result.stack : undefined;
  if (!stack) {
    return <div className="app"><p className="empty">No stack.</p></div>;
  }

  return <StackView stack={stack} host={host} />;
}
