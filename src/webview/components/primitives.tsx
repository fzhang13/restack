import type { StackBranch } from '../../model';
import { NODE_COLORS } from '../lib/constants';
import { vscodeApi } from '../vscode';

export function Node({ index, isHead }: { index: number; isHead?: boolean }) {
  return (
    <span
      className={`node${isHead ? ' node--head' : ''}`}
      aria-hidden="true"
      style={{ '--node-color': NODE_COLORS[index % NODE_COLORS.length] } as React.CSSProperties}
    />
  );
}

/**
 * Check this branch out. Shown on hover so a row full of always-visible
 * controls does not compete with the graph, and never on the row that is
 * already HEAD — there is nothing to switch to.
 */
export function CheckoutButton({ branch, disabled }: { branch: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      className="row__checkout"
      title={disabled ? 'Busy' : `Check out ${branch}`}
      aria-label={`Check out ${branch}`}
      disabled={disabled}
      // The row is a drag handle and a dblclick target; neither should claim
      // this click. Same treatment as PrTag.
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        vscodeApi.postMessage({ type: 'checkout', branch });
      }}
    >
      ⇣
    </button>
  );
}

/** The PR number, clickable when gh-stack gave us a URL for it. */
export function PrTag({ branch }: { branch: StackBranch }) {
  if (!branch.prNumber) {
    return <span className="pr pr--none">no PR</span>;
  }
  if (!branch.prUrl) {
    return <span className="pr">#{branch.prNumber}</span>;
  }
  return (
    <button
      type="button"
      className="pr pr--link"
      title={branch.prTitle ?? `Open pull request #${branch.prNumber}`}
      // Stop the row's drag sensor and dblclick-to-checkout from claiming this.
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        vscodeApi.postMessage({ type: 'openUrl', url: branch.prUrl! });
      }}
    >
      #{branch.prNumber}
    </button>
  );
}

export function Message({ title, body }: { title: string; body: string }) {
  return (
    <div className="message">
      <h2>{title}</h2>
      <p>{body}</p>
    </div>
  );
}
