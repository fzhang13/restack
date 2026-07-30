// Bundles the real plan.ts/stack.ts into the harness so the browser computes
// plans with the SAME code the extension host runs — no reimplementation.
import * as esbuild from 'esbuild';
await esbuild.build({
  entryPoints: ['test/harness/driver.src.ts'],
  bundle: true, outfile: 'test/harness/driver.js',
  platform: 'browser', format: 'iife', target: 'es2022',
  external: ['node:child_process', 'node:util'], logLevel: 'error',
});
