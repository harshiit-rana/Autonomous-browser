import path from 'node:path';
import { flipFuses, getCurrentFuseWire } from '@electron/fuses';
import { FUSE_DISABLED, FUSE_ENABLED, FuseV1Options, FuseVersion, fuseName, getFuseSet } from './packaging.mjs';

/**
 * Flip the hardening fuses on a packaged Electron binary.
 * `target` is the .exe (win), the .app (mac) or the executable (linux).
 */
export async function applyFuses(target, platform = process.platform, extra = {}) {
  const fuses = getFuseSet(platform);
  await flipFuses(target, { version: FuseVersion.V1, ...fuses, ...extra });
  return fuses;
}

/**
 * Read the fuse wire back from the binary on disk and compare with the expected set.
 * Returns { ok, rows, problems }. `RunAsNode` enabled is always a hard failure.
 */
export async function verifyFuses(target, platform = process.platform) {
  const expected = getFuseSet(platform);
  const wire = await getCurrentFuseWire(target);
  const rows = [];
  const problems = [];
  for (const [indexStr, want] of Object.entries(expected)) {
    const index = Number(indexStr);
    const raw = wire[index];
    const actual = raw === FUSE_ENABLED ? true : raw === FUSE_DISABLED ? false : null;
    rows.push({ name: fuseName(index), expected: want, actual });
    if (actual !== want) {
      problems.push(`${fuseName(index)} is ${actual === null ? `state 0x${(raw ?? 0).toString(16)}` : actual ? 'ENABLED' : 'DISABLED'}, expected ${want ? 'ENABLED' : 'DISABLED'}`);
    }
  }
  if (wire[FuseV1Options.RunAsNode] === FUSE_ENABLED) {
    problems.unshift('RunAsNode fuse is ENABLED: ELECTRON_RUN_AS_NODE could turn this app into a Node interpreter');
  }
  return { ok: problems.length === 0, rows, problems, target: path.resolve(target) };
}
