import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { ChangesReader, parseCommitLog, parseNameStatus, parseStatus, readTips } from '../src/changes.ts';
import { commit, git, makeRepo } from './support/repo.ts';

/** Build the exact byte layout `git log --format=COMMIT_FORMAT --name-status -z` emits. */
function logBytes(
  commits: Array<{ sha: string; subject: string; files: string[] }>,
): string {
  return commits
    .map(
      (c) =>
        `@@${c.sha}\x1f${c.sha.slice(0, 7)}\x1f${c.subject}\x1fAda\x1f2 days ago\0` +
        (c.files.length ? `\n${c.files.join('\0')}\0` : ''),
    )
    .join('');
}

test('parses one commit and its files', () => {
  const commits = parseCommitLog(
    logBytes([{ sha: 'a'.repeat(40), subject: 'add route', files: ['M', 'src/api.ts', 'A', 'src/route.ts'] }]),
  );
  assert.equal(commits.length, 1);
  assert.equal(commits[0].sha, 'a'.repeat(40));
  assert.equal(commits[0].shortSha, 'aaaaaaa');
  assert.equal(commits[0].subject, 'add route');
  assert.equal(commits[0].author, 'Ada');
  assert.equal(commits[0].relativeDate, '2 days ago');
  assert.deepEqual(commits[0].files, [
    { status: 'M', path: 'src/api.ts' },
    { status: 'A', path: 'src/route.ts' },
  ]);
});

test('separates consecutive commits', () => {
  const commits = parseCommitLog(
    logBytes([
      { sha: 'a'.repeat(40), subject: 'second', files: ['M', 'b.txt'] },
      { sha: 'b'.repeat(40), subject: 'first', files: ['A', 'a.txt'] },
    ]),
  );
  assert.deepEqual(commits.map((c) => c.subject), ['second', 'first']);
  assert.deepEqual(commits.map((c) => c.files.length), [1, 1]);
});

test('reads a rename as three tokens and keeps the old path', () => {
  const commits = parseCommitLog(
    logBytes([{ sha: 'c'.repeat(40), subject: 'move it', files: ['R100', 'old.txt', 'new.txt'] }]),
  );
  assert.deepEqual(commits[0].files, [
    { status: 'R', path: 'new.txt', oldPath: 'old.txt' },
  ]);
});

test('does not mistake a path beginning with @@ for a header', () => {
  const commits = parseCommitLog(
    logBytes([{ sha: 'd'.repeat(40), subject: 'odd name', files: ['A', '@@weird.txt'] }]),
  );
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0].files, [{ status: 'A', path: '@@weird.txt' }]);
});

test('keeps paths containing a newline or a tab intact', () => {
  const commits = parseCommitLog(
    logBytes([{ sha: 'e'.repeat(40), subject: 'weird', files: ['A', 'a\nb.txt', 'M', 'c\td.txt'] }]),
  );
  assert.deepEqual(commits[0].files.map((f) => f.path), ['a\nb.txt', 'c\td.txt']);
});

test('tolerates a commit with no files (merge, or empty)', () => {
  const commits = parseCommitLog(
    logBytes([
      { sha: 'f'.repeat(40), subject: 'merge branch', files: [] },
      { sha: '1'.repeat(40), subject: 'real work', files: ['M', 'x.txt'] },
    ]),
  );
  assert.deepEqual(commits.map((c) => c.files.length), [0, 1]);
});

test('returns nothing for an empty range', () => {
  assert.deepEqual(parseCommitLog(''), []);
});

test('parseNameStatus reads a flat diff listing', () => {
  assert.deepEqual(parseNameStatus('M\0src/api.ts\0A\0src/route.ts\0'), [
    { status: 'M', path: 'src/api.ts' },
    { status: 'A', path: 'src/route.ts' },
  ]);
});

test('parseNameStatus keeps the old path of a rename', () => {
  assert.deepEqual(parseNameStatus('R100\0old.txt\0new.txt\0'), [
    { status: 'R', path: 'new.txt', oldPath: 'old.txt' },
  ]);
});

test('parseNameStatus returns nothing for an empty diff', () => {
  assert.deepEqual(parseNameStatus(''), []);
});

test('parseStatus splits staged from unstaged', () => {
  // "MM" = staged modification plus a further unstaged one to the same file.
  const groups = parseStatus('M  staged.ts\0 M unstaged.ts\0MM both.ts\0');
  assert.deepEqual(groups.staged, [
    { status: 'M', path: 'staged.ts' },
    { status: 'M', path: 'both.ts' },
  ]);
  assert.deepEqual(groups.unstaged, [
    { status: 'M', path: 'unstaged.ts' },
    { status: 'M', path: 'both.ts' },
  ]);
});

test('parseStatus collects untracked separately', () => {
  const groups = parseStatus('?? new.ts\0');
  assert.deepEqual(groups.untracked, ['new.ts']);
  assert.deepEqual(groups.staged, []);
  assert.deepEqual(groups.unstaged, []);
});

test('parseStatus reads a staged rename, new path first', () => {
  const groups = parseStatus('R  new.ts\0old.ts\0');
  assert.deepEqual(groups.staged, [{ status: 'R', path: 'new.ts', oldPath: 'old.ts' }]);
  assert.deepEqual(groups.unstaged, []);
});

test('parseStatus ignores an empty status output', () => {
  assert.deepEqual(parseStatus(''), { staged: [], unstaged: [], untracked: [] });
});

test('readTips returns every local branch head in one call', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const tips = await readTips(cwd);
  assert.deepEqual(
    [...tips.keys()].sort(),
    ['feat/api', 'feat/auth', 'feat/ui', 'main'],
  );
  assert.equal(tips.get('feat/ui'), git(cwd, 'rev-parse', 'feat/ui'));
});

