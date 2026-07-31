/**
 * Render the remote-aware stack view to media/screenshot-remote.png.
 *
 * Same discipline as the other two: the real webview bundle through
 * test/harness/index.html, so the image cannot drift from the UI. The scene is
 * `?view=behind` — the trunk has moved under the stack — which is the one that
 * shows the whole remote story at once: the Fetch button, the ahead/behind
 * pills, and the sync banner offering to replay onto the new tip.
 *
 * No scripted gesture here, unlike the other two. The state *is* the subject,
 * so there is nothing to drive; the driver posts it on load.
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

// Shorter than the reorder shot: no plan panel, since nothing has been dragged.
// The banner and the two columns are the whole frame — cut just below the trunk
// row, so the frame ends on the `↓3` that the banner above is talking about
// rather than halfway through the branch tray.
const WIDTH = 460;
const HEIGHT = 355;

const work = mkdtempSync(join(tmpdir(), 'restack-shot-remote-'));

const html = readFileSync(join(root, 'test', 'harness', 'index.html'), 'utf8')
  .replaceAll('../../dist/', `file://${join(root, 'dist')}/`)
  .replaceAll('./driver.js', `file://${join(root, 'test', 'harness', 'driver.js')}`)
  .replace('#frame { width: 420px; border: 1px solid #333; }', '#frame { width: 420px; }')
  .replace('<body>', '<body style="padding:16px">');

writeFileSync(join(work, 'shot.html'), html);

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
    // ?view=behind is what asks the driver for a trunk 3 commits behind its
    // upstream, with the stack still sitting on the old tip.
    `file://${join(work, 'shot.html')}?view=behind`,
  ],
  { stdio: 'ignore' },
);

copyFileSync(join(work, 'shot.png'), join(here, 'screenshot-remote.png'));
rmSync(work, { recursive: true, force: true });
console.log('media/screenshot-remote.png written');
