/**
 * Project Aegis - Download Manager, Safe Staging & PDF Archival Engine
 * 
 * Implements:
 * - Issue #67: SESSION-07 Download Manager & Safe File Staging Pipeline
 * - Issue #68: SESSION-08 Print-to-PDF & Web Artifact Archival Engine
 */

import { WebContents } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

export interface DownloadItemRecord {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  filePath: string;
  sha256: string;
  isQuarantined: boolean;
  quarantineReason?: string;
  downloadedAt: number;
}

export interface PDFExportOptions {
  landscape?: boolean;
  printBackground?: boolean;
  scale?: number;
  paperWidth?: number; // inches (default: 8.5)
  paperHeight?: number; // inches (default: 11)
  marginTop?: number;
  marginBottom?: number;
  marginLeft?: number;
  marginRight?: number;
}

export class DownloadPipeline {
  private stagingDir: string;
  private static readonly DANGEROUS_EXTENSIONS = new Set([
    '.exe', '.bat', '.cmd', '.vbs', '.ps1', '.scr', '.msi', '.pif', '.com'
  ]);

  constructor(stagingDir?: string) {
    this.stagingDir = stagingDir || path.join(process.cwd(), '.downloads');
    if (!fs.existsSync(this.stagingDir)) {
      fs.mkdirSync(this.stagingDir, { recursive: true });
    }
  }

  /**
   * Stages and validates a downloaded buffer.
   */
  public stageDownloadedBuffer(
    filename: string,
    buffer: Buffer,
    mimeType = 'application/octet-stream'
  ): DownloadItemRecord {
    const ext = path.extname(filename).toLowerCase();
    const isDangerous = DownloadPipeline.DANGEROUS_EXTENSIONS.has(ext);

    const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const targetPath = path.join(this.stagingDir, safeFilename);

    fs.writeFileSync(targetPath, buffer);

    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

    return {
      id: `dl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      filename: safeFilename,
      mimeType,
      sizeBytes: buffer.length,
      filePath: targetPath,
      sha256,
      isQuarantined: isDangerous,
      quarantineReason: isDangerous ? `Executable extension "${ext}" quarantined for safety.` : undefined,
      downloadedAt: Date.now()
    };
  }

  /**
   * Generates a high-fidelity PDF from the active WebContents via CDP Page.printToPDF.
   */
  public static async printWebPageToPDF(
    webContents: WebContents,
    outputPath: string,
    options: PDFExportOptions = {}
  ): Promise<string> {
    if (webContents.isDestroyed()) {
      throw new Error('WebContents destroyed');
    }

    if (!webContents.debugger.isAttached()) {
      webContents.debugger.attach('1.3');
    }

    const cdpOptions = {
      landscape: options.landscape ?? false,
      displayHeaderFooter: false,
      printBackground: options.printBackground ?? true,
      scale: options.scale ?? 1.0,
      paperWidth: options.paperWidth ?? 8.5,
      paperHeight: options.paperHeight ?? 11.0,
      marginTop: options.marginTop ?? 0.4,
      marginBottom: options.marginBottom ?? 0.4,
      marginLeft: options.marginLeft ?? 0.4,
      marginRight: options.marginRight ?? 0.4
    };

    const result = await webContents.debugger.sendCommand('Page.printToPDF', cdpOptions);
    const pdfBuffer = Buffer.from(result.data, 'base64');

    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(outputPath, pdfBuffer);
    return outputPath;
  }
}
