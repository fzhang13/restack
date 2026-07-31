/**
 * Render the stack switcher to media/screenshot-switcher.png.
 *
 * Same discipline as the other three: the real webview bundle through
 * test/harness/index.html, so the image cannot drift from the UI. The scene is
 * `?view=multi` — three stacks in one repository, which is the state the
 * switcher exists for and the one no other screenshot can show, since every
 * other view is a single stack.
 *
 * The one scripted gesture is opening it. Collapsed is the default, and
 * deliberately so — a one-stack repository should pay nothing for this — but a
 * screenshot of a collapsed disclosure is a screenshot of a line of text.
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

// Cut below the toolbar rather than at the stack columns: the subject is the
// three rows and the "+ New stack" button that creates a fourth, and the
// current/proposed columns below are already the other screenshots' subject.
const WIDTH = 460;
const HEIGHT = 250;

const work = mkdtempSync(join(tmpdir(), 'restack-shot-switcher-'));

const html = readFileSync(join(root, 'test', 'harness', 'index.html'), 'utf8')
  .replaceAll('../../dist/', `file://${join(root, 'dist')}/`)
  .replaceAll('./driver.js', `file://${join(root, 'test', 'harness', 'driver.js')}`)
  .replace('#frame { width: 420px; border: 1px solid #333; }', '#frame { width: 420px; }')
  .replace('<body>', '<body style="padding:16px">');

// Expand through the header's own click handler rather than by staging open
// markup, so what is captured is the component's real expanded state.
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
    // ?view=multi is what asks the driver for three stacks rather than one.
    `file://${join(work, 'shot.html')}?view=multi`,
  ],
  { stdio: 'ignore' },
);

copyFileSync(join(work, 'shot.png'), join(here, 'screenshot-switcher.png'));
rmSync(work, { recursive: true, force: true });
console.log('media/screenshot-switcher.png written');
