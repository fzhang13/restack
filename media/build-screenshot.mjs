/**
 * Render the real webview bundle to media/screenshot.png for the marketplace.
 *
 * This drives test/harness/index.html — the same page used to verify drag
 * behavior — so the screenshot is the actual UI at the actual sidebar width,
 * not a mockup that can drift from the code. Run after `npm run build &&
 * node test/harness/build-driver.mjs`.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, copyFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// The sidebar is narrow; a 2x window screenshotted at scale gives a crisp image
// on the marketplace's high-DPI listing page.
const WIDTH = 460;
const HEIGHT = 655;

const work = mkdtempSync(join(tmpdir(), 'restack-shot-'));

// Point the harness page at absolute file:// paths for the bundle, since the
// page now lives in a temp directory rather than test/harness/.
const html = readFileSync(join(root, 'test', 'harness', 'index.html'), 'utf8')
  .replaceAll('../../dist/', `file://${join(root, 'dist')}/`)
  .replaceAll('./driver.js', `file://${join(root, 'test', 'harness', 'driver.js')}`)
  .replace('#frame { width: 420px; border: 1px solid #333; }', '#frame { width: 420px; }')
  .replace('<body>', '<body style="padding:16px">');

// An idle stack is a screenshot of nothing happening. Drive a real reorder
// through the app's own Alt+ArrowDown handler so the plan panel renders with
// genuine commands from computePlan, rather than staging fake markup.
const script = `
<script>
  addEventListener('load', () => setTimeout(() => {
    const rows = document.querySelectorAll('.column:nth-of-type(2) .row--draggable');
    const target = rows[0]; // Topmost proposed row: feat/ui.
    if (!target) return;
    target.focus();
    target.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowDown', altKey: true, bubbles: true,
    }));
    // The focus ring is an artifact of driving this by keyboard; a reader would
    // have dragged, and the ring reads as a selected-item state that is not one.
    target.blur();
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
    '--virtual-time-budget=4000', // Let React mount and the driver post the stack.
    `--screenshot=${join(work, 'shot.png')}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    join(work, 'shot.html'),
  ],
  { stdio: 'ignore' },
);

copyFileSync(join(work, 'shot.png'), join(here, 'screenshot.png'));
rmSync(work, { recursive: true, force: true });
console.log('media/screenshot.png written');
