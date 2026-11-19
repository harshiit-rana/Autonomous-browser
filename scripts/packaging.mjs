/**
 * Shared packaging helpers for the build / fuse / smoke-test pipeline (#258 PKG-01).
 *
 * Everything here operates on real files: the fuse set that is flipped in
 * `after-pack.mjs` is the same object that `verify_fuses.mjs` reads back, so the two
 * can never drift apart.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(here, '..');

/** FuseState byte values written in the Electron binary. */
export const FUSE_ENABLED = 0x31; // '1'
export const FUSE_DISABLED = 0x30; // '0'

/**
 * Fuses applied to every packaged binary. `true` = enabled.
 * EnableEmbeddedAsarIntegrityValidation is only meaningful on Windows and macOS
 * (Electron ignores asar integrity on Linux), so it is added per-platform below.
 */
export function getFuseSet(platform) {
  const fuses = {
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    // Must stay enabled: the chrome window is loaded with loadFile() from inside app.asar, and with this
    // fuse off Electron 33 fails that load with ERR_FILE_NOT_FOUND (verified by the packaged smoke test).
    // Follow-up: serve the renderer from a custom protocol, then disable it.
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: true
  };
  if (platform === 'win32' || platform === 'darwin') {
    fuses[FuseV1Options.EnableEmbeddedAsarIntegrityValidation] = true;
  }
  return fuses;
}

export function fuseName(index) {
  return FuseV1Options[index] ?? `fuse#${index}`;
}

export { FuseV1Options, FuseVersion };

export function readPackageJson(root = ROOT_DIR) {
  return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
}

/**
 * Resolve the path that must be handed to @electron/fuses for a packaged app dir.
 * - win32: <dir>/<productFilename>.exe
 * - darwin: <dir>/<productFilename>.app (fuses lives in the Electron Framework inside it)
 * - linux: <dir>/<executableName>
 */
export function resolveFuseTarget(appOutDir, platform, productFilename, executableName) {
  if (platform === 'win32') return path.join(appOutDir, `${productFilename}.exe`);
  if (platform === 'darwin') return path.join(appOutDir, `${productFilename}.app`);
  return path.join(appOutDir, executableName || productFilename);
}

/** Path of the binary that is actually launched for the smoke test. */
export function resolveLaunchBinary(appOutDir, platform, productFilename, executableName) {
  if (platform === 'darwin') {
    return path.join(appOutDir, `${productFilename}.app`, 'Contents', 'MacOS', productFilename);
  }
  return resolveFuseTarget(appOutDir, platform, productFilename, executableName);
}

/**
 * Locate the unpacked app dir produced by `electron-builder --dir` / a full build.
 * Returns { appOutDir, launchBinary, fuseTarget } for the host platform or throws.
 */
export function findPackagedApp(releaseDir = path.join(ROOT_DIR, 'release'), platform = process.platform) {
  const pkg = readPackageJson();
  const productFilename = pkg.build?.productName ?? pkg.name;
  const executableName = pkg.build?.linux?.executableName;
  const candidates =
    platform === 'win32'
      ? ['win-unpacked', 'win-arm64-unpacked']
      : platform === 'darwin'
        ? ['mac', 'mac-arm64', 'mac-universal']
        : ['linux-unpacked', 'linux-arm64-unpacked'];
  for (const c of candidates) {
    const appOutDir = path.join(releaseDir, c);
    const launchBinary = resolveLaunchBinary(appOutDir, platform, productFilename, executableName);
    if (fs.existsSync(launchBinary)) {
      return {
        appOutDir,
        launchBinary,
        fuseTarget: resolveFuseTarget(appOutDir, platform, productFilename, executableName)
      };
    }
  }
  throw new Error(
    `No packaged ${platform} app found under ${releaseDir} (looked in ${candidates.join(', ')}). ` +
      'Run `npm run build && npx electron-builder --dir` first.'
  );
}
