// Confirms both tokens can actually publish, before either one is used.
//
//   node scripts/verify-pats.mjs
//
// Runs inside the gated publish job rather than the preflight, because
// VSCE_PAT and OVSX_PAT are environment secrets on `publish` and GitHub only
// exposes those to a job that declares that environment. The preflight runs
// before the gate on purpose, so it cannot see them — and a job that could
// would have to ask for approval before doing any checking.
//
// This asks each registry whether the token has publish rights, which a
// non-empty-string check cannot do: an expired PAT, one scoped to the wrong
// Azure DevOps organization, or one pasted with a stray newline all look fine
// as strings and all fail at publish time. Failing here costs nothing; failing
// after the Marketplace has accepted the upload leaves a permanent version
// live and Open VSX behind.

import { execFileSync } from 'node:child_process';

const PUBLISHER = 'felixzhang';

const checks = [
  {
    registry: 'VS Code Marketplace',
    variable: 'VSCE_PAT',
    argv: ['vsce', 'verify-pat', PUBLISHER],
    hint:
      'Regenerate at dev.azure.com with Marketplace -> Manage, "All accessible organizations". ' +
      'A PAT scoped to a single organization authenticates but cannot publish.',
  },
  {
    registry: 'Open VSX',
    variable: 'OVSX_PAT',
    argv: ['ovsx', 'verify-pat', PUBLISHER],
    hint: 'Regenerate at open-vsx.org/user-settings/tokens. The publisher agreement must be signed.',
  },
];

const problems = [];
const notes = [];

for (const { registry, variable, argv, hint } of checks) {
  // vsce and ovsx each read their own variable, but an unset one surfaces as a
  // confusing auth error rather than a missing-credential one.
  if (!process.env[variable]?.trim()) {
    problems.push(
      `${variable} is empty or unset. It must be an environment secret on the "publish" environment ` +
        '— a repository secret is not visible to this job.',
    );
    continue;
  }

  try {
    execFileSync('npx', argv, { stdio: 'pipe', encoding: 'utf8' });
    notes.push(`${variable} can publish ${PUBLISHER} to the ${registry}.`);
  } catch (error) {
    // Drop Node's own warnings — a TLS or deprecation notice is not the reason
    // the token failed, and it crowds out the line that is.
    const detail = `${error.stderr ?? ''}${error.stdout ?? ''}`
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !/^\(node:\d+\)|^\(Use `node/.test(line))
      .slice(0, 3)
      .join(' ');
    problems.push(`${variable} cannot publish to the ${registry}. ${detail || error.message} ${hint}`);
  }
}

const summary = [
  '## Credentials',
  '',
  ...notes.map((line) => `- ✅ ${line}`),
  ...problems.map((line) => `- ❌ ${line}`),
  '',
  problems.length
    ? `**${problems.length} problem(s). Nothing was published.**`
    : '**Both tokens verified.**',
].join('\n');

console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
}

process.exit(problems.length ? 1 : 0);
