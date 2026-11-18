/**
 * Project Aegis - Tab, Window & Workspace Model (Issue #168 - [BRW-01])
 * 
 * Features:
 * - Tab Groups & Workspaces: Each mission or user context owns a group (color, name, collapsed state)
 * - Visual ownership: Agent-controlled tabs vs user tabs (badges, lock state)
 * - Navigation state per tab: URL, title, favicon, loading progress, back/forward history stacks
 * - Tab lifecycle: pinned tabs, duplication, reordering, tab search
 * - Closed tab history stack: reopen closed tab (Ctrl+Shift+T) with restored state
 * - Tab discarding / hibernation: unload heavy background WebContentsView while retaining state
 */

import { TabState } from '../ipc/contract.js';
import { rootLogger } from '../infrastructure/logger.js';

const logger = rootLogger.child('tab-group-manager');

export interface TabGroup {
  id: string;
  name: string;
  color: string;
  collapsed: boolean;
  ownerMissionId?: string;
  tabIds: string[];
}

export interface ExtendedTabState extends TabState {
  groupId?: string;
  isPinned: boolean;
  isDiscarded: boolean;
  isAudible: boolean;
  isMuted: boolean;
  zoomLevel: number;
  secureContext: boolean;
  openerId?: string;
  windowId: string;
  lastActiveTimestamp: number;
  historyStack: Array<{ url: string; title: string }>;
  historyIndex: number;
}

export interface ClosedTabRecord {
  id: string;
  url: string;
  title: string;
  groupId?: string;
  windowId: string;
  closedAt: number;
  historyStack: Array<{ url: string; title: string }>;
  historyIndex: number;
}

export class TabGroupManager {
  private groups: Map<string, TabGroup> = new Map();
  private tabs: Map<string, ExtendedTabState> = new Map();
  private closedTabsStack: ClosedTabRecord[] = [];
  private static readonly MAX_CLOSED_HISTORY = 50;

  constructor() {
    // Initialize default general workspace group
    this.createGroup('General', '#4A90E2');
  }

