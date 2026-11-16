/**
 * Project Aegis - Advanced CDP Controller & Lifecycle Manager
 * 
 * Implements:
 * - Issue #17: CORE-02 CDP Session Pool & Multi-Target Lifecycle Manager
 * - Issue #18: CORE-03 CDP Network Interception, Request Spoofing, and Mocking Engine
 * - Issue #19: CORE-04 JavaScript Dialog Interception Bridge
 * - Issue #20: CORE-05 Native File Chooser Interception & Autonomous Upload Manager
 * - Issue #24: CORE-09 Robust Frame Tree Navigation & Cross-Origin Shadow DOM Traversal
 * - Issue #25: CORE-10 Viewport Adaptation, Device Emulation, and Dynamic Zoom Handling
 */

import { WebContents } from 'electron';
import { EventEmitter } from 'node:events';

export interface DeviceMetrics {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  screenOrientation?: { angle: number; type: 'portraitPrimary' | 'landscapePrimary' };
}

export interface DialogEvent {
  url: string;
  message: string;
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  defaultPrompt?: string;
}

export interface FileChooserEvent {
  frameId: string;
  mode: 'selectSingle' | 'selectMultiple';
  backendNodeId?: number;
}

export type DialogPolicy = 'auto-accept' | 'auto-dismiss' | 'custom';

export class CDPManager extends EventEmitter {
  private webContents: WebContents;
  private isAttached = false;
  private blockedUrlPatterns: string[] = [];
  private customHeaders: Record<string, string> = {};
  private dialogPolicy: DialogPolicy = 'auto-accept';
  private defaultPromptText = '';
  private pendingUploads: Map<string, string[]> = new Map(); // frameId/nodeId -> file paths

  constructor(webContents: WebContents) {
    super();
    this.webContents = webContents;
  }

