import { useState } from 'react';
import type { StackSummary } from '../../model';
import { vscodeApi } from '../vscode';
import { DivergenceBadge, PrBadge, RemoteStackBadge } from './badges';

/**
 * One row in the switcher: a stack, its branches, and where its PRs stand.
 *
 * Branches read top-down here as everywhere else, with the trunk last — the
 * same shape `gh stack view` prints, so a row and the column below it describe
 * a stack the same way round.
 */
export function StackRow({ stack, onSwitch }: { stack: StackSummary; onSwitch: () => void }) {
  const topDown = [...stack.branches].reverse();
  const top = stack.branches[stack.branches.length - 1];

  return (
    <li className={`stacks__item${stack.isActive ? ' stacks__item--active' : ''}`}>
      <span className="switcher__number" aria-hidden="true">
        {stack.isActive ? '●' : '○'} {stack.index}
      </span>

      <span className="stacks__path">
        {topDown.map((name, i) => {
          const pr = stack.prs[name];
          return (
            <span key={name}>
              {i > 0 && <span className="stacks__arrow"> ← </span>}
              <span>{name}</span>
              {pr && <PrBadge number={pr.number} state={pr.state} isDraft={pr.isDraft} />}
            </span>
          );
        })}
        <span className="stacks__arrow"> ← </span>
        <span className="stacks__trunk">{stack.trunk}</span>
        {stack.behind > 0 && (
          <span
            className="switcher__behind"
            title={`${stack.behind} commit${stack.behind === 1 ? '' : 's'} on the remote that this clone does not have, as of the last fetch. Rewriting is blocked until they are pulled.`}
          >
            ↓{stack.behind}
          </span>
        )}
        {stack.remoteStackNumber && <RemoteStackBadge number={stack.remoteStackNumber} />}
        {stack.divergence && <DivergenceBadge divergence={stack.divergence} />}
      </span>

      {stack.isActive ? (
        <span className="switcher__here">current</span>
      ) : (
        <button
          type="button"
          onClick={onSwitch}
          title={`Check out ${top}, the top of this stack. gh-stack reports the stack HEAD is in, so standing in it is what makes it the active one.`}
        >
          Check out
        </button>
      )}
    </li>
  );
}

/**
 * Every stack in the repository, and which one you are standing in.
 *
 * gh-stack models many stacks per repository — `.git/gh-stack` holds an array,
 * and `gh stack checkout` takes a stack number — but `gh stack view` reports
 * only the stack HEAD is in. So before this, the other stacks in a repository
 * were invisible from inside one: reachable only by knowing their branch names
 * and checking one out from a terminal.
 *
 * Collapsed to a single line by default, because the common repository has one
 * stack and the switcher should cost it nothing. Renders nothing at all below
 * two, where there is no choice to offer.
 */
export function StackSwitcher({ stacks }: { stacks: StackSummary[] }) {
  const [open, setOpen] = useState(false);
  const active = stacks.find((s) => s.isActive);

  if (stacks.length < 2) {
    return null;
  }

  return (
    <section className="switcher">
      <button
        type="button"
        className="switcher__header"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className="switcher__caret" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className="switcher__summary">
          {active ? (
            <>
              Stack {active.index} of {stacks.length}
            </>
          ) : (
            // Standing outside every stack is a position too — and the one
            // where the switcher is most worth opening.
            <>
              {stacks.length} stacks · none checked out
            </>
          )}
        </span>
        {active && <span className="switcher__trunk">on {active.trunk}</span>}
      </button>

      {open && (
        <ul className="stacks__list">
          {stacks.map((s) => (
            <StackRow
              key={s.index}
              stack={s}
              onSwitch={() => vscodeApi.postMessage({ type: 'switchStack', index: s.index })}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
