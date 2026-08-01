import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApplyRunner } from '../../src/apply.ts';
import type { ApplyProgress, CandidateBranch, Stack } from '../../src/model.ts';

/**
 * Repository fixtures for the apply suites.
 *
 * These build real repositories on disk. The whole point of apply.ts is what
 * git actually does with a mid-stack rebase, and a mocked git would only ever
 * confirm what we already believed.
 *
 * Deliberately not named `*.test.ts`: `npm test` globs that pattern, and a
 * fixture module with no tests in it would be reported as an empty file.
 */

export const ORDER = ['feat/auth', 'feat/api', 'feat/ui'];

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_EDITOR: 'true' },
  }).trim();
}

export function commit(cwd: string, file: string, body: string, message: string): void {
  writeFileSync(join(cwd, file), body);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-m', message);
}

/**
 * A three-branch stack on main, with the `.git/gh-stack` file gh-stack would
 * have written. `sharedFile` puts every branch on the same file so their
 * commits collide when reordered.
 */
export function makeRepo(options: { sharedFile?: boolean } = {}): string {
  const cwd = mkdtempSync(join(tmpdir(), 'restack-'));
  git(cwd, 'init', '-b', 'main');
  git(cwd, 'config', 'user.email', 'test@example.com');
  git(cwd, 'config', 'user.name', 'Restack Test');
  git(cwd, 'config', 'commit.gpgsign', 'false');

  commit(cwd, 'README.md', 'base\n', 'init');
  const trunkHead = git(cwd, 'rev-parse', 'HEAD');

  const target = (n: string) => (options.sharedFile ? 'shared.txt' : `${n}.txt`);

  git(cwd, 'checkout', '-b', 'feat/auth');
  commit(cwd, target('auth'), 'auth\n', 'feat: add auth layer');
  const authTip = git(cwd, 'rev-parse', 'HEAD');

  git(cwd, 'checkout', '-b', 'feat/api');
  commit(cwd, target('api'), 'api\n', 'feat: add api routes');
  const apiTip = git(cwd, 'rev-parse', 'HEAD');

  git(cwd, 'checkout', '-b', 'feat/ui');
  commit(cwd, target('ui'), 'ui\n', 'feat: add ui components');

  writeFileSync(
    join(cwd, '.git', 'gh-stack'),
    JSON.stringify(
      {
        schemaVersion: 1,
        repository: '',
        stacks: [
          {
            trunk: { branch: 'main', head: trunkHead },
            branches: [
              { branch: 'feat/auth', base: trunkHead },
              { branch: 'feat/api', base: authTip },
              { branch: 'feat/ui', base: apiTip },
            ],
          },
        ],
      },
      null,
      2,
    ),
  );

  git(cwd, 'checkout', 'feat/ui');
  return cwd;
}

/** The Stack shape `gh stack view --json` would produce for makeRepo(). */
export function readStackFrom(cwd: string): Stack {
  const meta = JSON.parse(readFileSync(join(cwd, '.git', 'gh-stack'), 'utf8'));
  const entries = meta.stacks[0].branches as Array<{ branch: string; base: string }>;
  return {
    trunk: 'main',
    currentBranch: git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD'),
    branches: entries.map((e) => ({
      name: e.branch,
      base: e.base,
      isCurrent: false,
      isMerged: false,
      isQueued: false,
      needsRebase: false,
    })),
  };
}

export function metadataOrder(cwd: string): string[] {
  const meta = JSON.parse(readFileSync(join(cwd, '.git', 'gh-stack'), 'utf8'));
  return meta.stacks[0].branches.map((b: { branch: string }) => b.branch);
}

/** Commits unique to `branch`, oldest last, as `git log --oneline main..branch`. */
export function commitsOn(cwd: string, branch: string): string[] {
  const out = git(cwd, 'log', '--format=%s', `main..${branch}`);
  return out ? out.split('\n') : [];
}

export function collect(): { runner: ApplyRunner; states: ApplyProgress[] } {
  const states: ApplyProgress[] = [];
  return { runner: new ApplyRunner((p) => states.push(p)), states };
}

/** Branch off trunk with one commit, as a tray candidate would be. */
export function addLooseBranch(cwd: string, name: string, file: string): CandidateBranch {
  const head = git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD');
  git(cwd, 'checkout', 'main');
  git(cwd, 'checkout', '-b', name);
  commit(cwd, file, `${name}\n`, `feat: add ${name}`);
  git(cwd, 'checkout', head);
  return {
    name,
    base: git(cwd, 'merge-base', name, 'main'),
    commitCount: 1,
  };
}

/**
 * The state `gh stack init` leaves behind when it adopts existing branches:
 * they are recorded in stack order, each based on trunk, but never rebased
 * onto each other. Verified against gh-stack v0.1.0, which reports the upper
 * branches as `needsRebase` and otherwise leaves them alone.
 */
export function makeAdoptedRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'restack-adopt-'));
  git(cwd, 'init', '-b', 'main');
  git(cwd, 'config', 'user.email', 'test@example.com');
  git(cwd, 'config', 'user.name', 'Restack Test');
  git(cwd, 'config', 'commit.gpgsign', 'false');

  commit(cwd, 'README.md', 'base\n', 'init');
  const trunkHead = git(cwd, 'rev-parse', 'HEAD');

  // Every branch off trunk, in parallel — none is on the one below it.
  for (const name of ORDER) {
    git(cwd, 'checkout', 'main');
    git(cwd, 'checkout', '-b', name);
    commit(cwd, `${name.replace(/\//g, '-')}.txt`, `${name}\n`, `feat: ${name}`);
  }

  writeFileSync(
    join(cwd, '.git', 'gh-stack'),
    JSON.stringify(
      {
        schemaVersion: 1,
        repository: '',
        stacks: [
          {
            trunk: { branch: 'main', head: trunkHead },
            branches: ORDER.map((branch) => ({ branch, base: trunkHead })),
          },
        ],
      },
      null,
      2,
    ),
  );

  git(cwd, 'checkout', ORDER.at(-1)!);
  return cwd;
}

/**
 * The same stack, plus a bare origin every branch tracks.
 *
 * Returns both paths: the tests using it simulate a colleague by committing
 * directly into a second clone and pushing, which is the only way to produce
 * the state that matters — a remote-tracking ref we are behind.
 */
export function makeRemoteRepo(): { cwd: string; origin: string } {
  const cwd = makeRepo();
  const origin = mkdtempSync(join(tmpdir(), 'restack-origin-'));
  git(origin, 'init', '--bare', '-b', 'main');

  git(cwd, 'remote', 'add', 'origin', origin);
  git(cwd, 'push', '-u', 'origin', 'main', ...ORDER);
  return { cwd, origin };
}

/** A second clone, standing in for whoever else pushes to these branches. */
export function colleague(origin: string): string {
  const cwd = mkdtempSync(join(tmpdir(), 'restack-them-'));
  git(cwd, 'clone', origin, cwd);
  git(cwd, 'config', 'user.email', 'them@example.com');
  git(cwd, 'config', 'user.name', 'Someone Else');
  git(cwd, 'config', 'commit.gpgsign', 'false');
  return cwd;
}