  public createGroup(name: string, color: string = '#4A90E2', ownerMissionId?: string): TabGroup {
    const id = `group_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const group: TabGroup = {
      id,
      name,
      color,
      collapsed: false,
      ownerMissionId,
      tabIds: []
    };
    this.groups.set(id, group);
    logger.info('Created tab group', { id, name, color, ownerMissionId });
    return group;
  }

  public getGroup(id: string): TabGroup | undefined {
    return this.groups.get(id);
  }

  public listGroups(): TabGroup[] {
    return Array.from(this.groups.values());
  }

  public toggleGroupCollapse(id: string): boolean {
    const group = this.groups.get(id);
    if (!group) return false;
    group.collapsed = !group.collapsed;
    return group.collapsed;
  }

  public deleteGroup(id: string, defaultGroupId?: string): void {
    const group = this.groups.get(id);
    if (!group) return;

    const fallbackId = defaultGroupId || Array.from(this.groups.keys())[0];
    if (fallbackId && fallbackId !== id) {
      const fallbackGroup = this.groups.get(fallbackId);
      if (fallbackGroup) {
        for (const tabId of group.tabIds) {
          fallbackGroup.tabIds.push(tabId);
          const tab = this.tabs.get(tabId);
          if (tab) tab.groupId = fallbackId;
        }
      }
    }
    this.groups.delete(id);
    logger.info('Deleted tab group', { id, reassignedTo: fallbackId });
  }

  public registerTab(tab: Partial<ExtendedTabState> & { id: string; url: string }): ExtendedTabState {
    const defaultGroup = Array.from(this.groups.values())[0];
    const state: ExtendedTabState = {
      id: tab.id,
      url: tab.url,
      title: tab.title || 'New Tab',
      favicon: tab.favicon,
      isLoading: tab.isLoading ?? true,
      canGoBack: tab.canGoBack ?? false,
      canGoForward: tab.canGoForward ?? false,
      isAudible: tab.isAudible ?? false,
      isMuted: tab.isMuted ?? false,
      isCrashed: tab.isCrashed ?? false,
      owner: tab.owner || 'user',
      groupId: tab.groupId || defaultGroup?.id,
      isPinned: tab.isPinned ?? false,
      isDiscarded: tab.isDiscarded ?? false,
      zoomLevel: tab.zoomLevel ?? 1.0,
      secureContext: tab.url.startsWith('https://'),
      openerId: tab.openerId,
      windowId: tab.windowId || 'main_window',
      lastActiveTimestamp: Date.now(),
      historyStack: tab.historyStack || [{ url: tab.url, title: tab.title || 'New Tab' }],
      historyIndex: tab.historyIndex ?? 0
    };

    this.tabs.set(tab.id, state);

    if (state.groupId && this.groups.has(state.groupId)) {
      const g = this.groups.get(state.groupId)!;
      if (!g.tabIds.includes(tab.id)) {
        g.tabIds.push(tab.id);
      }
    }

    return state;
  }

  public getTab(id: string): ExtendedTabState | undefined {
    return this.tabs.get(id);
  }

  public listTabs(windowId?: string): ExtendedTabState[] {
    const all = Array.from(this.tabs.values());
    return windowId ? all.filter(t => t.windowId === windowId) : all;
  }

  public updateTab(id: string, patch: Partial<ExtendedTabState>): ExtendedTabState | undefined {
    const tab = this.tabs.get(id);
    if (!tab) return undefined;

    if (patch.url && patch.url !== tab.url) {
      tab.secureContext = patch.url.startsWith('https://');
      // Update history stack
      const nextIndex = tab.historyIndex + 1;
      tab.historyStack = tab.historyStack.slice(0, nextIndex);
      tab.historyStack.push({ url: patch.url, title: patch.title || tab.title });
      tab.historyIndex = nextIndex;
      tab.canGoBack = tab.historyIndex > 0;
      tab.canGoForward = false;
    }

    Object.assign(tab, patch);
    return tab;
  }

  public moveTabToGroup(tabId: string, targetGroupId: string): boolean {
    const tab = this.tabs.get(tabId);
    const targetGroup = this.groups.get(targetGroupId);
    if (!tab || !targetGroup) return false;

    if (tab.groupId && this.groups.has(tab.groupId)) {
      const oldGroup = this.groups.get(tab.groupId)!;
      oldGroup.tabIds = oldGroup.tabIds.filter(id => id !== tabId);
    }

    tab.groupId = targetGroupId;
    targetGroup.tabIds.push(tabId);
    return true;
  }

  public setTabPinned(id: string, pinned: boolean): boolean {
    const tab = this.tabs.get(id);
    if (!tab) return false;
    tab.isPinned = pinned;
    return true;
  }

  public setTabMuted(id: string, muted: boolean): boolean {
    const tab = this.tabs.get(id);
    if (!tab) return false;
    tab.isMuted = muted;
    return true;
  }

  public setTabDiscarded(id: string, discarded: boolean): boolean {
    const tab = this.tabs.get(id);
    if (!tab) return false;
    tab.isDiscarded = discarded;
    logger.info('Tab discard state changed', { id, discarded });
    return true;
  }

  public duplicateTab(id: string): ExtendedTabState | undefined {
    const tab = this.tabs.get(id);
    if (!tab) return undefined;

    const newId = `tab_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    return this.registerTab({
      ...tab,
      id: newId,
      title: `${tab.title} (Copy)`,
      openerId: id,
      isPinned: false
    });
  }

  public closeTab(id: string): ClosedTabRecord | undefined {
    const tab = this.tabs.get(id);
    if (!tab) return undefined;

    const record: ClosedTabRecord = {
      id: tab.id,
      url: tab.url,
      title: tab.title,
      groupId: tab.groupId,
      windowId: tab.windowId,
      closedAt: Date.now(),
      historyStack: [...tab.historyStack],
      historyIndex: tab.historyIndex
    };

    this.closedTabsStack.push(record);
    if (this.closedTabsStack.length > TabGroupManager.MAX_CLOSED_HISTORY) {
      this.closedTabsStack.shift();
    }

    if (tab.groupId && this.groups.has(tab.groupId)) {
      const g = this.groups.get(tab.groupId)!;
      g.tabIds = g.tabIds.filter(t => t !== id);
    }

    this.tabs.delete(id);
    logger.info('Closed tab recorded to reopen stack', { id, url: tab.url });
    return record;
  }

  public reopenLastClosedTab(): ExtendedTabState | undefined {
    const record = this.closedTabsStack.pop();
    if (!record) return undefined;

    const newId = `tab_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const restored = this.registerTab({
      id: newId,
      url: record.url,
      title: record.title,
      groupId: record.groupId,
      windowId: record.windowId,
      historyStack: record.historyStack,
      historyIndex: record.historyIndex
    });

    logger.info('Restored closed tab', { newId, originalUrl: record.url });
    return restored;
  }

  public searchTabs(query: string): ExtendedTabState[] {
    const q = query.toLowerCase().trim();
    if (!q) return [];
    return Array.from(this.tabs.values()).filter(t =>
      t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q)
    );
  }

  public getClosedTabsHistory(): ClosedTabRecord[] {
    return [...this.closedTabsStack].reverse();
  }
}
