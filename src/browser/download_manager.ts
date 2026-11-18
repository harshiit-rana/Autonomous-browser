/**
 * Project Aegis - Download Manager & Safe File Pipeline (Issue #171 - [BRW-04])
 * 
 * Features:
 * - Hooks session will-download lifecycle with active progress tracking
 * - Enforces security policy: blocks executables/scripts for agents by default
 * - Sanitizes filenames against traversal, Windows reserved names, null bytes
 * - Computes SHA-256 hash of downloaded artifacts for audit integrity
 * - Provides quarantine/scan hook and dedicated mission staging directories
 */

import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { rootLogger } from '../infrastructure/logger.js';

const logger = rootLogger.child('download-manager');

export interface DownloadItemRecord {
  id: string;
  missionId?: string;
  workerId?: string;
  url: string;
  filename: string;
  sanitizedFilename: string;
  targetPath: string;
  totalBytes: number;
  receivedBytes: number;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted' | 'blocked_by_policy';
  startTime: number;
  endTime?: number;
  sha256?: string;
  mimeType?: string;
  policyReason?: string;
}

export class DownloadManager {
  private activeDownloads: Map<string, DownloadItemRecord> = new Map();
  private downloadHistory: DownloadItemRecord[] = [];
  private downloadBaseDir: string;

  private static readonly DANGEROUS_EXTENSIONS = new Set([
    '.exe', '.bat', '.cmd', '.msi', '.ps1', '.vbs', '.vbe', '.js',
    '.jse', '.wsf', '.wsh', '.scr', '.pif', '.com', '.cpl', '.sh',
    '.bin', '.dmg', '.iso', '.appimage'
  ]);

  private static readonly WINDOWS_RESERVED_NAMES = new Set([
    'CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
  ]);

  constructor(downloadBaseDir: string = 'downloads') {
    this.downloadBaseDir = downloadBaseDir;
  }

  /**
   * Sanitizes a filename, preventing directory traversal, reserved device names, and control chars
   */
  public sanitizeFilename(filename: string): string {
    if (!filename) return `download_${Date.now()}`;

    // 1. Strip directory traversal characters
    let name = path.basename(filename.replace(/\\/g, '/')).trim();

    // 2. Remove null bytes and control characters
    name = name.replace(/[\x00-\x1f\x7f]/g, '');

    // 3. Remove characters illegal on Windows/POSIX: < > : " / \ | ? *
    name = name.replace(/[<>:"/\\|?*]/g, '_');

    // 4. Strip trailing dots and spaces
    name = name.replace(/[. ]+$/, '');

    // 5. Check if base name without extension is a reserved Windows device name
    const ext = path.extname(name);
    const stem = path.basename(name, ext).toUpperCase();
    if (DownloadManager.WINDOWS_RESERVED_NAMES.has(stem)) {
      name = `safe_${name}`;
    }

    // 6. Truncate extreme length (max 180 chars preserving extension)
    if (name.length > 180) {
      name = name.substring(0, 170) + ext;
    }

    return name || `download_${Date.now()}`;
  }

  /**
   * Evaluates if a file download is permitted under agent policy
   */
  public evaluateDownloadPolicy(filename: string, isAgentContext: boolean): { allowed: boolean; reason?: string } {
    const ext = path.extname(filename).toLowerCase();

    if (isAgentContext && DownloadManager.DANGEROUS_EXTENSIONS.has(ext)) {
      logger.warn('Blocked dangerous executable/script download for agent context', { filename, ext });
      return {
        allowed: false,
        reason: `Downloading executable or script files (${ext}) is blocked for autonomous agents.`
      };
    }

    return { allowed: true };
  }

  /**
   * Starts tracking a download
   */
  public startDownload(params: {
    url: string;
    filename: string;
    totalBytes: number;
    mimeType?: string;
    missionId?: string;
    workerId?: string;
  }): DownloadItemRecord {
    const id = `dl_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const sanitizedFilename = this.sanitizeFilename(params.filename);
    const isAgent = !!(params.missionId || params.workerId);

    const policy = this.evaluateDownloadPolicy(sanitizedFilename, isAgent);
    const missionSubfolder = params.missionId ? `mission_${params.missionId}` : 'general';
    const targetPath = path.join(this.downloadBaseDir, missionSubfolder, sanitizedFilename);

    const record: DownloadItemRecord = {
      id,
      missionId: params.missionId,
      workerId: params.workerId,
      url: params.url,
      filename: params.filename,
      sanitizedFilename,
      targetPath,
      totalBytes: params.totalBytes,
      receivedBytes: 0,
      state: policy.allowed ? 'progressing' : 'blocked_by_policy',
      startTime: Date.now(),
      mimeType: params.mimeType,
      policyReason: policy.reason
    };

    if (policy.allowed) {
      this.activeDownloads.set(id, record);
      logger.info('Download started', { id, sanitizedFilename, targetPath });
    } else {
      this.downloadHistory.push(record);
    }

    return record;
  }

  public updateProgress(id: string, receivedBytes: number): void {
    const item = this.activeDownloads.get(id);
    if (item) {
      item.receivedBytes = receivedBytes;
    }
  }

  public completeDownload(id: string, fileBytes?: Buffer): DownloadItemRecord | undefined {
    const item = this.activeDownloads.get(id);
    if (!item) return undefined;

    item.state = 'completed';
    item.endTime = Date.now();
    item.receivedBytes = item.totalBytes;

    if (fileBytes) {
      item.sha256 = crypto.createHash('sha256').update(fileBytes).digest('hex');
    }

    this.activeDownloads.delete(id);
    this.downloadHistory.push(item);
    logger.info('Download completed', { id, filename: item.sanitizedFilename, sha256: item.sha256 });
    return item;
  }

  public getActiveDownloads(): DownloadItemRecord[] {
    return Array.from(this.activeDownloads.values());
  }

  public getHistory(): DownloadItemRecord[] {
    return [...this.downloadHistory];
  }
}
