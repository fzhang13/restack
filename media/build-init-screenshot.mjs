/**
 * Render the create-a-stack view to media/screenshot-init.png.
 *
 * Same discipline as build-screenshot.mjs: this drives the real webview bundle
 * through test/harness/index.html rather than staging markup, so the image
 * cannot drift from the UI. The difference is the scene — the harness is asked
 * for `?view=init` (the no-stack empty state), and the script below builds a
 * stack the way a reader would: drag two branches in, type a third.
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

// Taller than the stack screenshot: the builder stacks a trunk picker, the
// column, the tray, the name field, and the command preview vertically.
const WIDTH = 460;
const HEIGHT = 545;

const work = mkdtempSync(join(tmpdir(), 'restack-shot-init-'));

const html = readFileSync(join(root, 'test', 'harness', 'index.html'), 'utf8')
  .replaceAll('../../dist/', `file://${join(root, 'dist')}/`)
  .replaceAll('./driver.js', `file://${join(root, 'test', 'harness', 'driver.js')}`)
  .replace('#frame { width: 420px; border: 1px solid #333; }', '#frame { width: 420px; }')
  .replace('<body>', '<body style="padding:16px">');

/*
 * dnd-kit's PointerSensor needs a real gesture: a pointerdown, movement past
 * the 4px activation distance, and moves delivered over several frames — a
 * single jump to the target lands before the sensor has begun tracking and
 * drops nothing. Hence the interpolated steps.
 *
 * Keyboard lifting was the first thing tried and does not work here: arrow keys
 * traverse within the tray's SortableContext, so they cannot carry an item into
 * the stack column.
 */
const script = `
<script>
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function dragInto(label, dstSelector) {
    const src = [...document.querySelectorAll('.tray__list li')]
      .find((e) => e.textContent.includes(label));
    const dst = document.querySelector(dstSelector);
    if (!src || !dst) return;
    const a = src.getBoundingClientRect();
    const b = dst.getBoundingClientRect();
    const sx = a.x + a.width / 2, sy = a.y + a.height / 2;
    const tx = b.x + b.width / 2, ty = b.y + b.height / 2;
    const at = (type, x, y, buttons) => src.dispatchEvent(new PointerEvent(type, {
      pointerId: 1, pointerType: 'mouse', bubbles: true, cancelable: true,
      clientX: x, clientY: y, isPrimary: true, button: 0, buttons,
    }));

    at('pointerdown', sx, sy, 1);
    for (let i = 1; i <= 8; i++) {
      await sleep(25);
      at('pointermove', sx + (tx - sx) * i / 8, sy + (ty - sy) * i / 8, 1);
    }
    await sleep(80);
    at('pointerup', tx, ty, 0);
    await sleep(200);
  }

  addEventListener('load', async () => {
    await sleep(400);
    // Bottom-first, the order the hint text tells you to build in.
    //
    // The second drop must target the row already there, not the column: onto
    // the column appends to the bottom, which would silently invert the pair.
    // An earlier version aimed both at the column and produced a different
    // order run to run, depending on which element won the hit test.
    await dragInto('chore/deps', '.columns--single .graph');
    await dragInto('spike/cache', '.columns--single .rows .row');

    // The typed-in branch: shows the NEW badge and that init creates branches
    // that do not exist yet, which is the half of the feature a drag cannot show.
    const input = document.querySelector('#init-new');
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value',
    ).set;
    setValue.call(input, 'feat/new-thing');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(60);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    // Focus ring is an artifact of scripting this; a reader would have clicked Add.
    input.blur();

    // dnd-kit animates the lifted row back into place on drop via the Web
    // Animations API, which headless Chrome's virtual clock does not always run
    // to completion — the first attempt at this shot caught an overlay frozen
    // over the column. Settle, then drop any that is still there. Verified in a
    // live browser that none survives a real drop, so this removes an artifact
    // of the capture, not something a reader would see.
    await sleep(600);
    document.querySelectorAll('.row--overlay').forEach((el) => el.remove());
  });
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
    // Longer than the stack shot's 4000: three sequential gestures run first.
    '--virtual-time-budget=9000',
    `--screenshot=${join(work, 'shot.png')}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    // A URL, not a path: the driver picks its scene from location.search, and
    // ?view=init is what asks it for the no-stack empty state.
    `file://${join(work, 'shot.html')}?view=init`,
  ],
  { stdio: 'ignore' },
);

copyFileSync(join(work, 'shot.png'), join(here, 'screenshot-init.png'));
rmSync(work, { recursive: true, force: true });
console.log('media/screenshot-init.png written');
