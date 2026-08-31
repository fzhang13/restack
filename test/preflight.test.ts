import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { amendPreflight, hasOrigin, preflight } from '../src/apply.ts';
import {
  ORDER,
  colleague,
  commit,
  git,
  makeRemoteRepo,
  makeRepo,
  readStackFrom,
} from './support/repo.ts';

/**
 * Everything preflight refuses, and why. Each of these is a state where
 * applying would either destroy work or leave the stack describing an order
 * the refs no longer have.
 */

test('preflight refuses a dirty tree', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  writeFileSync(join(cwd, 'README.md'), 'uncommitted edit\n');
  const blocked = await preflight(cwd, readStackFrom(cwd), 'local');
  // Rebasing over uncommitted work can destroy changes no snapshot holds.
  assert.match(blocked ?? '', /uncommitted changes/);
});

test('preflight refuses a merged branch and a missing remote', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const stack = readStackFrom(cwd);
  assert.match((await preflight(cwd, stack, 'publish')) ?? '', /No `origin` remote/);

  stack.branches[0].isMerged = true;
  assert.match((await preflight(cwd, stack, 'local')) ?? '', /merged branches/);
});

// The UI hides "Apply & Publish" on this answer, so a false negative would
// strand a user with a real remote on local-only applies.
test('hasOrigin distinguishes a remote-less repo from one with origin', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  assert.equal(await hasOrigin(cwd), false);

  execFileSync('git', ['remote', 'add', 'origin', 'https://example.invalid/x.git'], { cwd });
  assert.equal(await hasOrigin(cwd), true);
});

test('preflight refuses when gh-stack metadata is absent', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const stack = readStackFrom(cwd);
  rmSync(join(cwd, '.git', 'gh-stack'));

  // Without it, rebasing would leave the stack describing an order the refs
  // no longer have, and nothing could put that right.
  const blocked = await preflight(cwd, stack, 'local');
  assert.match(blocked ?? '', /No \.git\/gh-stack/);
});

test('preflight refuses a branch that does not exist or is unrelated', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const stack = readStackFrom(cwd);

  // A missing ref would otherwise fail mid-cascade, after earlier branches
  // had already been rewritten.
  assert.match(
    (await preflight(cwd, stack, 'local', [...ORDER, 'ghost'])) ?? '',
    /ghost does not exist locally/,
  );

  // An orphan shares no history with trunk, so there is nothing to replay.
  git(cwd, 'checkout', '--orphan', 'orphan');
  git(cwd, 'rm', '-rf', '--cached', '.');
  commit(cwd, 'orphan.txt', 'orphan\n', 'orphan root');
  // `rm --cached` left the stack's files untracked, which would block the way
  // back out of the orphan branch.
  git(cwd, 'clean', '-fd');
  git(cwd, 'checkout', 'feat/ui');
  assert.match(
    (await preflight(cwd, stack, 'local', [...ORDER, 'orphan'])) ?? '',
    /shares no history/,
  );
});

test('preflight refuses to rewrite a branch that is behind its upstream', async (t) => {
  const { cwd, origin } = makeRemoteRepo();
  const them = colleague(origin);
  t.after(() => [cwd, origin, them].forEach((d) => rmSync(d, { recursive: true, force: true })));

  // Someone else pushes to a branch in our stack.
  git(them, 'checkout', 'feat/api');
  commit(them, 'theirs.txt', 'theirs\n', 'feat: their work');
  git(them, 'push', 'origin', 'feat/api');

  // Until we fetch, nothing here knows: the remote-tracking ref is stale and
  // an apply would happily proceed.
  assert.equal(await preflight(cwd, readStackFrom(cwd), 'local'), undefined);

  git(cwd, 'fetch', 'origin');

  // Now it is refusable, and refused. `gh stack push` force-pushes with a
  // lease against that ref — once it is current, the lease is satisfied and
  // their commit is overwritten with no warning at all.
  const blocked = await preflight(cwd, readStackFrom(cwd), 'local');
  assert.match(blocked ?? '', /feat\/api is 1 behind origin\/feat\/api/);
  assert.match(blocked ?? '', /force-pushes/);
});

