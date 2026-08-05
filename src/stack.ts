import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cleanMessage, parseStack } from './parse.ts';
import type { StackResult } from './model.ts';

const execFileAsync = promisify(execFile);

/**
 * gh-stack exits 2 for both "not in a stack" and "not a git repository",
 * writing a non-JSON message to stderr. We disambiguate on the message text.
 */
const EXIT_NOT_APPLICABLE = 2;

/**
 * `branch %q belongs to multiple stacks; checkout a non-trunk branch first`.
 *
 * Its own exit code, and the normal resting position in a repository with more
 * than one stack: a trunk is shared by every stack based on it, so `main` is
 * ambiguous the moment a second stack exists. Not an error — there is simply no
 * single stack to report — so it lands on the same `no-stack` screen as an
 * unstacked branch, which is where the switcher offers the way out.
 */
const EXIT_AMBIGUOUS = 6;

interface ExecError extends Error {
  code?: number | string;
  stdout?: string;
  stderr?: string;
}

/**
 * Run `gh stack view --json` in `cwd` and map every failure mode onto a
 * StackResult the UI can render. Never rejects.
 */
export async function readStack(cwd: string, ghPath = 'gh'): Promise<StackResult> {
  let stdout: string;
  try {
    const result = await execFileAsync(ghPath, ['stack', 'view', '--json'], {
      cwd,
      // A stack of a few hundred branches stays far under this.
      maxBuffer: 8 * 1024 * 1024,
      timeout: 20_000,
    });
    stdout = result.stdout;
  } catch (err) {
    const e = err as ExecError;

    if (e.code === 'ENOENT') {
      return {
        kind: 'gh-missing',
        message: `Could not run "${ghPath}". Install the GitHub CLI, or set restack.ghPath.`,
      };
    }

    const stderr = cleanMessage(e.stderr ?? '');
    const combined = `${stderr} ${cleanMessage(e.stdout ?? '')}`.toLowerCase();

    // gh exits 1 with `unknown command "stack" for "gh"` on stderr. Its own
    // kind rather than gh-missing: gh is here and working, and the fix is one
    // command Restack can offer to run — see operations/setup.ts.
    if (combined.includes('unknown command') || combined.includes('not a gh command')) {
      return {
        kind: 'stack-missing',
        message: 'The gh CLI is installed, but the gh-stack extension is not.',
      };
    }

    if (e.code === EXIT_NOT_APPLICABLE) {
      if (combined.includes('not a git repository')) {
        return { kind: 'not-a-repo', message: stderr || 'Not a git repository.' };
      }
      if (combined.includes('not part of a stack')) {
        return { kind: 'no-stack', message: stderr || 'This branch is not part of a stack.' };
      }
    }

    // Matched on the message as well as the code, since an exit code alone is
    // a thin thing to hang a screen on across gh-stack versions.
    if (e.code === EXIT_AMBIGUOUS || combined.includes('belongs to multiple stacks')) {
      return {
        kind: 'no-stack',
        message: stderr || 'This branch belongs to more than one stack. Choose one below.',
      };
    }

    return { kind: 'error', message: stderr || e.message || 'Failed to read stack.' };
  }

  try {
    return { kind: 'ok', stack: parseStack(stdout) };
  } catch (err) {
    return {
      kind: 'error',
      message: err instanceof Error ? err.message : 'Failed to parse stack output.',
    };
  }
}

export { parseStack } from './parse.ts';
