#!/usr/bin/env node
/**
 * The chrome window runs with `sandbox: true`. A sandboxed preload may only require() electron and a few built-ins,
 * so the tsc output (which does `require('../ipc/contract.js')`) fails with "module not found" and `window.aegis`
 * is never defined (found while running the real app for Issue #239). Bundle the compiled preload into one
 * self-contained file; `electron` stays external.
 */
import { build } from 'esbuild';

// Both sandboxed windows: the chrome window and the presence overlay window (#233).
for (const name of ['preload', 'presence_preload']) await build({
  entryPoints: [`dist/main/${name}.js`],
  outfile: `dist/main/${name}.js`,
  allowOverwrite: true,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  logLevel: 'info'
});
