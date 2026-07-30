import type { Stack, StackBranch } from './model.ts';

/**
 * Pure parsing of `gh stack view --json` output.
 *
 * Deliberately free of Node imports so the webview and browser test harness
 * can share this exact code with the extension host. Process spawning lives
 * in stack.ts.
 */

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asBool(value: unknown): boolean {
  return value === true;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Strip gh's ✗/✓ prefix and surrounding whitespace from a CLI message. */
export function cleanMessage(raw: string): string {
  return raw.replace(/^[\s✗✓●]+/u, '').trim();
}

/**
 * Parse `gh stack view --json` output.
 *
 * Tolerant by design — gh-stack is v0.1.0 and its schema will drift. A branch
 * is usable as long as it has a name; every other field degrades to a default
 * rather than throwing, so a field rename downgrades the UI instead of
 * breaking it. Throws only when the payload has no recognizable branch list.
 */
export function parseStack(raw: string): Stack {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('gh stack view --json did not return valid JSON');
  }

  if (typeof data !== 'object' || data === null) {
    throw new Error('Unexpected JSON shape from gh stack view --json');
  }

  const record = data as Record<string, unknown>;

  // v0.1.0 emits a single stack object. Accept a {stacks:[...]} envelope too,
  // since that shape appears in the CLI's own internals and may surface later.
  const container = Array.isArray(record.stacks)
    ? ((record.stacks[0] ?? {}) as Record<string, unknown>)
    : record;

  const rawBranches = container.branches;
  if (!Array.isArray(rawBranches)) {
    throw new Error('No branches found in gh stack view --json output');
  }

  const branches: StackBranch[] = [];
  for (const entry of rawBranches) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const b = entry as Record<string, unknown>;
    const name = asString(b.name) ?? asString(b.branch) ?? asString(b.headRefName);
    if (!name) {
      continue; // Unidentifiable branch: skip rather than render a blank row.
    }
    branches.push({
      name,
      base: asString(b.base) ?? asString(b.baseRefName) ?? '',
      isCurrent: asBool(b.isCurrent),
      isMerged: asBool(b.isMerged),
      isQueued: asBool(b.isQueued),
      needsRebase: asBool(b.needsRebase),
      prNumber: asNumber(b.number) ?? asNumber(b.prNumber),
      prUrl: asString(b.url),
      prTitle: asString(b.title),
      prState: asString(b.state),
      isDraft: asBool(b.draft),
    });
  }

  return {
    trunk: asString(container.trunk) ?? 'main',
    currentBranch: asString(container.currentBranch),
    branches,
  };
}
