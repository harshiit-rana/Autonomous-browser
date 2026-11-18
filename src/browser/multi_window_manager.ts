/**
 * Project Aegis - Multi-Window Manager (Issue #168 - [BRW-01])
 * 
 * Features:
 * - Coordinates multiple browser windows sharing the single main-process runtime
 * - Enables moving tabs/workers seamlessly between windows
 * - Per-window layout and active tab tracking
 * - Safe window closing: reassigns active agent tabs to primary window rather than terminating mid-action
 */

import { rootLogger } from '../infrastructure/logger.js';
import { TabGroupManager, ExtendedTabState } from './tab_group_manager.js';

const logger = rootLogger.child('multi-window-manager');

export interface WindowDescriptor {
  id: string;
  title: string;
  isPrimary: boolean;
  activeTabId: string | null;
  tabIds: string[];
  bounds: { x: number; y: number; width: number; height: number };
}

export class MultiWindowManager {
  private windows: Map<string, WindowDescriptor> = new Map();
  private primaryWindowId: string | null = null;
  private tabGroupManager: TabGroupManager;

  constructor(tabGroupManager: TabGroupManager) {
    this.tabGroupManager = tabGroupManager;
  }

  public registerWindow(id: string, isPrimary: boolean = false, bounds = { x: 100, y: 100, width: 1280, height: 800 }): WindowDescriptor {
    const descriptor: WindowDescriptor = {
      id,
      title: isPrimary ? 'Autonomous Browser (Primary)' : `Autonomous Browser - Window ${id}`,
      isPrimary,
      activeTabId: null,
      tabIds: [],
      bounds
    };

    this.windows.set(id, descriptor);
    if (isPrimary || !this.primaryWindowId) {
      this.primaryWindowId = id;
    }

    logger.info('Registered browser window', { id, isPrimary });
    return descriptor;
  }

  public getPrimaryWindow(): WindowDescriptor | undefined {
    return this.primaryWindowId ? this.windows.get(this.primaryWindowId) : undefined;
  }

  public getWindow(id: string): WindowDescriptor | undefined {
    return this.windows.get(id);
  }

  public listWindows(): WindowDescriptor[] {
    return Array.from(this.windows.values());
  }

  public assignTabToWindow(tabId: string, targetWindowId: string): boolean {
    const win = this.windows.get(targetWindowId);
    const tab = this.tabGroupManager.getTab(tabId);
    if (!win || !tab) return false;

    // Remove from previous window
    if (tab.windowId && this.windows.has(tab.windowId)) {
      const oldWin = this.windows.get(tab.windowId)!;
      oldWin.tabIds = oldWin.tabIds.filter(id => id !== tabId);
      if (oldWin.activeTabId === tabId) {
        oldWin.activeTabId = oldWin.tabIds[0] || null;
      }
    }

    tab.windowId = targetWindowId;
    if (!win.tabIds.includes(tabId)) {
      win.tabIds.push(tabId);
    }
    if (!win.activeTabId) {
      win.activeTabId = tabId;
    }

    logger.info('Assigned tab to window', { tabId, targetWindowId });
    return true;
  }

  public moveTab(tabId: string, fromWindowId: string, toWindowId: string): boolean {
    if (fromWindowId === toWindowId) return true;
    return this.assignTabToWindow(tabId, toWindowId);
  }

  public closeWindow(windowId: string): { reallocatedTabs: string[]; closedSuccessfully: boolean } {
    const win = this.windows.get(windowId);
    if (!win) return { reallocatedTabs: [], closedSuccessfully: false };

    const reallocatedTabs: string[] = [];

    // If primary window is closing, delegate primary to another window if one exists
    if (win.isPrimary) {
      const remaining = Array.from(this.windows.values()).filter(w => w.id !== windowId);
      if (remaining.length > 0) {
        remaining[0].isPrimary = true;
        this.primaryWindowId = remaining[0].id;
      } else {
        this.primaryWindowId = null;
      }
    }

    // Reallocate agent-controlled or open tabs to primary window if available
    const primary = this.getPrimaryWindow();
    if (primary && primary.id !== windowId) {
      for (const tabId of [...win.tabIds]) {
        const tab = this.tabGroupManager.getTab(tabId);
        if (tab && (tab.owner.startsWith('agent:') || tab.isPinned)) {
          this.assignTabToWindow(tabId, primary.id);
          reallocatedTabs.push(tabId);
        } else {
          this.tabGroupManager.closeTab(tabId);
        }
      }
    } else {
      for (const tabId of [...win.tabIds]) {
        this.tabGroupManager.closeTab(tabId);
      }
    }

    this.windows.delete(windowId);
    logger.info('Closed browser window', { windowId, reallocatedCount: reallocatedTabs.length });
    return { reallocatedTabs, closedSuccessfully: true };
  }
}
