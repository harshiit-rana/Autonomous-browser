#!/usr/bin/env node
/**
 * The chrome window runs with `sandbox: true`. A sandboxed preload may only require() electron and a few built-ins,
 * so the tsc output (which does `require('../ipc/contract.js')`) fails with "module not found" and `window.aegis`
 * is never defined (found while running the real app for Issue #239). Bundle the compiled preload into one
 * self-contained file; `electron` stays external.
 */
import { build } from 'esbuild';

await build({
  entryPoints: ['dist/main/preload.js'],
  outfile: 'dist/main/preload.js',
  allowOverwrite: true,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  logLevel: 'info'
});
