/**
 * Render an expanded branch's contents to media/screenshot-changes.png.
 *
 * Same discipline as the other five: the real webview bundle through
 * test/harness/index.html, so the image cannot drift from the UI. The scene is
 * `?view=changes` — commit counts on every row, and the two states an
 * expansion can be in, which no single branch can show at once:
 *
 *   - feat/api has commits, so it shows the branch's own file summary, the
 *     commits under it, and a rename with both of its paths.
 *   - feat/ui is HEAD and has no commits of its own, so it shows the empty
 *     state and the working tree — the section that only ever appears on the
 *     branch you are standing on.
 *
 * Both are opened by script rather than by staging open markup, so what is
 * captured is the component's real expanded state, fetched through the same
 * `loadChanges` round trip the extension makes.
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

// Tall, because the subject is what unfolds below a row rather than the row
// itself: two expansions plus the trunk and the toolbar above them. The
// Proposed column is in frame and deliberately so — the counts and the trees
// hang off Current only, and the empty column beside them is what says so.
const WIDTH = 460;
const HEIGHT = 700;

const work = mkdtempSync(join(tmpdir(), 'restack-shot-changes-'));

const html = readFileSync(join(root, 'test', 'harness', 'index.html'), 'utf8')
  .replaceAll('../../dist/', `file://${join(root, 'dist')}/`)
  .replaceAll('./driver.js', `file://${join(root, 'test', 'harness', 'driver.js')}`)
  .replace('#frame { width: 420px; border: 1px solid #333; }', '#frame { width: 420px; }')
  .replace('<body>', '<body style="padding:16px">');

// Click the twisties through their own handlers, and give the `loadChanges`
// round trip a beat to answer before the capture — an expansion that has not
// been answered yet reads "Reading…", which is a screenshot of a spinner.
const script = `
<script>
  addEventListener('load', () => setTimeout(() => {
    for (const branch of ['feat/api', 'feat/ui']) {
      const twisty = document.querySelector(\`[aria-label="Show changes in \${branch}"]\`);
      if (!twisty) continue;
      twisty.click();
      // The focus ring is an artifact of driving this by script; a reader would
      // have clicked, and the ring reads as a selected state that is not one.
      twisty.blur();
    }
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
    // ?view=changes is what asks the driver for commit counts, a working tree,
    // and a branch whose contents it will answer `loadChanges` with.
    `file://${join(work, 'shot.html')}?view=changes`,
  ],
  { stdio: 'ignore' },
);

copyFileSync(join(work, 'shot.png'), join(here, 'screenshot-changes.png'));
rmSync(work, { recursive: true, force: true });
console.log('media/screenshot-changes.png written');
