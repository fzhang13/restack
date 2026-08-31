import { useEffect, useState } from 'react';
import type { BranchChanges, CommitSummary, FileChange, WorkingTree } from '../../model';
import { vscodeApi } from '../vscode';

/** The letter git uses, spelled out for the tooltip and the screen reader. */
const STATUS_LABEL: Record<string, string> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'type changed',
  U: 'unmerged',
};

function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

function FileRow({ file, onOpen }: { file: FileChange; onOpen?: () => void }) {
  const label = `${file.path} — ${statusLabel(file.status)}`;
  return (
    <li className="change__file">
      <button
        type="button"
        className="change__file-button"
        title={file.oldPath ? `${label} (from ${file.oldPath})` : label}
        aria-label={label}
        disabled={!onOpen}
        // The row above is a drag handle and a dblclick target; neither should
        // claim this click. Same treatment as CheckoutButton.
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onOpen?.();
        }}
      >
        <span className={`change__status change__status--${file.status}`} aria-hidden="true">
          {file.status}
        </span>
        <span className="change__path">{file.path}</span>
      </button>
    </li>
  );
}

function CommitRow({ commit }: { commit: CommitSummary }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="change__commit">
      <button
        type="button"
        className="change__commit-button"
        aria-expanded={open}
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <span className="change__twisty" aria-hidden="true">{open ? '▾' : '▸'}</span>
        <code className="change__sha">{commit.shortSha}</code>
        <span className="change__subject">{commit.subject}</span>
        <span className="change__meta">{commit.relativeDate}</span>
      </button>
      {open && (
        <ul className="change__files">
          {commit.files.length === 0 && <li className="change__empty">No file changes</li>}
          {commit.files.map((file) => (
            <FileRow
              key={`${file.status}:${file.path}`}
              file={file}
              onOpen={() =>
                vscodeApi.postMessage({
                  type: 'openCommitFile',
                  sha: commit.sha,
                  path: file.path,
                  oldPath: file.oldPath,
                })
              }
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * What one branch changed, under its row.
 *
 * `changes` is undefined until the host answers `loadChanges`, which is the
 * loading state rather than an empty one — a branch with genuinely no commits
 * arrives as an empty array and says so.
 *
 * Asking is this component's job, not the row's: it is the thing that renders
 * the answer, so it is the thing that can tell when it no longer has one.
 */
export function ChangeTree({
  branch,
  changes,
  changesEpoch,
  workingTree,
}: {
  branch: string;
  changes?: BranchChanges;
  /** Bumped by the host state whenever the cached changes are dropped. */
  changesEpoch: number;
  /** Only passed for the row HEAD is on. */
  workingTree?: WorkingTree | null;
}) {
  // Mounting is the open, so this covers expanding; the epoch covers a refresh
  // arriving while already open. Deliberately not keyed on `changes` — the
  // answer arriving must not ask the question again.
  useEffect(() => {
    vscodeApi.postMessage({ type: 'loadChanges', branch });
  }, [branch, changesEpoch]);

  const dirty =
    workingTree &&
    (workingTree.staged.length > 0 ||
      workingTree.unstaged.length > 0 ||
      workingTree.untracked.length > 0);

  return (
    <div className="change">
      {dirty && workingTree && (
        <div className="change__section">
          <div className="change__heading">Working tree</div>
          <ul className="change__files">
            {workingTree.staged.map((file) => (
              <FileRow
                key={`staged:${file.path}`}
                file={file}
                onOpen={() => vscodeApi.postMessage({ type: 'openWorkingFile', path: file.path })}
              />
            ))}
            {workingTree.unstaged.map((file) => (
              <FileRow
                key={`unstaged:${file.path}`}
                file={file}
                onOpen={() => vscodeApi.postMessage({ type: 'openWorkingFile', path: file.path })}
              />
            ))}
            {workingTree.untracked.map((path) => (
              <FileRow key={`untracked:${path}`} file={{ status: 'A', path }} />
            ))}
          </ul>
        </div>
      )}

      {!changes && <div className="change__empty">Reading…</div>}

      {changes && changes.commits.length === 0 && (
        <div className="change__empty">No commits of its own yet</div>
      )}

      {changes && changes.commits.length > 0 && (
        <>
          <div className="change__section">
            <div className="change__heading">
              {changes.files.length} file{changes.files.length === 1 ? '' : 's'} changed
            </div>
            <ul className="change__files">
              {changes.files.map((file) => (
                <FileRow
                  key={`all:${file.path}`}
                  file={file}
                  onOpen={() =>
                    vscodeApi.postMessage({
                      type: 'openCommitFile',
                      // This list is `base..tip`, so the left-hand side is the
                      // branch's base — the tip's parent would diff a file the
                      // tip did not touch against itself, and show nothing.
                      sha: changes.tip,
                      base: changes.base,
                      path: file.path,
                      oldPath: file.oldPath,
                    })
                  }
                />
              ))}
            </ul>
          </div>
          <ul className="change__commits">
            {changes.commits.map((commit) => (
              <CommitRow key={commit.sha} commit={commit} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
