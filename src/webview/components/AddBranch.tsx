import { useCallback, useState } from 'react';
import { addArgs } from '../../plan';
import { vscodeApi } from '../vscode';

/**
 * Add one branch on top of the stack — init's typed-in branch, for a stack that
 * already exists.
 *
 * Sits under the tray because both answer the same question, and the tray alone
 * cannot: dragging needs a branch with commits on it, and a branch created a
 * moment ago has none, so it is filtered out as merged into trunk before it can
 * be dragged anywhere.
 *
 * Top-only, and says so, because `gh stack add` is. The command is previewed
 * the way init's is, built by the same `addArgs` the host runs.
 */
export function AddBranch({ top, blocked }: { top: string | undefined; blocked?: string }) {
  const [draft, setDraft] = useState('');
  const name = draft.trim();

  const submit = useCallback(() => {
    if (!name || blocked) {
      return;
    }
    vscodeApi.postMessage({ type: 'addBranch', branch: name });
    setDraft('');
  }, [name, blocked]);

  return (
    <section className="add">
      <div className="init__row">
        <label htmlFor="add-branch">Add on top</label>
        <input
          id="add-branch"
          type="text"
          placeholder="feat/my-change"
          value={draft}
          disabled={!!blocked}
          title={blocked}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button type="button" onClick={submit} disabled={!!blocked || !name} title={blocked}>
          Add
        </button>
      </div>
      <p className="add__note">
        {blocked ? (
          blocked
        ) : name ? (
          <>
            <code>gh {addArgs(name).join(' ')}</code> — creates {name} on top of{' '}
            {top ?? 'the stack'}, or adopts it if it already exists. Adopting does not rebase;
            Restack offers that next.
          </>
        ) : (
          <>
            Goes on top of the stack — <code>gh stack add</code> only adds there. To put a branch
            further down, drag one in from Available.
          </>
        )}
      </p>
    </section>
  );
}
