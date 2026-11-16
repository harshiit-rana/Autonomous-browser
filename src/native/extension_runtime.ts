/**
 * Project Aegis - Chrome Extension Runtime (Manifest V3) Subsystem
 * 
 * Implements:
 * - Issue #56: EXT-01 Chrome Extension Runtime & Manifest V3 Compatibility Subsystem
 */

import { session, Session, Extension } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface LoadedExtensionInfo {
  id: string;
  name: string;
  version: string;
  path: string;
  manifestVersion: number;
}

export class ExtensionRuntimeManager {
  private targetSession: Session;
  private loadedExtensions: Map<string, LoadedExtensionInfo> = new Map();

  constructor(targetSession?: Session) {
    this.targetSession = targetSession || session.defaultSession;
  }

  /**
   * Loads an unpacked Manifest V3 or V2 Chrome extension from directory.
   */
  public async loadUnpackedExtension(extensionPath: string): Promise<LoadedExtensionInfo> {
    const manifestPath = path.join(extensionPath, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`Extension manifest not found at ${manifestPath}`);
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const ext: Extension = await this.targetSession.loadExtension(extensionPath, {
      allowFileAccess: true
    });

    const info: LoadedExtensionInfo = {
      id: ext.id,
      name: ext.name,
      version: ext.version,
      path: extensionPath,
      manifestVersion: manifest.manifest_version || 3
    };

    this.loadedExtensions.set(ext.id, info);
    return info;
  }

  /**
   * Unloads an extension by ID.
   */
  public unloadExtension(extensionId: string): void {
    this.targetSession.removeExtension(extensionId);
    this.loadedExtensions.delete(extensionId);
  }

  public listExtensions(): LoadedExtensionInfo[] {
    return Array.from(this.loadedExtensions.values());
  }
}
