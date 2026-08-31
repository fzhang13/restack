import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stashPush, stashRestore, stashSelector } from '../src/stash.ts';
import { commit, git, makeRepo } from './support/repo.ts';

/**
 * Real repositories, for the same reason remote.test.ts uses them: every claim
 * here is about what a specific git command does to the stash stack, and a
 * mocked git would only confirm the behaviour this file already assumes.
 */

function dirty(cwd: string, file = 'README.md', body = 'edited\n'): void {
  writeFileSync(join(cwd, file), body);
}

function read(cwd: string, file: string): string {
  return readFileSync(join(cwd, file), 'utf8');
}

test('stashPush puts tracked changes aside and stashRestore brings them back', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  dirty(cwd);
  const pushed = await stashPush(cwd, 'restack: test');
  assert.equal(pushed.kind, 'stashed');
  // The point of stashing at all: the tree is clean enough to check out.
  assert.equal(git(cwd, 'status', '--porcelain', '--untracked-files=no'), '');

  const restored = await stashRestore(cwd, pushed.kind === 'stashed' ? pushed.sha : '');
  assert.deepEqual(restored, { kind: 'restored' });
  assert.equal(read(cwd, 'README.md'), 'edited\n');
  assert.equal(git(cwd, 'stash', 'list'), '');
});

test('stashPush reports a clean tree rather than inventing an entry', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  // `git stash push` with nothing to save exits 0 and creates nothing, so the
  // exit code cannot be what this is read from.
  assert.deepEqual(await stashPush(cwd, 'restack: test'), { kind: 'clean' });
  assert.equal(git(cwd, 'stash', 'list'), '');
});

test('stashPush leaves untracked files alone', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  dirty(cwd);
  writeFileSync(join(cwd, 'scratch.txt'), 'not yours\n');
  const pushed = await stashPush(cwd, 'restack: test');
  assert.equal(pushed.kind, 'stashed');

  // Untracked files never trigger a refusal, so stashing them would be taking
  // something Restack never asked the user to deal with.
  assert.equal(read(cwd, 'scratch.txt'), 'not yours\n');
});

test('stashRestore finds its entry by sha after the stack has shifted', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  dirty(cwd, 'README.md', 'ours\n');
  const pushed = await stashPush(cwd, 'restack: test');
  assert.equal(pushed.kind, 'stashed');
  const sha = pushed.kind === 'stashed' ? pushed.sha : '';

  // Someone stashes in a terminal. Ours is now stash@{1}, and anything that
  // popped stash@{0} would restore their work instead of ours.
  dirty(cwd, 'README.md', 'theirs\n');
  git(cwd, 'stash', 'push', '--message', 'their work');
  assert.equal(await stashSelector(cwd, sha), 'stash@{1}');

  assert.deepEqual(await stashRestore(cwd, sha), { kind: 'restored' });
  assert.equal(read(cwd, 'README.md'), 'ours\n');
  // Theirs is untouched and still stashed.
  assert.match(git(cwd, 'stash', 'list'), /their work/);
});

test('stashRestore reports a conflicting pop and leaves the entry in place', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  dirty(cwd, 'README.md', 'stashed edit\n');
  const pushed = await stashPush(cwd, 'restack: test');
  const sha = pushed.kind === 'stashed' ? pushed.sha : '';

  // The same line moves underneath the stash, which is what a rebase does.
  commit(cwd, 'README.md', 'committed edit\n', 'chore: touch the same line');

  const restored = await stashRestore(cwd, sha);
  assert.equal(restored.kind, 'conflict');
  // The one reassurance the message can offer: nothing was dropped.
  assert.match(git(cwd, 'stash', 'list'), /restack: test/);
  assert.equal(restored.kind === 'conflict' ? restored.selector : '', 'stash@{0}');
});

test('stashRestore reports a vanished entry instead of throwing', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  dirty(cwd);
  const pushed = await stashPush(cwd, 'restack: test');
  const sha = pushed.kind === 'stashed' ? pushed.sha : '';

  // The user got there first. A window reload can put a long gap between the
  // push and the pop, so this is not hypothetical.
  git(cwd, 'stash', 'drop');

  assert.deepEqual(await stashRestore(cwd, sha), { kind: 'missing' });
  assert.equal(await stashSelector(cwd, sha), undefined);
});

test('a stash survives the checkout it was taken for', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  git(cwd, 'checkout', 'feat/auth');
  dirty(cwd, 'README.md', 'work in progress\n');

  const pushed = await stashPush(cwd, 'restack: switching branches');
  assert.equal(pushed.kind, 'stashed');
  git(cwd, 'checkout', 'feat/ui');
  assert.deepEqual(await stashRestore(cwd, pushed.kind === 'stashed' ? pushed.sha : ''), {
    kind: 'restored',
  });

  // The whole promise of the offer: same edit, different branch.
  assert.equal(read(cwd, 'README.md'), 'work in progress\n');
  assert.equal(git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feat/ui');
});
