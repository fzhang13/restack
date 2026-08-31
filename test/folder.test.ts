import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseFolder } from '../src/workspace.ts';

/**
 * The multi-root resolution rule. Pure over folder ids, so none of this needs a
 * workspace, a filesystem, or vscode — which is the reason the rule was pulled
 * out of the provider in the first place.
 */

const A = 'file:///code/a';
const B = 'file:///code/b';
const C = 'file:///code/c';

test('no folders open resolves to none', () => {
  assert.deepEqual(chooseFolder([], undefined), { kind: 'none' });
});

test('a single folder answers itself without a probe', () => {
  // The important part is `folder` rather than `probe`: every window Restack
  // has ever run in is this one, and it must not grow a git call.
  assert.deepEqual(chooseFolder([A], undefined), { kind: 'folder', id: A });
});

test('a single folder wins even against a stored choice for another', () => {
  assert.deepEqual(chooseFolder([A], B), { kind: 'folder', id: A });
});

test('a stored choice is honoured while it is still open', () => {
  assert.deepEqual(chooseFolder([A, B, C], B), { kind: 'folder', id: B });
});

test('a stored choice for a folder that has been removed is ignored', () => {
  assert.deepEqual(chooseFolder([A, C], B), { kind: 'probe' });
});

test('several folders with no stored choice ask for the probe', () => {
  assert.deepEqual(chooseFolder([A, B], undefined), { kind: 'probe' });
});

test('exactly one folder with a stack is picked automatically', () => {
  assert.deepEqual(chooseFolder([A, B, C], undefined, [B]), { kind: 'folder', id: B });
});

test('two folders with stacks is a real ambiguity, so it asks', () => {
  assert.deepEqual(chooseFolder([A, B, C], undefined, [A, C]), { kind: 'ask' });
});

test('no folder with a stack asks rather than guessing the first', () => {
  assert.deepEqual(chooseFolder([A, B], undefined, []), { kind: 'ask' });
});

test('a probe result naming a folder that has since closed does not count', () => {
  // The probe is awaited, so the workspace can change under it. B is the only
  // open folder with a stack; C left while the probe was running.
  assert.deepEqual(chooseFolder([A, B], undefined, [B, C]), { kind: 'folder', id: B });
  // And when the only probed folder is the one that left, there is nothing to
  // pick — it must ask rather than resolve to a closed folder.
  assert.deepEqual(chooseFolder([A, B], undefined, [C]), { kind: 'ask' });
});
