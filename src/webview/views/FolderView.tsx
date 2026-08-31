import type { StackResult } from '../../model';
import { Message } from '../components/primitives';
import { vscodeApi } from '../vscode';

/**
 * A multi-root workspace where Restack cannot tell which folder is meant.
 *
 * Not an error view: nothing is broken, there is simply more than one repository
 * open and no basis for guessing between them. The host has already tried — one
 * folder, a remembered choice, and a probe for `.git/gh-stack` all come first,
 * so reaching this means the ambiguity is real. See view/folder.ts.
 *
 * Borrows `.stacks__*` from the switcher rather than growing a stylesheet of its
 * own: name, path, one button is the same row, and styles.css is order-sensitive
 * enough that adding an import is the costlier change.
 */
export function FolderView({
  message,
  folders,
}: {
  message: string;
  folders: Extract<StackResult, { kind: 'pick-folder' }>['folders'];
}) {
  return (
    <div className="app">
      <Message title="Which folder?" body={message} />
      <ul className="stacks__list">
        {folders.map((folder, index) => (
          <li className="stacks__item" key={folder.path}>
            <span className="stacks__path" title={folder.path}>
              <strong>{folder.name}</strong>
              <br />
              {folder.path}
            </span>
            <button
              type="button"
              onClick={() => vscodeApi.postMessage({ type: 'selectFolder', index })}
            >
              Read this
            </button>
          </li>
        ))}
      </ul>
      <p className="stacks__hint">
        Remembered for this workspace. Change it later from <em>Restack: Select Folder…</em>.
      </p>
    </div>
  );
}
