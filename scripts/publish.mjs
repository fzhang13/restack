// Publishes an already-built .vsix to both registries.
//
//   npm run publish                          # restack-<package.json version>.vsix
//   npm run publish -- ./some-build.vsix     # an explicit file, e.g. one
//                                            # downloaded from a CI release
//
// Both registries get the same bytes, and neither rebuilds: passing
// --packagePath skips vscode:prepublish, so what ships is what was packaged and
// tested rather than a fresh compile that nobody looked at. Cursor and the
// other forks cannot install from the Marketplace, so publishing to only one
// leaves half the audience on an old version — hence one command for both.
//
// Neither registry supports unpublishing. This script is deliberately not
// wired to CI; run it by hand once the release looks right.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

const vsix = process.argv[2] ?? `restack-${version}.vsix`;

if (!existsSync(vsix)) {
  console.error(`No such file: ${vsix}`);
  console.error('Build one with `npm run package`, or download it from the GitHub release.');
  process.exit(1);
}

// vsce reads VSCE_PAT, ovsx reads OVSX_PAT; both error clearly when unset, so
// there is nothing useful to add by checking here first.
for (const [registry, command] of [
  ['VS Code Marketplace', ['vsce', 'publish', '--packagePath', vsix]],
  ['Open VSX', ['ovsx', 'publish', '--packagePath', vsix]],
]) {
  console.log(`\n=== ${registry} ===`);
  // Marketplace first: if it rejects the version, Open VSX has not been
  // written to yet and the whole release can be retried after a bump.
  execFileSync('npx', command, { stdio: 'inherit' });
}

console.log(`\nPublished ${vsix} to both registries.`);
