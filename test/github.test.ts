import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { emptyGraph, parseGraph } from '../src/github.ts';

/**
 * Pure parsing, against a response recorded from the live API.
 *
 * The opposite choice from remote.test.ts, and for the opposite reason. Those
 * functions are claims about what a git format string emits, so they are tested
 * against real repositories — a mock would only confirm the assumption. These
 * are claims about a remote service that no test can pin down at all, so what
 * is worth testing is the parsing: that a real payload yields the right shape,
 * and that every way it can be wrong yields an empty graph instead of a throw.
 *
 * `fixtures/github-graph.json` is `gh api graphql` output from `cli/cli`,
 * captured July 2026 and trimmed to seven pull requests — four in one stack,
 * three in none.
 */

const REAL = readFileSync(join(import.meta.dirname, '..', 'fixtures', 'github-graph.json'), 'utf8');

/** A response document wrapping `nodes`. */
function response(nodes: unknown[], pageInfo?: unknown): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequests: { pageInfo: pageInfo ?? { hasNextPage: false, endCursor: null }, nodes },
      },
    },
  });
}

test('a real response yields every PR keyed by head ref', () => {
  const graph = parseGraph(REAL);

  assert.equal(graph.supported, true);
  assert.equal(graph.prs.size, 7);

  const bottom = graph.prs.get('williammartin-fix-restwithnext-error-type');
  assert.equal(bottom?.number, 13988);
  assert.equal(bottom?.baseRefName, 'trunk');
  assert.equal(bottom?.stackNumber, 14025);
  assert.equal(bottom?.stackSize, 5);
  // gh reports states uppercase; the webview keys CSS off them lowercased,
  // exactly as readPullRequests has always done.
  assert.equal(bottom?.state, 'open');
});

test('a real response yields the stack once, entries bottom-to-top', () => {
  const graph = parseGraph(REAL);

  // Four PRs report the same stack; it is one stack, not four.
  assert.equal(graph.stacks.size, 1);

  const stack = graph.stacks.get(14025);
  assert.equal(stack?.size, 5);
  assert.equal(stack?.baseRefName, 'trunk');
  assert.deepEqual(
    stack?.entries.map((e) => e.position),
    [1, 2, 3, 4, 5],
  );
  // Position 1 is the bottom — the one whose base is the trunk — matching the
  // direction `Stack.branches` and `LocalStackSummary.branches` run in.
  assert.equal(stack?.entries[0].headRefName, 'williammartin-fix-restwithnext-error-type');
  assert.equal(stack?.entries[0].number, 13988);
});

test('a PR in no stack contributes to the index and no stack', () => {
  const graph = parseGraph(
    response([
      { number: 1, headRefName: 'solo', baseRefName: 'main', state: 'OPEN', stack: null },
    ]),
  );

  assert.equal(graph.prs.get('solo')?.stackNumber, undefined);
  assert.equal(graph.stacks.size, 0);
});

test('entries out of order are sorted by position', () => {
  const graph = parseGraph(
    response([
      {
        number: 1,
        headRefName: 'top',
        state: 'OPEN',
        stack: {
          number: 9,
          size: 2,
          baseRefName: 'main',
          entries: {
            totalCount: 2,
            nodes: [
              { position: 2, pullRequest: { number: 1, headRefName: 'top', state: 'OPEN' } },
              { position: 1, pullRequest: { number: 2, headRefName: 'bottom', state: 'OPEN' } },
            ],
          },
        },
      },
    ]),
  );

  assert.deepEqual(
    graph.stacks.get(9)?.entries.map((e) => e.headRefName),
    ['bottom', 'top'],
  );
});

test('a stack longer than the query asked for is recorded as truncated', () => {
  // Silent truncation would read as "this is the whole stack" when it is not.
  const graph = parseGraph(
    response([
      {
        number: 1,
        headRefName: 'a',
        state: 'OPEN',
        stack: {
          number: 9,
          size: 80,
          baseRefName: 'main',
          entries: {
            totalCount: 80,
            nodes: [{ position: 1, pullRequest: { number: 1, headRefName: 'a', state: 'OPEN' } }],
          },
        },
      },
    ]),
  );

  assert.deepEqual(graph.truncated, [9]);
  // The stack is still usable — `size` reports what GitHub counted, not what
  // fit in the response.
  assert.equal(graph.stacks.get(9)?.size, 80);
});

