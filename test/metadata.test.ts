import test from 'node:test';
import assert from 'node:assert/strict';
import { basesForOrder, findStackIndex, rewriteMetadata } from '../src/metadata.ts';

/**
 * Shaped after a real `.git/gh-stack` written by gh-stack v0.1.0, with an extra
 * unknown key on one branch to stand in for schema drift.
 */
const TRUNK = 'e8b166db59ec2581e8b1abf16c2275c1642edc6a';
const AUTH_TIP = 'e58893c2d6f609311212506db1ce13be63ed7369';
const API_TIP = '8a901f9f253f8e2a1ee5529ff342cc90c241c985';

function fixture(): string {
  return JSON.stringify(
    {
      schemaVersion: 1,
      repository: '',
      stacks: [
        {
          trunk: { branch: 'main', head: TRUNK },
          branches: [
            { branch: 'feat/auth', base: TRUNK },
            { branch: 'feat/api', base: AUTH_TIP, futureField: 'keep me' },
            { branch: 'feat/ui', base: API_TIP },
          ],
        },
      ],
    },
    null,
    2,
  );
}

const NEW_TRUNK = 'a'.repeat(40);
const NEW_API = 'b'.repeat(40);
const NEW_UI = 'c'.repeat(40);

test('reorders branches and rewrites each base to its new parent tip', () => {
  const out = JSON.parse(
    rewriteMetadata(fixture(), {
      trunk: 'main',
      trunkHead: NEW_TRUNK,
      branches: [
        { branch: 'feat/api', base: NEW_TRUNK },
        { branch: 'feat/ui', base: NEW_API },
        { branch: 'feat/auth', base: NEW_UI },
      ],
    }),
  );

  const branches = out.stacks[0].branches;
  assert.deepEqual(
    branches.map((b: { branch: string }) => b.branch),
    ['feat/api', 'feat/ui', 'feat/auth'],
  );
  // Bottom branch sits on trunk; each one above sits on the tip below it.
  assert.deepEqual(
    branches.map((b: { base: string }) => b.base),
    [NEW_TRUNK, NEW_API, NEW_UI],
  );
  assert.equal(out.stacks[0].trunk.head, NEW_TRUNK);
});

test('carries unknown fields through the rewrite', () => {
  const out = JSON.parse(
    rewriteMetadata(fixture(), {
      trunk: 'main',
      trunkHead: NEW_TRUNK,
      branches: [
        { branch: 'feat/api', base: NEW_TRUNK },
        { branch: 'feat/ui', base: NEW_API },
        { branch: 'feat/auth', base: NEW_UI },
      ],
    }),
  );

  // gh-stack is pre-1.0; a field we have never seen must survive us.
  const api = out.stacks[0].branches.find((b: { branch: string }) => b.branch === 'feat/api');
  assert.equal(api.futureField, 'keep me');
  assert.equal(out.repository, '');
  assert.equal(out.schemaVersion, 1);
});

test('matches gh-stack’s own formatting so the diff shows only the reorder', () => {
  const raw = fixture();
  const out = rewriteMetadata(raw, {
    trunk: 'main',
    trunkHead: TRUNK,
    branches: [
      { branch: 'feat/auth', base: TRUNK },
      { branch: 'feat/api', base: AUTH_TIP },
      { branch: 'feat/ui', base: API_TIP },
    ],
  });

  // 2-space indent, no trailing newline — an identity rewrite is byte-identical
  // apart from the key order we control.
  assert.ok(!out.endsWith('\n'));
  assert.match(out, /\n {2}"repository"/);
  assert.deepEqual(JSON.parse(out), JSON.parse(raw));
});

test('refuses an unrecognized schemaVersion instead of guessing', () => {
  const bumped = JSON.stringify({ ...JSON.parse(fixture()), schemaVersion: 2 });
  assert.throws(
    () =>
      rewriteMetadata(bumped, {
        trunk: 'main',
        trunkHead: TRUNK,
        branches: [{ branch: 'feat/auth', base: TRUNK }],
      }),
    /schemaVersion 2/,
  );
});