test('branchChanges reports a branch’s own commits and files', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const base = git(cwd, 'rev-parse', 'feat/auth');
  const tip = git(cwd, 'rev-parse', 'feat/api');
  const changes = await new ChangesReader().branchChanges(cwd, 'feat/api', base, tip);

  assert.deepEqual(changes.commits.map((c) => c.subject), ['feat: add api routes']);
  assert.deepEqual(changes.commits[0].files, [{ status: 'A', path: 'api.txt' }]);
  assert.deepEqual(changes.files, [{ status: 'A', path: 'api.txt' }]);
  assert.equal(changes.branch, 'feat/api');
  assert.equal(changes.tip, tip);
});

test('branchChanges caches on base..tip and re-reads when the tip moves', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const reader = new ChangesReader();
  const base = git(cwd, 'rev-parse', 'feat/auth');
  const tip = git(cwd, 'rev-parse', 'feat/api');

  await reader.branchChanges(cwd, 'feat/api', base, tip);
  const afterFirst = reader.spawns;
  assert.ok(afterFirst > 0, 'first read should spawn');

  await reader.branchChanges(cwd, 'feat/api', base, tip);
  assert.equal(reader.spawns, afterFirst, 'second read should be served from cache');

  git(cwd, 'checkout', 'feat/api');
  commit(cwd, 'api2.txt', 'more\n', 'feat: more api');
  const movedTip = git(cwd, 'rev-parse', 'feat/api');
  const changes = await reader.branchChanges(cwd, 'feat/api', base, movedTip);
  assert.ok(reader.spawns > afterFirst, 'a moved tip should re-read');
  assert.equal(changes.commits.length, 2);
});

test('commitCounts counts each branch’s own commits', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const tips = await readTips(cwd);
  const counts = await new ChangesReader().commitCounts(
    cwd,
    [
      { name: 'feat/auth', base: git(cwd, 'rev-parse', 'main') },
      { name: 'feat/api', base: git(cwd, 'rev-parse', 'feat/auth') },
    ],
    tips,
  );
  assert.deepEqual(counts, { 'feat/auth': 1, 'feat/api': 1 });
});

test('commitCounts skips a branch with no known tip rather than throwing', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const counts = await new ChangesReader().commitCounts(
    cwd,
    [{ name: 'ghost', base: 'a'.repeat(40) }],
    new Map(),
  );
  assert.deepEqual(counts, {});
});

test('commitCounts omits a branch whose range does not resolve', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const tips = await readTips(cwd);
  // The tip exists; the base does not, so `rev-list --count` fails and there is
  // no honest number to report. Absent, not zero.
  const counts = await new ChangesReader().commitCounts(
    cwd,
    [{ name: 'feat/auth', base: 'd'.repeat(40) }],
    tips,
  );
  assert.deepEqual(counts, {});
});

test('workingTree reports staged, unstaged, and untracked separately', async (t) => {
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  writeFileSync(join(cwd, 'ui.txt'), 'edited\n');
  writeFileSync(join(cwd, 'staged.txt'), 'new\n');
  git(cwd, 'add', 'staged.txt');
  writeFileSync(join(cwd, 'loose.txt'), 'loose\n');

  const tree = await new ChangesReader().workingTree(cwd);
  assert.equal(tree.branch, 'feat/ui');
  assert.deepEqual(tree.staged, [{ status: 'A', path: 'staged.txt' }]);
  assert.deepEqual(tree.unstaged, [{ status: 'M', path: 'ui.txt' }]);
  assert.deepEqual(tree.untracked, ['loose.txt']);
});

test('workingTree on a clean repo is empty', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const tree = await new ChangesReader().workingTree(cwd);
  assert.deepEqual(tree.staged, []);
  assert.deepEqual(tree.unstaged, []);
  assert.deepEqual(tree.untracked, []);
});

test('prune forgets branches the stack no longer holds', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const reader = new ChangesReader();
  const base = git(cwd, 'rev-parse', 'feat/auth');
  const tip = git(cwd, 'rev-parse', 'feat/api');

  await reader.branchChanges(cwd, 'feat/api', base, tip);
  const afterFirst = reader.spawns;

  reader.prune(['feat/auth', 'feat/ui']);
  await reader.branchChanges(cwd, 'feat/api', base, tip);
  assert.ok(reader.spawns > afterFirst, 'a pruned branch should re-read');

  const afterSecond = reader.spawns;
  reader.prune(['feat/api']);
  await reader.branchChanges(cwd, 'feat/api', base, tip);
  assert.equal(reader.spawns, afterSecond, 'a kept branch stays cached');
});

test('commitCounts forgets ranges it was not asked for', async (t) => {
  const cwd = makeRepo();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const reader = new ChangesReader();
  const tips = await readTips(cwd);
  const main = git(cwd, 'rev-parse', 'main');
  const auth = git(cwd, 'rev-parse', 'feat/auth');

  await reader.commitCounts(cwd, [{ name: 'feat/auth', base: main }], tips);
  const afterFirst = reader.spawns;

  // A round that does not mention feat/auth evicts its entry, so the round
  // after that has to spawn again.
  await reader.commitCounts(cwd, [{ name: 'feat/api', base: auth }], tips);
  const afterSecond = reader.spawns;
  await reader.commitCounts(cwd, [{ name: 'feat/auth', base: main }], tips);
  assert.ok(reader.spawns > afterSecond, 'an evicted range should re-read');
  assert.ok(afterSecond > afterFirst);
});