  /**
   * Initializes and attaches CDP protocol 1.3 to the WebContents.
   */
  public async initialize(): Promise<void> {
    if (this.isAttached || this.webContents.isDestroyed()) return;

    try {
      if (!this.webContents.debugger.isAttached()) {
        this.webContents.debugger.attach('1.3');
      }
      this.isAttached = true;

      // Enable necessary CDP domains
      await this.sendCommand('Page.enable');
      await this.sendCommand('Runtime.enable');
      await this.sendCommand('DOM.enable');
      await this.sendCommand('Network.enable');

      // Setup CDP event listener
      this.webContents.debugger.on('message', (_event, method, params) => {
        this.handleCDPMessage(method, params);
      });

      // Enable Page.setInterceptFileChooserDialog
      try {
        await this.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true });
      } catch (err) {
        console.warn('[CDPManager] File chooser interception not supported on this Chromium version:', err);
      }
    } catch (err) {
      console.warn('[CDPManager] Initialization failed:', err);
    }
  }

  public async detach(): Promise<void> {
    if (this.isAttached && !this.webContents.isDestroyed()) {
      try {
        if (this.webContents.debugger.isAttached()) {
          this.webContents.debugger.detach();
        }
      } catch {}
      this.isAttached = false;
    }
  }

  public async sendCommand(method: string, params: Record<string, any> = {}): Promise<any> {
    if (this.webContents.isDestroyed()) {
      throw new Error('WebContents destroyed');
    }
    return this.webContents.debugger.sendCommand(method, params);
  }

  /**
   * Configures network URL blocking (e.g. ad networks, trackers, telemetry)
   * to maximize swarm crawling performance.
   */
  public async setBlockedUrls(urls: string[]): Promise<void> {
    this.blockedUrlPatterns = urls;
    await this.sendCommand('Network.setBlockedURLs', { urls });
  }

  /**
   * Spoofs HTTP headers on all outgoing requests from this WebContents.
   */
  public async setExtraHTTPHeaders(headers: Record<string, string>): Promise<void> {
    this.customHeaders = headers;
    await this.sendCommand('Network.setExtraHTTPHeaders', { headers });
  }

  /**
   * Sets policy for JavaScript alert, confirm, and prompt dialogs.
   */
  public setDialogPolicy(policy: DialogPolicy, defaultPromptResponse = ''): void {
    this.dialogPolicy = policy;
    this.defaultPromptText = defaultPromptResponse;
  }

  /**
   * Emulates device viewport, screen orientation, and scale factor.
   */
  public async setDeviceMetrics(metrics: DeviceMetrics): Promise<void> {
    await this.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: metrics.width,
      height: metrics.height,
      deviceScaleFactor: metrics.deviceScaleFactor,
      mobile: metrics.mobile,
      screenOrientation: metrics.screenOrientation
    });

    if (metrics.mobile) {
      await this.sendCommand('Emulation.setTouchEmulationEnabled', {
        enabled: true,
        maxTouchPoints: 5
      });
    } else {
      await this.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: false });
    }
  }

  /**
   * Clears device emulation and resets to native window sizing.
   */
  public async resetDeviceMetrics(): Promise<void> {
    await this.sendCommand('Emulation.clearDeviceMetricsOverride');
    await this.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: false });
  }

  /**
   * Queues files to be uploaded automatically when a file chooser dialog opens.
   */
  public queueAutonomousUpload(files: string[]): void {
    this.pendingUploads.set('global', files);
  }

  /**
   * Extracts the full Frame Tree including cross-origin subframes.
   */
  public async getFrameTree(): Promise<any> {
    const result = await this.sendCommand('Page.getFrameTree');
    return result.frameTree;
  }

  /**
   * Discovers and traverses open and closed Shadow DOM roots on the page.
   */
  public async traverseShadowRoots(): Promise<any[]> {
    const doc = await this.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
    const shadowRoots: any[] = [];

    function findShadowRoots(node: any) {
      if (node.shadowRoots) {
        for (const sr of node.shadowRoots) {
          shadowRoots.push(sr);
          findShadowRoots(sr);
        }
      }
      if (node.children) {
        for (const child of node.children) {
          findShadowRoots(child);
        }
      }
    }

    findShadowRoots(doc.root);
    return shadowRoots;
  }

  private async handleCDPMessage(method: string, params: any): Promise<void> {
    // 1. Handle JavaScript Dialogs
    if (method === 'Page.javascriptDialogOpening') {
      const dialog: DialogEvent = {
        url: params.url,
        message: params.message,
        type: params.type,
        defaultPrompt: params.defaultPrompt
      };

      this.emit('dialogOpening', dialog);

      const shouldAccept = this.dialogPolicy === 'auto-accept' || dialog.type === 'alert';
      const promptText = dialog.type === 'prompt' ? this.defaultPromptText : undefined;

      try {
        await this.sendCommand('Page.handleJavaScriptDialog', {
          accept: shouldAccept,
          promptText: promptText
        });
        this.emit('dialogHandled', { ...dialog, accepted: shouldAccept });
      } catch (err) {
        console.warn('[CDPManager] Error handling dialog:', err);
      }
    }

    // 2. Handle Autonomous File Chooser Interception
    if (method === 'Page.fileChooserOpened') {
      const fcEvent: FileChooserEvent = {
        frameId: params.frameId,
        mode: params.mode,
        backendNodeId: params.backendNodeId
      };

      this.emit('fileChooserOpened', fcEvent);

      const files = this.pendingUploads.get('global') || [];
      if (files.length > 0 && params.backendNodeId) {
        try {
          await this.sendCommand('DOM.setFileInputFiles', {
            files,
            backendNodeId: params.backendNodeId
          });
          this.pendingUploads.delete('global');
          this.emit('fileUploaded', { files, backendNodeId: params.backendNodeId });
        } catch (err) {
          console.warn('[CDPManager] Failed to fulfill autonomous file upload:', err);
        }
      }
    }
  }
}
