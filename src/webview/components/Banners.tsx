import type { RemoteState, Stack, Tracking } from '../../model';
import { ordinal, since } from '../lib/order';
import { vscodeApi } from '../vscode';

/** Where HEAD is, as StackView derives it. */
export interface HeadPosition {
  name?: string;
  onTrunk: boolean;
  /** 1-based from the bottom, matching how the column is counted. */
  position: number;
  total: number;
  /** Neither in the stack nor on its trunk — gh-stack can report this. */
  outside: boolean;
}

/**
 * The band of notices above the columns, in the order they are worth reading.
 *
 * Ordering is the whole design here: `behind` blocks every apply, so it is
 * stated before the trunk case below it, which offers a button that could not
 * run while it holds.
 */
export function Banners({
  stack,
  head,
  hasMerged,
  behind,
  trunkBehind,
  drifted,
  leavingWithPrs,
  remote,
  busy,
}: {
  stack: Stack;
  head: HeadPosition;
  hasMerged: boolean;
  behind: Tracking[];
  trunkBehind: number;
  drifted: string[];
  leavingWithPrs: string[];
  remote: RemoteState | null;
  busy: boolean;
}) {
  return (
    <>
      {head.name && (
        <p className={head.outside ? 'warn' : 'here'}>
          {head.outside ? (
            <>
              You are on <strong>{head.name}</strong>, which is not part of this stack. Check
              out a branch below to work in it.
            </>
          ) : head.onTrunk ? (
            <>
              You are on <strong>{head.name}</strong>, the trunk this stack sits on.
            </>
          ) : (
            <>
              You are on <strong>{head.name}</strong> — {ordinal(head.position)} of {head.total}{' '}
              in the stack.
            </>
          )}
        </p>
      )}

      {hasMerged && (
        <p className="warn">
          This stack has merged branches. Reordering around them is disabled — gh-stack
          rejects inserting next to a merged branch.
        </p>
      )}

      {/*
        Blocking, and first among the remote banners: preflight refuses every
        apply while this holds, so offering the fixable trunk case above it
        would be offering a button that cannot run.
      */}
      {behind.length > 0 && (
        <div className="warn">
          <p className="warn__text">
            {behind
              .map((t) => `${t.branch} is ${t.behind} behind ${t.upstream ?? 'its upstream'}`)
              .join('; ')}
            . Rewriting is blocked: <code>gh stack push</code> force-pushes with a lease
            against the remote ref we already have, so those commits would be dropped with
            no warning. Pull{' '}
            {behind.length === 1 ? 'that branch' : 'those branches'} first — Restack has no
            safe automatic answer, since the local and remote sides have both moved.
          </p>
        </div>
      )}

      {trunkBehind > 0 && (
        <div className="warn">
          <p className="warn__text">
            <strong>{stack.trunk}</strong> is {trunkBehind} commit
            {trunkBehind === 1 ? '' : 's'} behind {remote?.trunk.upstream ?? 'its upstream'}
            {remote?.lastFetched ? ` as of ${since(remote.lastFetched)}` : ''}. Syncing
            fast-forwards it and replays the stack on top — snapshotted first, and nothing
            is pushed.
          </p>
          <button
            type="button"
            onClick={() => vscodeApi.postMessage({ type: 'syncStack' })}
            disabled={busy || behind.length > 0}
            title={
              behind.length > 0
                ? 'Resolve the branches behind their upstreams first.'
                : `Fetch, fast-forward ${stack.trunk}, then replay the stack`
            }
          >
            Sync stack
          </button>
        </div>
      )}

      {drifted.length > 0 && (
        <div className="warn">
          <p className="warn__text">
            {drifted.join(', ')} {drifted.length === 1 ? 'is' : 'are'} not sitting on{' '}
            {drifted.length === 1 ? 'its' : 'their'} recorded parent. Adopting an existing
            branch leaves it this way — <code>gh stack init</code> and{' '}
            <code>gh stack add</code> both record the order without rebasing.
          </p>
          <button type="button" onClick={() => vscodeApi.postMessage({ type: 'rebaseStack' })} disabled={busy}>
            Rebase stack
          </button>
        </div>
      )}

      {leavingWithPrs.length > 0 && (
        <p className="warn">
          {leavingWithPrs.join(', ')} {leavingWithPrs.length === 1 ? 'has' : 'have'} an open
          PR. Removing {leavingWithPrs.length === 1 ? 'it' : 'them'} from the stack leaves that
          PR targeting a base that is no longer its parent — `gh stack submit` will not
          retarget it once it is out of the stack. Retarget or close it on GitHub.
        </p>
      )}
    </>
  );
}
