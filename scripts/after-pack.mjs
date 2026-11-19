/**
 * electron-builder `afterPack` hook: flips the Electron security fuses on the packaged
 * binary for the platform being built, then reads them back and aborts packaging if
 * anything (in particular RunAsNode) is not in the expected state.
 *
 * Runs before code signing, so signatures cover the flipped binary.
 */
import { createRequire } from 'node:module';
import { applyFuses, verifyFuses } from './fuses.mjs';
import { resolveFuseTarget } from './packaging.mjs';

const require = createRequire(import.meta.url);

export default async function afterPack(context) {
  const platform = context.electronPlatformName; // 'win32' | 'darwin' | 'linux'
  const productFilename = context.packager.appInfo.productFilename;
  const executableName = context.packager.executableName;
  const target = resolveFuseTarget(context.appOutDir, platform, productFilename, executableName);

  // arm64 macOS binaries carry an ad-hoc signature that flipping invalidates; re-sign ad hoc.
  let resetAdHocDarwinSignature = false;
  if (platform === 'darwin') {
    const { Arch } = require('electron-builder');
    resetAdHocDarwinSignature = Arch[context.arch] === 'arm64';
  }

  console.log(`[after-pack] flipping fuses on ${target} (${platform})`);
  await applyFuses(target, platform, { resetAdHocDarwinSignature });

  const result = await verifyFuses(target, platform);
  for (const r of result.rows) console.log(`[after-pack]   ${r.name}: ${r.actual ? 'enabled' : 'disabled'}`);
  if (!result.ok) {
    throw new Error(`[after-pack] fuse read-back failed:\n  ${result.problems.join('\n  ')}`);
  }
}
