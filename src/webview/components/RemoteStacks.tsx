import type { RemoteStackSummary } from '../../model';
import { vscodeApi } from '../vscode';
import { PrBadge } from './badges';

/**
 * A stack that exists on GitHub and not in this clone.
 *
 * Rendered in the same grammar as StackRow — top-down, arrows, PR badges, a
 * check-out button on the right — because it is the same kind of thing seen
 * from further away. What it cannot show is everything that needs local refs:
 * no ahead/behind, no HEAD marker, no trunk, since the base is a ref name this
 * clone may not have.
 */
function RemoteStackRow({ stack }: { stack: RemoteStackSummary }) {
  const topDown = [...stack.entries].reverse();

  return (
    <li className="stacks__item stacks__item--remote">
      <span className="switcher__number" aria-hidden="true">
        ⧉ {stack.number}
      </span>

      <span className="stacks__path">
        {topDown.map((entry, i) => (
          <span key={entry.number}>
            {i > 0 && <span className="stacks__arrow"> ← </span>}
            <span>{entry.headRefName}</span>
            <PrBadge number={entry.number} state={entry.state} isDraft={false} />
          </span>
        ))}
        {stack.baseRefName && (
          <>
            <span className="stacks__arrow"> ← </span>
            <span className="stacks__trunk">{stack.baseRefName}</span>
          </>
        )}
      </span>

      <button
        type="button"
        onClick={() =>
          vscodeApi.postMessage({ type: 'checkoutRemoteStack', pr: stack.checkoutPr })
        }
        title={`Run gh stack checkout ${stack.checkoutPr} — fetches every branch in this stack, records it locally, and checks out the top. Nothing on GitHub changes.`}
      >
        Check out
      </button>
    </li>
  );
}

/**
 * Stacks on GitHub with no counterpart here — a colleague's, or your own from
 * another machine.
 *
 * The case neither `gh stack view` nor `.git/gh-stack` can see, and so the one
 * thing on this screen that could not be there before. Renders nothing when
 * there are none, which is the common repository: a solo project pays no
 * chrome for a feature it does not use.
 */
export function RemoteStackList({ stacks }: { stacks: RemoteStackSummary[] }) {
  if (stacks.length === 0) {
    return null;
  }

  return (
    <section className="stacks stacks--remote">
      <h2 className="column__title">On GitHub only</h2>
      <p className="stacks__hint">
        {stacks.length === 1 ? 'One stack' : `${stacks.length} stacks`} on the remote that this
        clone has no branches for. Checking one out fetches its branches and starts tracking it.
      </p>
      <ul className="stacks__list">
        {stacks.map((s) => (
          <RemoteStackRow key={s.number} stack={s} />
        ))}
      </ul>
    </section>
  );
}
