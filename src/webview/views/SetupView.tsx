import { installArgs } from '../../plan';
import { Message } from '../components/primitives';
import { vscodeApi } from '../vscode';

/**
 * The two states where Restack cannot start: no `gh`, or a `gh` that has never
 * heard of `stack`.
 *
 * One view rather than two because the shape is identical — a title, what went
 * wrong, and the way out — but the way out is not. A missing gh-stack is one
 * command Restack can run for you. A missing `gh` is not: installing it needs
 * the very CLI that is absent, so that half offers a link and the path setting
 * instead of a button that could only fail.
 */

/** Built from the same argv the host runs; see plan.ts. */
const INSTALL_COMMAND = `gh ${installArgs().join(' ')}`;

export function SetupView({
  kind,
  message,
}: {
  kind: 'gh-missing' | 'stack-missing';
  message: string;
}) {
  const refresh = () => vscodeApi.postMessage({ type: 'refresh' });

  if (kind === 'gh-missing') {
    return (
      <div className="app setup">
        <Message
          title="gh CLI not found"
          body={`${message} Restack runs every stack command through gh, so it needs the CLI on your PATH.`}
        />
        <div className="setup__actions">
          <button
            type="button"
            className="publish"
            onClick={() => vscodeApi.postMessage({ type: 'openUrl', url: 'https://cli.github.com/' })}
          >
            Get the gh CLI
          </button>
          {/* For a gh that is installed, just not anywhere Restack looked. */}
          <button type="button" onClick={() => vscodeApi.postMessage({ type: 'openGhPathSetting' })}>
            Set gh path
          </button>
          <button type="button" onClick={refresh}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app setup">
      <Message
        title="gh-stack is not installed"
        body="Restack is a UI for gh-stack — the gh CLI extension that owns the stack metadata. Install it to continue."
      />

      {/* The same preview-then-button shape as the init view, for the same
          reason: the command that is about to run is readable first. */}
      <div className="init__preview">
        <code>{INSTALL_COMMAND}</code>
        <span className="step__note">
          Downloads the extension from github/gh-stack. Requires an authenticated gh —
          run <code>gh auth login</code> first if you have not.
        </span>
      </div>

      <div className="setup__actions">
        <button
          type="button"
          className="publish"
          onClick={() => vscodeApi.postMessage({ type: 'installGhStack' })}
        >
          Install gh-stack
        </button>
        {/* copyPlan, not a clipboard call: the host owns the clipboard and
            already shows the "copied" toast for it. */}
        <button
          type="button"
          onClick={() => vscodeApi.postMessage({ type: 'copyPlan', text: INSTALL_COMMAND })}
        >
          Copy
        </button>
        <button type="button" onClick={refresh}>
          Retry
        </button>
      </div>
    </div>
  );
}
