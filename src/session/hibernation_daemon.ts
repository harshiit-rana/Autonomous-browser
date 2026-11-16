/**
 * Project Aegis - Tab Hibernation & Memory Compression Daemon
 * 
 * Implements:
 * - Issue #66: SESSION-06 Tab Hibernation & Memory Compression Daemon
 */

import { WebContents } from 'electron';
import { EventEmitter } from 'node:events';
import { WebStateSnapshotter, WebStateSnapshot } from '../planning/state_snapshotter.js';

export interface ManagedTabState {
  tabId: string;
  webContents: WebContents;
  url: string;
  title: string;
  lastActive: number;
  isHibernated: boolean;
  savedSnapshot?: WebStateSnapshot;
}

export class TabHibernationDaemon extends EventEmitter {
  private tabs: Map<string, ManagedTabState> = new Map();
  private timer: NodeJS.Timeout | null = null;
  private idleTimeoutMs: number;
  private checkIntervalMs: number;

  constructor(idleTimeoutMs = 300_000, checkIntervalMs = 30_000) {
    super();
    this.idleTimeoutMs = idleTimeoutMs;
    this.checkIntervalMs = checkIntervalMs;
  }

  public registerTab(tabId: string, webContents: WebContents, url: string, title: string): void {
    this.tabs.set(tabId, {
      tabId,
      webContents,
      url,
      title,
      lastActive: Date.now(),
      isHibernated: false
    });
  }

  public unregisterTab(tabId: string): void {
    this.tabs.delete(tabId);
  }

  public touchTab(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (tab) {
      tab.lastActive = Date.now();
    }
  }

  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.scanIdleTabs(), this.checkIntervalMs);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Puts a specific tab into sleep / hibernation.
   */
  public async hibernateTab(tabId: string): Promise<boolean> {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.isHibernated || tab.webContents.isDestroyed()) return false;

    try {
      tab.savedSnapshot = await WebStateSnapshotter.captureSnapshot(tab.webContents, false);
      tab.url = tab.webContents.getURL();
      tab.title = tab.webContents.getTitle();

      const placeholderHtml = `
        <!DOCTYPE html>
        <html>
        <head><title>${encodeURIComponent(tab.title)}</title></head>
        <body style="background:#0F172A;color:#94A3B8;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
          <div style="text-align:center;">
            <h2 style="color:#F8FAFC;margin-bottom:8px;">Tab Sleeping</h2>
            <p style="font-size:14px;">Hibernated to conserve memory. Click to resume.</p>
          </div>
        </body>
        </html>
      `;

      await tab.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(placeholderHtml)}`);
      tab.isHibernated = true;
      this.emit('tab_hibernated', { tabId, originalUrl: tab.url });
      return true;
    } catch (err) {
      console.warn(`[HibernationDaemon] Failed to hibernate tab ${tabId}:`, err);
      return false;
    }
  }

  /**
   * Wakes up a hibernated tab and restores its saved state.
   */
  public async wakeTab(tabId: string): Promise<boolean> {
    const tab = this.tabs.get(tabId);
    if (!tab || !tab.isHibernated || tab.webContents.isDestroyed() || !tab.savedSnapshot) return false;

    try {
      await WebStateSnapshotter.restoreSnapshot(tab.webContents, tab.savedSnapshot);
      tab.isHibernated = false;
      tab.lastActive = Date.now();
      tab.savedSnapshot = undefined;
      this.emit('tab_woken', { tabId, url: tab.url });
      return true;
    } catch (err) {
      console.warn(`[HibernationDaemon] Failed to wake tab ${tabId}:`, err);
      return false;
    }
  }

  private async scanIdleTabs(): Promise<void> {
    const now = Date.now();
    for (const [id, tab] of this.tabs.entries()) {
      if (!tab.isHibernated && now - tab.lastActive >= this.idleTimeoutMs) {
        await this.hibernateTab(id);
      }
    }
  }
}