test('preflight allows a branch whose upstream was deleted', async (t) => {
  const { cwd, origin } = makeRemoteRepo();
  t.after(() => [cwd, origin].forEach((d) => rmSync(d, { recursive: true, force: true })));

  // The ordinary aftermath of a merged PR: the branch is gone from the remote
  // but the local upstream config remains. Refusing here would block every
  // stack that had ever landed a branch.
  git(cwd, 'push', 'origin', '--delete', 'feat/auth');
  git(cwd, 'fetch', '--prune', 'origin');

  assert.equal(await preflight(cwd, readStackFrom(cwd), 'local'), undefined);
});

test('preflight ignores branches outside the order being applied', async (t) => {
  const { cwd, origin } = makeRemoteRepo();
  const them = colleague(origin);
  t.after(() => [cwd, origin, them].forEach((d) => rmSync(d, { recursive: true, force: true })));

  // A branch that is behind but is *not* being rewritten is not a hazard —
  // only the branches this apply force-pushes matter.
  git(them, 'checkout', '-b', 'unrelated', 'main');
  commit(them, 'other.txt', 'other\n', 'chore: unrelated');
  git(them, 'push', 'origin', 'unrelated');
  git(cwd, 'fetch', 'origin');
  git(cwd, 'branch', '--track', 'unrelated', 'origin/unrelated');
  git(them, 'push', 'origin', 'HEAD:unrelated', '--force');
  commit(them, 'other.txt', 'more\n', 'chore: more');
  git(them, 'push', 'origin', 'unrelated');
  git(cwd, 'fetch', 'origin');

  assert.equal(await preflight(cwd, readStackFrom(cwd), 'local', ORDER), undefined);
  assert.match(
    (await preflight(cwd, readStackFrom(cwd), 'local', [...ORDER, 'unrelated'])) ?? '',
    /unrelated is 1 behind origin\/unrelated/,
  );
});

test('amendPreflight refuses when there is nothing to fold', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const stack = readStackFrom(cwd);
  const target = { branch: 'feat/api', sha: git(cwd, 'rev-parse', 'feat/api'), subject: 'feat: add api routes' };

  const refusal = await amendPreflight(cwd, stack, target, 'local', {});
  assert.match(refusal ?? '', /nothing to fold/i);
});

test('amendPreflight refuses a tree that is both staged and unstaged', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const stack = readStackFrom(cwd);
  git(cwd, 'checkout', 'feat/api');
  const target = { branch: 'feat/api', sha: git(cwd, 'rev-parse', 'feat/api'), subject: 'feat: add api routes' };

  writeFileSync(join(cwd, 'api.txt'), 'staged\n');
  git(cwd, 'add', 'api.txt');
  writeFileSync(join(cwd, 'api.txt'), 'staged, then edited again\n');

  const refusal = await amendPreflight(cwd, stack, target, 'local', {});
  assert.match(refusal ?? '', /both staged and unstaged/i);
});

test('amendPreflight allows a merged branch below the target', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const stack = readStackFrom(cwd);
  stack.branches[0].isMerged = true;
  git(cwd, 'checkout', 'feat/api');
  const target = { branch: 'feat/api', sha: git(cwd, 'rev-parse', 'feat/api'), subject: 'feat: add api routes' };
  writeFileSync(join(cwd, 'api.txt'), 'edited\n');
  git(cwd, 'add', 'api.txt');

  assert.equal(await amendPreflight(cwd, stack, target, 'local', {}), undefined);
});

test('amendPreflight refuses a merged branch at or above the target', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const stack = readStackFrom(cwd);
  stack.branches[2].isMerged = true;
  git(cwd, 'checkout', 'feat/api');
  const target = { branch: 'feat/api', sha: git(cwd, 'rev-parse', 'feat/api'), subject: 'feat: add api routes' };
  writeFileSync(join(cwd, 'api.txt'), 'edited\n');
  git(cwd, 'add', 'api.txt');

  const refusal = await amendPreflight(cwd, stack, target, 'local', {});
  assert.match(refusal ?? '', /feat\/ui/);
});

test('amendPreflight refuses a reword whose subject is ambiguous', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  git(cwd, 'checkout', 'feat/api');
  commit(cwd, 'api2.txt', 'more\n', 'feat: add api routes');
  const stack = readStackFrom(cwd);
  const target = {
    branch: 'feat/api',
    sha: git(cwd, 'rev-parse', 'feat/api'),
    subject: 'feat: add api routes',
  };

  const refusal = await amendPreflight(cwd, stack, target, 'local', {
    message: 'feat: add api routes, properly',
  });
  assert.match(refusal ?? '', /more than one commit/i);
});
