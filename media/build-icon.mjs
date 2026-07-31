/**
 * Rasterize media/marketplace-icon.svg -> media/icon.png at 128x128.
 *
 * The marketplace requires a raster icon, and macOS ships no SVG converter that
 * gets this right: `qlmanage` thumbnails an SVG as a *document*, which renders
 * the artwork into the corner of a letterboxed canvas rather than filling the
 * frame. Headless Chrome renders it as a page at an exact viewport, which is
 * what we want, and it is already on the machine for the browser harness.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SIZE = 128;

const svg = readFileSync(join(here, 'marketplace-icon.svg'), 'utf8');
const work = mkdtempSync(join(tmpdir(), 'restack-icon-'));

// margin:0 and an exactly-sized body, or Chrome adds the default 8px body
// margin and the icon lands off-centre inside the viewport.
writeFileSync(
  join(work, 'icon.html'),
  `<!DOCTYPE html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;width:${SIZE}px;height:${SIZE}px;overflow:hidden}
svg{display:block}</style>${svg}`,
);

execFileSync(
  CHROME,
  [
    '--headless',
    '--disable-gpu',
    '--hide-scrollbars',
    '--default-background-color=00000000', // Keep the corners outside the rx transparent.
    `--screenshot=${join(work, 'icon.png')}`,
    `--window-size=${SIZE},${SIZE}`,
    join(work, 'icon.html'),
  ],
  { stdio: 'ignore' },
);

copyFileSync(join(work, 'icon.png'), join(here, 'icon.png'));
rmSync(work, { recursive: true, force: true });
console.log(`media/icon.png written at ${SIZE}x${SIZE}`);
