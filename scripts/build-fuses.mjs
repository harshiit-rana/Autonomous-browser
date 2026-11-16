import { flipFuses, FuseVersion, FuseV1Options } from '@electron/fuses';
import path from 'node:path';

/**
 * Hardens the production Electron binary by flipping critical security fuses.
 * Reverse-engineered from Strawberry Browser's Fuse Sentinel inspection:
 * - RunAsNode is disabled (blocks ELECTRON_RUN_AS_NODE escalation)
 * - EnableNodeCliInspectArguments is disabled (blocks --inspect debugger injection)
 * - EnableNodeOptionsEnvironmentVariable is disabled (blocks NODE_OPTIONS injection)
 * - OnlyLoadAppFromAsar is enforced (guarantees packaging integrity)
 */
export async function applyFuses(executablePath) {
  console.log(`[Security Build] Hardening binary fuses at: ${executablePath}`);
  
  await flipFuses(executablePath, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false
  });

  console.log('[Security Build] All Electron security fuses successfully hardened.');
}

if (process.argv[2]) {
  applyFuses(path.resolve(process.argv[2])).catch(err => {
    console.error('[Security Build] Fuse hardening failed:', err);
    process.exit(1);
  });
}
