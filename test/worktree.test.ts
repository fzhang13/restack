import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stagePaths, unstagePaths } from '../src/worktree.ts';
import { git, makeRepo } from './support/repo.ts';

test('stagePaths stages exactly the named files', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, 'ui.txt'), 'edited\n');
  writeFileSync(join(cwd, 'new.txt'), 'new\n');

  await stagePaths(cwd, ['ui.txt']);

  assert.equal(git(cwd, 'diff', '--cached', '--name-only'), 'ui.txt');
});

test('stagePaths with no paths stages everything, including untracked', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, 'ui.txt'), 'edited\n');
  writeFileSync(join(cwd, 'new.txt'), 'new\n');

  await stagePaths(cwd, []);

  assert.deepEqual(git(cwd, 'diff', '--cached', '--name-only').split('\n').sort(), [
    'new.txt',
    'ui.txt',
  ]);
});

test('unstagePaths leaves the edit in the working tree', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, 'ui.txt'), 'edited\n');
  git(cwd, 'add', 'ui.txt');

  await unstagePaths(cwd, ['ui.txt']);

  assert.equal(git(cwd, 'diff', '--cached', '--name-only'), '');
  assert.equal(git(cwd, 'diff', '--name-only'), 'ui.txt');
});

test('unstagePaths handles a file that is newly added', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, 'new.txt'), 'new\n');
  git(cwd, 'add', 'new.txt');

  await unstagePaths(cwd, ['new.txt']);

  assert.equal(git(cwd, 'diff', '--cached', '--name-only'), '');
  assert.match(git(cwd, 'status', '--porcelain'), /\?\? new\.txt/);
});
