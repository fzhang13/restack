import { useEffect, useState } from 'react';
import type { BranchChanges, CommitSummary, FileChange } from '../../model';
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

export function FileRow({
  file,
  onOpen,
  action,
}: {
  file: FileChange;
  onOpen?: () => void;
  /** A stage/unstage button on the right. Only the working-tree lists pass one. */
  action?: { label: string; title: string; disabled?: boolean; onClick: () => void };
}) {
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
      {action && (
        <button
          type="button"
          className="change__action"
          title={action.title}
          aria-label={action.title}
          disabled={action.disabled}
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            action.onClick();
          }}
        >
          {action.label}
        </button>
      )}
    </li>
  );
}

function CommitRow({
  commit,
  branch,
  canAmend,
}: {
  commit: CommitSummary;
  /** The branch this commit belongs to — what the amend plan is anchored on. */
  branch: string;
  /** False when there is nothing staged; reword is still offered. */
  canAmend: boolean;
}) {
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
      <span className="commit__actions">
        <button
          type="button"
          className="change__action"
          title={
            canAmend
              ? `Fold what is staged into ${commit.shortSha}, then replay the branches above it`
              : 'Stage something to fold in first'
          }
          aria-label={`Amend ${commit.shortSha}`}
          disabled={!canAmend}
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            vscodeApi.postMessage({
              type: 'amend',
              branch,
              sha: commit.sha,
              subject: commit.subject,
            });
          }}
        >
          ⤵
        </button>
        <button
          type="button"
          className="change__action"
          title={`Reword ${commit.shortSha}. Content is untouched; the branches above are replayed.`}
          aria-label={`Reword ${commit.shortSha}`}
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            vscodeApi.postMessage({
              type: 'amend',
              branch,
              sha: commit.sha,
              subject: commit.subject,
              reword: true,
            });
          }}
        >
          ✎
        </button>
      </span>
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
  hasStaged = false,
}: {
  branch: string;
  changes?: BranchChanges;
  /** Bumped by the host state whenever the cached changes are dropped. */
  changesEpoch: number;
  /** True when the index holds something an amend could fold in. */
  hasStaged?: boolean;
}) {
  // Mounting is the open, so this covers expanding; the epoch covers a refresh
  // arriving while already open. Deliberately not keyed on `changes` — the
  // answer arriving must not ask the question again.
  useEffect(() => {
    vscodeApi.postMessage({ type: 'loadChanges', branch });
  }, [branch, changesEpoch]);

  // No working-tree list here any more: WorkingTreePanel renders it once,
  // pinned above the columns. There is one working tree, not one per branch,
  // and showing it in both places listed the same files twice.
  return (
    <div className="change">
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
              <CommitRow key={commit.sha} commit={commit} branch={branch} canAmend={hasStaged} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
