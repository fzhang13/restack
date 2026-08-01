import type { BranchPr, StackDivergence, Tracking } from '../../model';

/**
 * Where a branch stands against its upstream, as one small pill.
 *
 * Renders nothing when the branch is level with its remote — the common case,
 * and a row of "in sync" badges would bury the two states that matter. `gone`
 * and `unpushed` are stated because their *absence* of counts is otherwise
 * indistinguishable from being level.
 */
export function TrackingBadge({ tracking }: { tracking?: Tracking }) {
  if (!tracking) {
    return null;
  }
  const { ahead, behind, gone, upstream } = tracking;

  if (gone) {
    return (
      <span className="badge badge--gone" title={`${upstream} no longer exists on the remote`}>
        gone
      </span>
    );
  }
  if (!upstream) {
    return (
      <span className="badge badge--unpushed" title="Never pushed — no upstream branch">
        unpushed
      </span>
    );
  }
  if (ahead > 0 && behind > 0) {
    return (
      <span
        className="badge badge--diverged"
        title={`${ahead} ahead, ${behind} behind ${upstream}. Sync before rewriting: a force-push would drop those ${behind}.`}
      >
        ↑{ahead} ↓{behind}
      </span>
    );
  }
  if (behind > 0) {
    return (
      <span
        className="badge badge--behind"
        title={`${behind} behind ${upstream}. Sync before rewriting: a force-push would drop them.`}
      >
        ↓{behind}
      </span>
    );
  }
  if (ahead > 0) {
    return (
      <span className="badge badge--ahead" title={`${ahead} not yet pushed to ${upstream}`}>
        ↑{ahead}
      </span>
    );
  }
  return null;
}

/**
 * The branch this row's PR targets on GitHub, when it is not the one below it
 * here.
 *
 * A gap nothing else on this screen can show. gh-stack records a base *SHA*
 * locally and never reads the PR's own `baseRefName`, so a base retargeted on
 * the server — by a colleague, by a merge queue, by GitHub itself when a
 * parent PR closes — leaves the local view complete and wrong. The PR would
 * merge into somewhere other than the row underneath it.
 *
 * Silent in the ordinary case, like every other badge here: `expected` is the
 * branch below, or the trunk for the bottom row, and matching it renders
 * nothing.
 */
export function PrBaseBadge({ pr, expected }: { pr?: BranchPr; expected: string }) {
  const base = pr?.baseRefName;
  if (!base || base === expected) {
    return null;
  }

  return (
    <span
      className="badge badge--pr-base"
      title={`On GitHub, #${pr.number} targets ${base} — not ${expected}, the branch it sits on here. Submitting the stack retargets it.`}
    >
      PR base: {base}
    </span>
  );
}

/** A PR badge for a switcher row: `#12`, dimmed once merged or closed. */
export function PrBadge({
  number,
  state,
  isDraft,
}: {
  number: number;
  state: string;
  isDraft: boolean;
}) {
  const label = isDraft && state === 'open' ? 'draft' : state;
  return (
    <span className={`switcher__pr switcher__pr--${label}`} title={`#${number} — ${label}`}>
      #{number}
    </span>
  );
}

/**
 * The GitHub stack number a local stack is matched to.
 *
 * Distinct from the switcher's own `index`, which is this clone's position in
 * `.git/gh-stack` and means nothing to anyone else. This one is the number in
 * the GitHub stack UI — the shared name for the thing, and the argument
 * `gh stack link` takes.
 */
export function RemoteStackBadge({ number, size }: { number: number; size?: number }) {
  return (
    <span
      className="switcher__remote"
      title={`GitHub stack ${number}${size ? `, ${size} pull request${size === 1 ? '' : 's'}` : ''} — the number shown in the GitHub stack UI, shared with everyone else looking at it.`}
    >
      ⧉{number}
    </span>
  );
}

/**
 * A local stack and its GitHub counterpart holding different PRs.
 *
 * Only `onlyRemote` is worth a warning. A PR added to the stack on GitHub has
 * no branch in this clone, and nothing else in Restack can see it — the local
 * view is complete and wrong. `onlyLocal` is the ordinary state of a branch not
 * yet submitted, so it is mentioned in the tooltip and never coloured.
 */
export function DivergenceBadge({ divergence }: { divergence: StackDivergence }) {
  const { onlyRemote, onlyLocal } = divergence;
  if (onlyRemote.length === 0) {
    return null;
  }

  return (
    <span
      className="switcher__diverged"
      title={
        `On GitHub this stack also holds ${onlyRemote.join(', ')}, which this clone has no branch for. ` +
        `Run \`gh stack sync\` to pull them down.` +
        (onlyLocal.length > 0
          ? `\n\nNot yet on GitHub: ${onlyLocal.join(', ')} — ordinary for a branch you have not submitted.`
          : '')
      }
    >
      +{onlyRemote.length} on GitHub
    </span>
  );
}
