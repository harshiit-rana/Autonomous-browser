/**
 * Project Aegis - Manifest V3 Compatibility & Policy Guard (Issue #175 - [BRW-08])
 * 
 * Provides honest audit & compatibility matrix of Electron's Chrome extension support:
 * - Documents supported vs unsupported chrome.* APIs in Electron v33+
 * - Enforces security invariant: Extensions are strictly isolated to user personal profiles
 *   and never loaded into autonomous agent partitions to prevent prompt-injection and data exfiltration.
 */

import { rootLogger } from '../infrastructure/logger.js';

const logger = rootLogger.child('extension-guard');

export interface ExtensionApiSupport {
  namespace: string;
  isSupported: boolean;
  notes: string;
}

export class ExtensionCompatibility {
  public static readonly API_SUPPORT_MATRIX: ExtensionApiSupport[] = [
    { namespace: 'chrome.runtime', isSupported: true, notes: 'Supported (messaging, getURL, getManifest)' },
    { namespace: 'chrome.storage', isSupported: true, notes: 'Supported (local, sync partially supported)' },
    { namespace: 'chrome.tabs', isSupported: false, notes: 'Unsupported in standard Electron without full custom polyfill' },
    { namespace: 'chrome.declarativeNetRequest', isSupported: false, notes: 'Not implemented; use session.webRequest natively instead' },
    { namespace: 'chrome.webNavigation', isSupported: true, notes: 'Partially supported for event listeners' },
    { namespace: 'chrome.action', isSupported: false, notes: 'Browser action popups lack native toolbar rendering in Electron' },
    { namespace: 'chrome.contextMenus', isSupported: false, notes: 'Requires manual mapping to Electron native Menu' }
  ];

  /**
   * Evaluates if an extension is permitted to load in a given partition
   */
  public static canLoadInPartition(partition: string, extensionName: string): { allowed: boolean; reason?: string } {
    if (partition.startsWith('persist:agent') || partition.startsWith('ephemeral:') || partition.includes('worker')) {
      logger.warn('Blocked extension load into autonomous agent partition', { partition, extensionName });
      return {
        allowed: false,
        reason: 'Extensions are prohibited in agent worker sandboxes to prevent prompt-injection and token exfiltration.'
      };
    }

    return { allowed: true };
  }

  public static getCompatibilitySummary(): { supportedCount: number; unsupportedCount: number; matrix: ExtensionApiSupport[] } {
    const supported = ExtensionCompatibility.API_SUPPORT_MATRIX.filter(a => a.isSupported).length;
    const unsupported = ExtensionCompatibility.API_SUPPORT_MATRIX.length - supported;
    return {
      supportedCount: supported,
      unsupportedCount: unsupported,
      matrix: ExtensionCompatibility.API_SUPPORT_MATRIX
    };
  }
}
