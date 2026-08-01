/**
 * Render what reading GitHub adds, to media/screenshot-github.png.
 *
 * Same discipline as the other four: the real webview bundle through
 * test/harness/index.html, so the image cannot drift from the UI. The scene is
 * `?view=github` — the multi-stack repository again, but with the three things
 * only the GraphQL read can know: a stack number shared with GitHub, a stack
 * that gained a PR on the server, and one that exists there and nowhere here.
 *
 * The switcher is opened by script for build-switcher-screenshot.mjs's reason:
 * collapsed is the right default and a screenshot of a collapsed disclosure is
 * a screenshot of a line of text.
 *
 * Run via `npm run media`, after the bundle and the harness driver are built.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, copyFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// Taller than every other shot, because the subject is spread down the screen
// rather than gathered in one control: stack numbers and drift in the switcher,
// the "On GitHub only" block below it, and the `PR base` badge further down in
// the Current column. Cutting any of the three would need a fourth screenshot.
const WIDTH = 460;
const HEIGHT = 560;

const work = mkdtempSync(join(tmpdir(), 'restack-shot-github-'));

const html = readFileSync(join(root, 'test', 'harness', 'index.html'), 'utf8')
  .replaceAll('../../dist/', `file://${join(root, 'dist')}/`)
  .replaceAll('./driver.js', `file://${join(root, 'test', 'harness', 'driver.js')}`)
  .replace('#frame { width: 420px; border: 1px solid #333; }', '#frame { width: 420px; }')
  .replace('<body>', '<body style="padding:16px">');

const script = `
<script>
  addEventListener('load', () => setTimeout(() => {
    const header = document.querySelector('.switcher__header');
    if (!header) return;
    header.click();
    // The focus ring is an artifact of driving this by script; a reader would
    // have clicked, and the ring reads as a selected state that is not one.
    header.blur();
  }, 300));
</script>`;

writeFileSync(join(work, 'shot.html'), html.replace('</body>', `${script}</body>`));

execFileSync(
  CHROME,
  [
    '--headless',
    '--disable-gpu',
    '--hide-scrollbars',
    '--allow-file-access-from-files',
    '--force-device-scale-factor=2',
    '--virtual-time-budget=4000',
    `--screenshot=${join(work, 'shot.png')}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    `file://${join(work, 'shot.html')}?view=github`,
  ],
  { stdio: 'ignore' },
);

copyFileSync(join(work, 'shot.png'), join(here, 'screenshot-github.png'));
rmSync(work, { recursive: true, force: true });
console.log('media/screenshot-github.png written');
