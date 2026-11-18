/**
 * Project Aegis - Cross-Platform Parity Engine (Issue #189 - [PLT-05])
 * 
 * Features:
 * - Normalized OS capabilities matrix across Windows 11, macOS (Apple Silicon / Intel), and Linux (Ubuntu LTS)
 * - Platform shortcut translation (Cmd vs Ctrl, Alt vs Option)
 * - Safe OS path resolution and file scheme normalizations
 * - OS secure storage provider detection (Windows DPAPI, macOS Keychain, Linux Secret Service/Keyring)
 * - High-DPI scaling and window chrome frame style configurations
 */

import * as os from 'node:os';
import * as path from 'node:path';

export type SupportedOS = 'win32' | 'darwin' | 'linux';

export interface PlatformConfig {
  os: SupportedOS;
  isWindows: boolean;
  isMac: boolean;
  isLinux: boolean;
  modifierKey: 'Ctrl' | 'Cmd';
  secureStorageBackend: 'dpapi' | 'keychain' | 'secret_service' | 'fallback_encrypted_file';
  defaultTitlebarOverlay: boolean;
}

export class PlatformParityManager {
  private currentOS: SupportedOS;

  constructor(targetOS?: SupportedOS) {
    this.currentOS = targetOS || (process.platform as SupportedOS);
  }

  public getPlatformConfig(): PlatformConfig {
    const isWin = this.currentOS === 'win32';
    const isMac = this.currentOS === 'darwin';
    const isLinux = this.currentOS === 'linux';

    let secureStorageBackend: PlatformConfig['secureStorageBackend'] = 'dpapi';
    if (isMac) secureStorageBackend = 'keychain';
    else if (isLinux) secureStorageBackend = 'secret_service';

    return {
      os: this.currentOS,
      isWindows: isWin,
      isMac,
      isLinux,
      modifierKey: isMac ? 'Cmd' : 'Ctrl',
      secureStorageBackend,
      defaultTitlebarOverlay: isWin || isMac
    };
  }

  /**
   * Translates a canonical shortcut (e.g. 'Ctrl+T') to the platform-native representation
   */
  public translateShortcut(canonicalShortcut: string): string {
    const config = this.getPlatformConfig();
    if (config.isMac) {
      return canonicalShortcut.replace(/\bCtrl\b/g, 'Cmd').replace(/\bAlt\b/g, 'Option');
    }
    return canonicalShortcut;
  }

  /**
   * Normalizes a filesystem path into standard URL format, handling Windows drive letters and UNC paths
   */
  public toFileUrl(filePath: string): string {
    let resolved = path.resolve(filePath).replace(/\\/g, '/');
    if (!resolved.startsWith('/')) {
      resolved = `/${resolved}`;
    }
    return `file://${resolved}`;
  }
}