test('refuses malformed JSON rather than overwriting it', () => {
  assert.throws(
    () =>
      rewriteMetadata('{not json', {
        trunk: 'main',
        trunkHead: TRUNK,
        branches: [{ branch: 'feat/auth', base: TRUNK }],
      }),
    /not valid JSON/,
  );
});

test('refuses when no stack matches the branch set', () => {
  assert.throws(
    () =>
      rewriteMetadata(fixture(), {
        trunk: 'main',
        trunkHead: TRUNK,
        branches: [{ branch: 'feat/unknown', base: TRUNK }],
      }),
    /Could not find this stack/,
  );
});

test('stack lookup requires an exact set, not a subset', () => {
  const stacks = [
    { branches: [{ branch: 'a' }, { branch: 'b' }, { branch: 'c' }] },
    { branches: [{ branch: 'a' }, { branch: 'b' }] },
  ];
  // A subset match would rewrite the wrong stack whenever names overlap.
  assert.equal(findStackIndex(stacks, ['a', 'b']), 1);
  assert.equal(findStackIndex(stacks, ['a', 'b', 'c']), 0);
  assert.equal(findStackIndex(stacks, ['a']), -1);
});

test('`match` finds the stack by the names on disk while writing a new set', () => {
  const NEW_SPIKE = 'd'.repeat(40);
  // spike joins the stack. The written set is four names; the file still holds
  // three, so without `match` the lookup could not find the stack at all.
  const out = JSON.parse(
    rewriteMetadata(fixture(), {
      trunk: 'main',
      trunkHead: NEW_TRUNK,
      branches: [
        { branch: 'feat/auth', base: NEW_TRUNK },
        { branch: 'spike', base: NEW_UI },
        { branch: 'feat/api', base: NEW_SPIKE },
        { branch: 'feat/ui', base: NEW_API },
      ],
      match: ['feat/auth', 'feat/api', 'feat/ui'],
    }),
  );

  assert.deepEqual(
    out.stacks[0].branches.map((b: { branch: string }) => b.branch),
    ['feat/auth', 'spike', 'feat/api', 'feat/ui'],
  );
  // Unknown keys on branches that were already there still survive.
  const api = out.stacks[0].branches.find((b: { branch: string }) => b.branch === 'feat/api');
  assert.equal(api.futureField, 'keep me');
});

test('`match` also covers a branch leaving the stack', () => {
  const out = JSON.parse(
    rewriteMetadata(fixture(), {
      trunk: 'main',
      trunkHead: NEW_TRUNK,
      branches: [
        { branch: 'feat/auth', base: NEW_TRUNK },
        { branch: 'feat/ui', base: NEW_API },
      ],
      match: ['feat/auth', 'feat/api', 'feat/ui'],
    }),
  );

  assert.deepEqual(
    out.stacks[0].branches.map((b: { branch: string }) => b.branch),
    ['feat/auth', 'feat/ui'],
  );
});

test('`match` still requires an exact set — a wrong one refuses', () => {
  // The safety property the default relies on has to hold for `match` too,
  // or a mistyped set could rewrite a different stack that shares names.
  assert.throws(
    () =>
      rewriteMetadata(fixture(), {
        trunk: 'main',
        trunkHead: NEW_TRUNK,
        branches: [{ branch: 'feat/auth', base: NEW_TRUNK }],
        match: ['feat/auth', 'feat/api'],
      }),
    /Could not find this stack/,
  );
});

test('basesForOrder chains each branch onto the tip below it', () => {
  const tips = new Map([
    ['feat/api', NEW_API],
    ['feat/ui', NEW_UI],
  ]);
  assert.deepEqual(basesForOrder(['feat/api', 'feat/ui', 'feat/auth'], NEW_TRUNK, (b) => tips.get(b)), [
    { branch: 'feat/api', base: NEW_TRUNK },
    { branch: 'feat/ui', base: NEW_API },
    { branch: 'feat/auth', base: NEW_UI },
  ]);
});

test('basesForOrder throws when a tip is unresolved', () => {
  assert.throws(
    () => basesForOrder(['a', 'b'], NEW_TRUNK, () => undefined),
    /Could not resolve the new tip of a/,
  );
});
