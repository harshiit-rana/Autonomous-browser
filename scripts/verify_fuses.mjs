#!/usr/bin/env node
/**
 * Reads the Electron fuses back from a packaged binary and fails (exit 1) if RunAsNode is
 * enabled or any fuse differs from the expected set.
 *
 * usage: node scripts/verify_fuses.mjs [path-to-.exe|.app|binary]
 * With no argument the packaged app under release/ for the host platform is used.
 */
import path from 'node:path';
import { verifyFuses } from './fuses.mjs';
import { findPackagedApp } from './packaging.mjs';

const arg = process.argv[2];
const target = arg ? path.resolve(arg) : findPackagedApp().fuseTarget;

const result = await verifyFuses(target);
console.log(`Fuse read-back for ${target}`);
for (const r of result.rows) {
  console.log(`  ${r.name.padEnd(40)} expected=${String(r.expected).padEnd(5)} actual=${r.actual}`);
}
if (!result.ok) {
  console.error('FUSE VERIFICATION FAILED:');
  for (const p of result.problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('Fuse verification passed (RunAsNode disabled, all fuses as expected).');
