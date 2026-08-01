// Prints one version's section of CHANGELOG.md, for use as GitHub Release notes.
//
//   node scripts/changelog-section.mjs 0.5.1
//
// Exits non-zero if the version has no section, so a release workflow fails
// loudly rather than publishing an empty release. Headings are `## X.Y.Z` with
// nothing after the number; the section runs to the next `## ` or end of file.

import { readFileSync } from 'node:fs';

const version = process.argv[2];
if (!version) {
  console.error('usage: node scripts/changelog-section.mjs <version>');
  process.exit(2);
}

const lines = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8').split('\n');

// `## ` and exactly the version, so `0.5.1` does not match `0.5.10`.
const start = lines.findIndex((line) => line.trim() === `## ${version}`);
if (start === -1) {
  console.error(`CHANGELOG.md has no "## ${version}" section.`);
  process.exit(1);
}

let end = lines.length;
for (let i = start + 1; i < lines.length; i++) {
  if (lines[i].startsWith('## ')) {
    end = i;
    break;
  }
}

// Drop the heading itself — the release is already titled with the version —
// and any blank lines at either edge.
const body = lines.slice(start + 1, end).join('\n').trim();
if (!body) {
  console.error(`The "## ${version}" section of CHANGELOG.md is empty.`);
  process.exit(1);
}

console.log(body);