test('an API with no stack field is unsupported, not empty', () => {
  // The GHES case. Distinguished from an empty result so the caller falls back
  // to `gh pr list` rather than silently losing the PR badges Restack has
  // always shown. This is the exact body `gh api graphql` printed when asked
  // for a field that does not exist.
  const raw = JSON.stringify({
    errors: [
      {
        path: ['query', 'repository', 'pullRequests', 'nodes', 'stack'],
        extensions: { code: 'undefinedField', typeName: 'PullRequest', fieldName: 'stack' },
        message: "Field 'stack' doesn't exist on type 'PullRequest'",
      },
    ],
  });

  assert.equal(parseGraph(raw).supported, false);
});

test('an unrelated error is not mistaken for an unsupported API', () => {
  // Rate limiting and permission failures must not send the caller down the
  // fallback path forever — they are transient, and `gh pr list` would fail too.
  const raw = JSON.stringify({
    data: { repository: null },
    errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }],
  });

  const graph = parseGraph(raw);

  assert.equal(graph.supported, true);
  assert.equal(graph.prs.size, 0);
});

test('the newest PR wins when a branch has had several', () => {
  // GitHub returns newest first; the same first-wins rule readPullRequests uses.
  const graph = parseGraph(
    response([
      { number: 12, headRefName: 'feat/auth', state: 'OPEN' },
      { number: 3, headRefName: 'feat/auth', state: 'CLOSED' },
    ]),
  );

  assert.equal(graph.prs.get('feat/auth')?.number, 12);
});

test('nodes missing a branch or number are skipped, not thrown on', () => {
  const graph = parseGraph(
    response([null, 'nonsense', { headRefName: 'nameless' }, { number: 4 }, { number: 5, headRefName: 'ok' }]),
  );

  assert.equal(graph.prs.size, 1);
  assert.equal(graph.prs.get('ok')?.number, 5);
  // Absent optional fields become empty strings, matching readPullRequests —
  // the webview renders them directly.
  assert.equal(graph.prs.get('ok')?.url, '');
});

test('a malformed stack degrades to no stack, keeping the PR', () => {
  const graph = parseGraph(
    response([
      { number: 1, headRefName: 'a', state: 'OPEN', stack: { size: 2, entries: null } },
      { number: 2, headRefName: 'b', state: 'OPEN', stack: 'not an object' },
    ]),
  );

  assert.equal(graph.prs.size, 2);
  assert.equal(graph.stacks.size, 0);
});

test('an entry missing its pull request is skipped, keeping the rest', () => {
  const graph = parseGraph(
    response([
      {
        number: 1,
        headRefName: 'a',
        state: 'OPEN',
        stack: {
          number: 9,
          size: 2,
          baseRefName: 'main',
          entries: {
            totalCount: 2,
            nodes: [
              { position: 1, pullRequest: null },
              { position: 2, pullRequest: { number: 1, headRefName: 'a', state: 'OPEN' } },
            ],
          },
        },
      },
    ]),
  );

  assert.deepEqual(
    graph.stacks.get(9)?.entries.map((e) => e.headRefName),
    ['a'],
  );
});

test('every unparseable body yields an empty graph rather than throwing', () => {
  // `gh` printing an auth error, a proxy returning HTML, an empty stdout on a
  // timeout — none of these are worth an error state in a stack switcher.
  for (const raw of ['', 'not json', 'null', '[]', '{}', '{"data":null}', 'gh: not logged in']) {
    const graph = parseGraph(raw);
    assert.equal(graph.prs.size, 0, raw);
    assert.equal(graph.stacks.size, 0, raw);
    assert.equal(graph.supported, true, raw);
  }
});

test('the cursor is reported only when there is another page', () => {
  assert.equal(parseGraph(response([], { hasNextPage: true, endCursor: 'abc' })).nextCursor, 'abc');
  assert.equal(parseGraph(response([], { hasNextPage: false, endCursor: 'abc' })).nextCursor, undefined);
  // A cursor-less last page is what GitHub actually returns.
  assert.equal(parseGraph(response([], { hasNextPage: true, endCursor: null })).nextCursor, undefined);
});

test('an empty graph is empty and supported', () => {
  const graph = emptyGraph();

  assert.equal(graph.prs.size, 0);
  assert.equal(graph.stacks.size, 0);
  assert.deepEqual(graph.truncated, []);
  // True, not false: "we learned nothing" must not be read as "this server
  // cannot do stacks", which would pin the caller to the fallback path.
  assert.equal(graph.supported, true);
});
