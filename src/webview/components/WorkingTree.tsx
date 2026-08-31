import { useState, type ReactNode } from 'react';
import type { WorkingTree } from '../../model';
import { vscodeApi } from '../vscode';
import { FileRow } from './ChangeTree';

/**
 * Uncommitted work, pinned above the columns and always open.
 *
 * Not nested under the HEAD branch row, which is where Release 1 put it. There
 * is one working tree, not one per branch, and burying the live half of the
 * panel behind a twisty is what made it invisible in practice — the feature
 * shipped in 0.7.0 and people did not find it.
 *
 * Renders nothing at all when the tree is clean. An empty section pinned above
 * the stack would cost a permanent three lines to say "nothing here", and the
 * clean case is the one the reorder view is designed around.
 */
export function WorkingTreePanel({
  workingTree,
  busy,
}: {
  workingTree: WorkingTree | null;
  busy: boolean;
}) {
  const [message, setMessage] = useState('');

  if (!workingTree) {
    return null;
  }

  const { staged, unstaged, untracked, head } = workingTree;
  if (staged.length === 0 && unstaged.length === 0 && untracked.length === 0) {
    return null;
  }

  const post = (m: Parameters<typeof vscodeApi.postMessage>[0]) => vscodeApi.postMessage(m);
  const canCommit = !busy && staged.length > 0 && message.trim().length > 0;

  return (
    <section className="wt">
      <div className="wt__head">
        <span className="wt__title">Working tree</span>
        {workingTree.branch && <span className="wt__branch">{workingTree.branch}</span>}
        <span className="wt__spacer" />
        <button
          type="button"
          className="wt__link"
          disabled={busy || (unstaged.length === 0 && untracked.length === 0)}
          onClick={() => post({ type: 'stage', paths: [] })}
          title="git add -A"
        >
          Stage all
        </button>
        <button
          type="button"
          className="wt__link"
          disabled={busy || staged.length === 0}
          onClick={() => post({ type: 'unstage', paths: [] })}
          title="git restore --staged ."
        >
          Unstage all
        </button>
      </div>

      {staged.length > 0 && (
        <Group title="Staged">
          {staged.map((file) => (
            <FileRow
              key={`staged:${file.path}`}
              file={file}
              onOpen={() => post({ type: 'openWorkingFile', path: file.path })}
              action={{
                label: '−',
                title: `Unstage ${file.path}`,
                disabled: busy,
                onClick: () => post({ type: 'unstage', paths: [file.path] }),
              }}
            />
          ))}
        </Group>
      )}

      {unstaged.length > 0 && (
        <Group title="Changes">
          {unstaged.map((file) => (
            <FileRow
              key={`unstaged:${file.path}`}
              file={file}
              onOpen={() => post({ type: 'openWorkingFile', path: file.path })}
              action={{
                label: '+',
                title: `Stage ${file.path}`,
                disabled: busy,
                onClick: () => post({ type: 'stage', paths: [file.path] }),
              }}
            />
          ))}
        </Group>
      )}

      {untracked.length > 0 && (
        <Group title="Untracked">
          {untracked.map((path) => (
            // No onOpen: there is no committed side to put beside it.
            <FileRow
              key={`untracked:${path}`}
              file={{ status: 'A', path }}
              action={{
                label: '+',
                title: `Stage ${path}`,
                disabled: busy,
                onClick: () => post({ type: 'stage', paths: [path] }),
              }}
            />
          ))}
        </Group>
      )}

      <textarea
        className="wt__message"
        rows={2}
        placeholder="Commit message"
        value={message}
        disabled={busy}
        onChange={(event) => setMessage(event.target.value)}
        onKeyDown={(event) => {
          // The SCM view's binding, and the one people reach for.
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && canCommit) {
            post({ type: 'commit', message });
            setMessage('');
          }
        }}
      />

      <div className="wt__actions">
        <button
          type="button"
          className="wt__commit"
          disabled={!canCommit}
          onClick={() => {
            post({ type: 'commit', message });
            setMessage('');
          }}
          title={
            staged.length === 0
              ? 'Stage something first — a commit here never sweeps up unstaged edits'
              : 'git commit -m …'
          }
        >
          Commit
        </button>
        {head && (
          <button
            type="button"
            className="wt__amend"
            disabled={busy || staged.length === 0 || !workingTree.branch}
            onClick={() =>
              post({
                type: 'amend',
                branch: workingTree.branch!,
                sha: head.sha,
                subject: head.subject,
              })
            }
            title={`Fold what is staged into ${head.shortSha} “${head.subject}”, then replay the branches above it`}
          >
            Amend {head.shortSha}
          </button>
        )}
      </div>
    </section>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="wt__group">
      <div className="wt__heading">{title}</div>
      <ul className="wt__files">{children}</ul>
    </div>
  );
}
