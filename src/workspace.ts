/**
 * Which workspace folder Restack reads, as a rule with no `vscode` in it.
 *
 * Until now the answer was `workspaceFolders[0]`, in four separate places. In a
 * single-root window that is right and free; in a multi-root one it is a coin
 * toss that lands on whichever folder was added first, which is routinely the
 * docs or the config and not the repository with the stack in it.
 *
 * The rule is layered so the common case costs nothing: one folder answers
 * itself, a remembered choice answers itself, and only a genuinely ambiguous
 * window pays for a probe or has to ask. `view/folder.ts` binds it to the
 * workspace and to `workspaceState`.
 */

export type FolderResolution =
  /** Settled: this is the folder. */
  | { kind: 'folder'; id: string }
  /** Undecidable without knowing which folders hold stacks. Probe, then re-ask. */
  | { kind: 'probe' }
  /** Genuinely ambiguous. The user has to say. */
  | { kind: 'ask' }
  /** No folder is open at all. */
  | { kind: 'none' };

/**
 * The whole rule, over opaque folder ids.
 *
 * `withStacks` is the answer to "which of these hold a `.git/gh-stack`", and is
 * left undefined by a caller that has not run that probe yet — the `probe`
 * result is this function asking for it. Two calls rather than a callback, so
 * the rule stays testable without a filesystem and so the probe is skipped
 * entirely whenever an earlier layer already settled the question.
 */
export function chooseFolder(
  ids: readonly string[],
  stored: string | undefined,
  withStacks?: readonly string[],
): FolderResolution {
  if (ids.length === 0) {
    return { kind: 'none' };
  }
  // A single-root window is every window Restack has ever run in, and it must
  // stay exactly as cheap: no probe, no stored value, no question.
  if (ids.length === 1) {
    return { kind: 'folder', id: ids[0] };
  }
  if (stored !== undefined && ids.includes(stored)) {
    return { kind: 'folder', id: stored };
  }
  if (withStacks === undefined) {
    return { kind: 'probe' };
  }

  // Intersected rather than trusted: the probe is awaited, so it may describe
  // folders that have since been removed from the workspace.
  const present = ids.filter((id) => withStacks.includes(id));
  return present.length === 1 ? { kind: 'folder', id: present[0] } : { kind: 'ask' };
}
