import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyStackFailure } from '../src/stack.ts';

/**
 * How a failed `gh stack view --json` becomes a screen.
 *
 * Every case here is a real stderr from gh-stack v0.1.0, pasted verbatim
 * including the `✗` it prefixes them with. The classification is pure so it can
 * be tested without `gh`: the tests never shell out to it, and the exit codes
 * and wordings are exactly the pre-1.0 detail most likely to drift.
 */

test('gh itself is missing', () => {
  const result = classifyStackFailure({ code: 'ENOENT' }, 'gh');
  assert.equal(result.kind, 'gh-missing');
  assert.match(result.message, /Could not run "gh"/);
});

test('the ghPath setting is named in the gh-missing message', () => {
  const result = classifyStackFailure({ code: 'ENOENT' }, '/opt/homebrew/bin/gh');
  assert.equal(result.kind, 'gh-missing');
  assert.match(result.message, /\/opt\/homebrew\/bin\/gh/);
});

test('gh runs but has no stack command', () => {
  const result = classifyStackFailure({
    code: 1,
    stderr: 'unknown command "stack" for "gh"',
  });
  assert.equal(result.kind, 'stack-missing');
});

test('not a git repository', () => {
  const result = classifyStackFailure({
    code: 2,
    stderr: '✗ not a git repository',
  });
  assert.equal(result.kind, 'not-a-repo');
  assert.equal(result.message, 'not a git repository', 'the ✗ is stripped');
});

test('a branch outside any stack is an entry point, not an error', () => {
  const result = classifyStackFailure({
    code: 2,
    stderr: '✗ current branch "main" is not part of a stack',
  });
  assert.equal(result.kind, 'no-stack');
});

test('a branch in more than one stack asks rather than fails', () => {
  const result = classifyStackFailure({
    code: 6,
    stderr: '✗ branch "main" belongs to multiple stacks; checkout a non-trunk branch first',
  });
  assert.equal(result.kind, 'no-stack');
});

// The case this whole kind exists for. A rebase that stopped on a conflict
// leaves HEAD detached, gh-stack cannot name a branch, and routing that to the
// generic `error` screen put a dead end over a conflict the user was mid-way
// through resolving.
test('a detached HEAD is its own kind, not a generic error', () => {
  const result = classifyStackFailure({
    code: 2,
    stderr: '✗ failed to get current branch: failed to run git: not on any branch',
  });
  assert.equal(result.kind, 'detached-head');
});

test('anything else is still a generic error', () => {
  const result = classifyStackFailure({
    code: 1,
    stderr: '✗ something nobody has seen before',
  });
  assert.equal(result.kind, 'error');
  assert.equal(result.message, 'something nobody has seen before');
});

test('a failure with no output at all still produces a message', () => {
  const result = classifyStackFailure({ code: 1, message: 'Command failed' });
  assert.equal(result.kind, 'error');
  assert.equal(result.message, 'Command failed');
});
