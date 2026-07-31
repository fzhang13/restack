import { execFile } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * The one place a child process is spawned, and the one place they are logged.
 *
 * Extracted from apply.ts so remote.ts can run git without importing the apply
 * machinery — apply.ts needs remote.ts's tracking reads for its own preflight,
 * and the two importing each other would be a cycle. The alternative was a
 * second exec path, which is exactly what the comment on `run` warns against:
 * it would be a second thing to keep logging, and it would drift.
 *
 * candidates.ts still has its own unlogged helper. Left alone deliberately —
 * it runs a merge-base per branch on every refresh, and that volume in the
 * output channel would bury the commands a user actually wants to read.
 */

/**
 * Every child process runs with editors disabled. `git rebase --continue` opens
 * $EDITOR to confirm the commit message; from an extension host there is no
 * terminal attached, so it would block forever on a pipe nobody reads.
 * GIT_TERMINAL_PROMPT stops a credential prompt doing the same during push —
 * and during fetch, which is the first command here that can ask for one.
 */
const CHILD_ENV = {
  ...process.env,
  GIT_EDITOR: 'true',
  GIT_SEQUENCE_EDITOR: 'true',
  GIT_TERMINAL_PROMPT: '0',
};

export const LOCAL_TIMEOUT_MS = 60_000;
/** Push, submit, and fetch go over the network. */
export const REMOTE_TIMEOUT_MS = 180_000;

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface ExecError extends Error {
  code?: number | string;
  stdout?: string;
  stderr?: string;
}

export class ApplyError extends Error {}

/**
 * Sink for the full command log. Set by ApplyRunner so the module-level `run`
 * can report every child process without every call site threading a logger
 * through. The UI only ever shows the first stderr line; the rest lands here.
 */
let logSink: ((line: string) => void) | undefined;

export function setLogSink(sink: (line: string) => void): void {
  logSink = sink;
}

/**
 * Run a child process, mapping every failure to a code. Never rejects.
 *
 * Exported as `runCommand` from apply.ts too, so callers that already import it
 * from there keep working.
 */
export async function run(
  file: string,
  args: string[],
  cwd: string,
  timeout = LOCAL_TIMEOUT_MS,
): Promise<RunResult> {
  const started = Date.now();
  const result = await execute(file, args, cwd, timeout);

  if (logSink) {
    const ms = Date.now() - started;
    logSink(`$ ${file} ${args.join(' ')}  (exit ${result.code}, ${ms}ms)`);
    for (const stream of [result.stdout, result.stderr]) {
      const text = stream.trim();
      if (text) {
        logSink(text.split('\n').map((l) => `    ${l}`).join('\n'));
      }
    }
  }

  return result;
}

async function execute(
  file: string,
  args: string[],
  cwd: string,
  timeout: number,
): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      cwd,
      env: CHILD_ENV,
      timeout,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as ExecError;
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message ?? '',
    };
  }
}

export function firstLine(text: string): string {
  return text.trim().split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
}

/** Resolve `.git`, honouring worktrees and `.git`-as-a-file. */
export async function gitCommonDir(cwd: string): Promise<string> {
  const result = await run('git', ['rev-parse', '--git-common-dir'], cwd);
  if (result.code !== 0) {
    throw new ApplyError('Not a git repository.');
  }
  const dir = result.stdout.trim();
  return isAbsolute(dir) ? dir : join(cwd, dir);
}

/**
 * Whether there is anywhere to push. Checked before the confirmation modal so
 * a remote-less repository is never offered "Apply & Publish" — being refused
 * after choosing it costs the user the local reorder too, since preflight
 * blocks the whole apply rather than silently downgrading the scope.
 */
export async function hasOrigin(cwd: string): Promise<boolean> {
  const remote = await run('git', ['remote', 'get-url', 'origin'], cwd);
  return remote.code === 0;
}
