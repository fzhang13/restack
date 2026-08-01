// Everything worth checking before an irreversible publish.
//
//   node scripts/preflight-publish.mjs <version> <path-to.vsix>
//
// Runs before the approval gate so the summary you approve is a verified one:
// if this exits non-zero, nobody is asked to approve anything. It has no side
// effects — it reads the .vsix and asks two public APIs what is already live.
//
// Neither registry lets you unpublish, so "is this version already there" is
// the check that matters most. Both fail on a duplicate, but the Marketplace
// error in particular reads as a permissions problem rather than a conflict,
// which is a bad thing to debug with half a release out the door.
//
// Writes a markdown summary to $GITHUB_STEP_SUMMARY when running in Actions.

import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const [version, vsixPath] = process.argv.slice(2);

if (!version || !vsixPath) {
  console.error('usage: node scripts/preflight-publish.mjs <version> <path-to.vsix>');
  process.exit(2);
}

const PUBLISHER = 'felixzhang';
const NAME = 'restack';

const problems = [];
const notes = [];

/** Fail the whole preflight, but keep going so one run reports every problem. */
const bad = (message) => problems.push(message);
const ok = (message) => notes.push(message);

// --- the artifact -----------------------------------------------------------

if (!existsSync(vsixPath)) {
  bad(`No .vsix at ${vsixPath}.`);
} else {
  // The .vsix is a zip; its extension/package.json is the version that will
  // actually land on the registries, whatever the tag or the input said.
  let manifest;
  try {
    manifest = JSON.parse(
      execFileSync('unzip', ['-p', vsixPath, 'extension/package.json'], {
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      }),
    );
  } catch {
    bad(`Could not read extension/package.json out of ${vsixPath} — is it a valid .vsix?`);
  }

  if (manifest) {
    if (manifest.version !== version) {
      bad(
        `The .vsix contains version ${manifest.version}, but this run is publishing ${version}. ` +
          `Publishing it would put ${manifest.version} on the registries under the wrong release.`,
      );
    } else {
      ok(`Artifact version ${manifest.version} matches.`);
    }

    if (manifest.publisher !== PUBLISHER) {
      bad(`The .vsix declares publisher "${manifest.publisher}", expected "${PUBLISHER}".`);
    }

    // Both registries reject a .vsix without these, after uploading it.
    for (const field of ['name', 'engines', 'main']) {
      if (!manifest[field]) bad(`The .vsix manifest is missing "${field}".`);
    }
  }

  // `unzip -Z1` lists bare entry names — `unzip -l` prints an "Archive: <path>"
  // header that matches any pattern the path itself matches.
  const entries = execFileSync('unzip', ['-Z1', vsixPath], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const strays = entries.filter((entry) =>
    /(^|\/)(release-notes\.md|CLAUDE\.md|\.env)$|\.vsix$|(^|\/)src\/|(^|\/)test\//.test(entry),
  );
  if (strays.length) {
    bad(`The .vsix contains files that should not ship: ${strays.join(', ')}`);
  } else {
    ok(`No stray files (${entries.length} entries).`);
  }
}

// --- what is already live ---------------------------------------------------

/** Open VSX answers 404 for a version that does not exist, 200 for one that does. */
async function openVsxHas(v) {
  const res = await fetch(`https://open-vsx.org/api/${PUBLISHER}/${NAME}/${v}`);
  if (res.status === 404) return false;
  if (res.ok) return true;
  throw new Error(`Open VSX answered ${res.status}`);
}

/** The gallery API has no per-version endpoint; ask for all of them. */
async function marketplaceVersions() {
  const res = await fetch(
    'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery',
    {
      method: 'POST',
      headers: {
        Accept: 'application/json;api-version=3.0-preview.1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filters: [{ criteria: [{ filterType: 7, value: `${PUBLISHER}.${NAME}` }] }],
        flags: 914,
      }),
    },
  );
  if (!res.ok) throw new Error(`Marketplace answered ${res.status}`);
  const body = await res.json();
  const extension = body.results?.[0]?.extensions?.[0];
  return extension ? extension.versions.map((entry) => entry.version) : [];
}

// A registry being unreachable is not a reason to publish blind — the whole
// point of the preflight is that the summary is trustworthy.
try {
  const live = await marketplaceVersions();
  if (live.includes(version)) {
    bad(`${version} is already on the VS Code Marketplace. It cannot be replaced or unpublished.`);
  } else {
    ok(`Marketplace is at ${live[0] ?? 'nothing published'}; ${version} is new.`);
  }
} catch (error) {
  bad(`Could not check the Marketplace: ${error.message}`);
}

try {
  if (await openVsxHas(version)) {
    bad(`${version} is already on Open VSX. It cannot be replaced or unpublished.`);
  } else {
    ok(`Open VSX does not have ${version} yet.`);
  }
} catch (error) {
  bad(`Could not check Open VSX: ${error.message}`);
}

// --- credentials ------------------------------------------------------------

// Checked here rather than at publish time so an expired token fails before
// anyone is asked to approve, instead of halfway through the release.
for (const name of ['VSCE_PAT', 'OVSX_PAT']) {
  if (!process.env[name]?.trim()) {
    bad(`${name} is empty or unset. Add it as an environment secret on the "publish" environment.`);
  } else {
    ok(`${name} is present.`);
  }
}

// --- report -----------------------------------------------------------------

const summary = [
  `## Publish preflight — ${version}`,
  '',
  ...notes.map((line) => `- ✅ ${line}`),
  ...problems.map((line) => `- ❌ ${line}`),
  '',
  problems.length
    ? `**${problems.length} problem(s). Nothing was published.**`
    : `**Ready.** Approve the \`publish\` environment to send ${version} to both registries.`,
].join('\n');

console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
}

process.exit(problems.length ? 1 : 0);
