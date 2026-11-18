/**
 * Project Aegis - Standard Browser UX Engine (Issue #174 - [BRW-07])
 * 
 * Features:
 * - Find-in-page search state (matches, active index, wrap-around navigation)
 * - Per-origin zoom level persistence (Ctrl +/-/0)
 * - Bookmarks manager with nested folders, tags, search
 * - History manager with temporal filtering and search
 * - Context menu generator with intelligent agent actions ("Ask agent about this", "Extract this table")
 * - Configurable keyboard shortcuts registry and command palette commands
 */

import { rootLogger } from '../infrastructure/logger.js';

const logger = rootLogger.child('browser-ux');

export interface BookmarkItem {
  id: string;
  title: string;
  url: string;
  folderId?: string;
  tags: string[];
  createdAt: number;
}

export interface BookmarkFolder {
  id: string;
  name: string;
  parentId?: string;
}

export interface HistoryEntry {
  id: string;
  url: string;
  title: string;
  visitTime: number;
  isAgentVisit: boolean;
}

export interface FindInPageState {
  tabId: string;
  text: string;
  activeMatchOrdinal: number;
  matches: number;
}

export interface ContextMenuItem {
  id: string;
  label: string;
  type: 'action' | 'separator';
  action?: string;
  agentIntent?: string;
  shortcut?: string;
}

export class BrowserUXManager {
  private bookmarks: Map<string, BookmarkItem> = new Map();
  private bookmarkFolders: Map<string, BookmarkFolder> = new Map();
  private history: HistoryEntry[] = [];
  private originZoomLevels: Map<string, number> = new Map();
  private activeFindState: Map<string, FindInPageState> = new Map();

  constructor() {
    this.createFolder('Bookmarks Bar');
  }

  // --- Find in Page ---
  public updateFindState(tabId: string, text: string, matches: number, activeMatchOrdinal: number = 1): FindInPageState {
    const state: FindInPageState = {
      tabId,
      text,
      matches,
      activeMatchOrdinal: matches > 0 ? activeMatchOrdinal : 0
    };
    this.activeFindState.set(tabId, state);
    return state;
  }

  public nextFindMatch(tabId: string): FindInPageState | undefined {
    const state = this.activeFindState.get(tabId);
    if (!state || state.matches <= 0) return undefined;
    state.activeMatchOrdinal = (state.activeMatchOrdinal % state.matches) + 1;
    return state;
  }

  public prevFindMatch(tabId: string): FindInPageState | undefined {
    const state = this.activeFindState.get(tabId);
    if (!state || state.matches <= 0) return undefined;
    state.activeMatchOrdinal = state.activeMatchOrdinal > 1 ? state.activeMatchOrdinal - 1 : state.matches;
    return state;
  }

  public clearFindState(tabId: string): void {
    this.activeFindState.delete(tabId);
  }

  // --- Zoom Management ---
  public getZoomLevel(origin: string): number {
    return this.originZoomLevels.get(origin) || 1.0;
  }

  public setZoomLevel(origin: string, zoom: number): number {
    const clamped = Math.max(0.25, Math.min(5.0, zoom));
    this.originZoomLevels.set(origin, clamped);
    logger.info('Set zoom level for origin', { origin, zoom: clamped });
    return clamped;
  }

  public zoomIn(origin: string): number {
    const current = this.getZoomLevel(origin);
    return this.setZoomLevel(origin, Math.round((current + 0.1) * 10) / 10);
  }

  public zoomOut(origin: string): number {
    const current = this.getZoomLevel(origin);
    return this.setZoomLevel(origin, Math.round((current - 0.1) * 10) / 10);
  }

  public resetZoom(origin: string): number {
    return this.setZoomLevel(origin, 1.0);
  }

  // --- Bookmarks ---
  public createFolder(name: string, parentId?: string): BookmarkFolder {
    const id = `fld_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const folder: BookmarkFolder = { id, name, parentId };
    this.bookmarkFolders.set(id, folder);
    return folder;
  }

  public addBookmark(title: string, url: string, folderId?: string, tags: string[] = []): BookmarkItem {
    const id = `bm_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const bookmark: BookmarkItem = {
      id,
      title,
      url,
      folderId,
      tags,
      createdAt: Date.now()
    };
    this.bookmarks.set(id, bookmark);
    logger.info('Added bookmark', { id, title, url });
    return bookmark;
  }

  public deleteBookmark(id: string): boolean {
    return this.bookmarks.delete(id);
  }

  public searchBookmarks(query: string): BookmarkItem[] {
    const q = query.toLowerCase().trim();
    if (!q) return Array.from(this.bookmarks.values());
    return Array.from(this.bookmarks.values()).filter(b =>
      b.title.toLowerCase().includes(q) ||
      b.url.toLowerCase().includes(q) ||
      b.tags.some(t => t.toLowerCase().includes(q))
    );
  }

  // --- History ---
  public recordHistory(url: string, title: string, isAgentVisit: boolean = false): HistoryEntry {
    const id = `hist_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const entry: HistoryEntry = {
      id,
      url,
      title,
      visitTime: Date.now(),
      isAgentVisit
    };
    this.history.unshift(entry);
    // Limit history to 10,000 items in memory
    if (this.history.length > 10000) {
      this.history.pop();
    }
    return entry;
  }

  public searchHistory(query: string, excludeAgentVisits: boolean = false): HistoryEntry[] {
    const q = query.toLowerCase().trim();
    return this.history.filter(h => {
      if (excludeAgentVisits && h.isAgentVisit) return false;
      if (!q) return true;
      return h.title.toLowerCase().includes(q) || h.url.toLowerCase().includes(q);
    });
  }

  public clearHistory(range?: { startTimestamp: number; endTimestamp: number }): number {
    if (!range) {
      const count = this.history.length;
      this.history = [];
      return count;
    }
    const initial = this.history.length;
    this.history = this.history.filter(h => h.visitTime < range.startTimestamp || h.visitTime > range.endTimestamp);
    return initial - this.history.length;
  }

  // --- Context Menu Generator ---
  public generateContextMenu(params: {
    selectedText?: string;
    linkUrl?: string;
    imageUrl?: string;
    isTableTarget?: boolean;
  }): ContextMenuItem[] {
    const items: ContextMenuItem[] = [];

    if (params.linkUrl) {
      items.push({ id: 'open_new_tab', label: 'Open Link in New Tab', type: 'action', action: 'navigate_new_tab' });
      items.push({ id: 'copy_link', label: 'Copy Link Address', type: 'action', action: 'copy_link' });
      items.push({ id: 'agent_explore_link', label: 'Research this Link with Agent', type: 'action', agentIntent: `Research ${params.linkUrl}` });
      items.push({ id: 'sep1', label: '', type: 'separator' });
    }

    if (params.selectedText) {
      const preview = params.selectedText.length > 25 ? params.selectedText.substring(0, 25) + '...' : params.selectedText;
      items.push({ id: 'copy', label: 'Copy', type: 'action', action: 'copy', shortcut: 'Ctrl+C' });
      items.push({ id: 'search_selection', label: `Search for "${preview}"`, type: 'action', action: 'search' });
      items.push({ id: 'agent_ask_selection', label: `Ask Agent about "${preview}"`, type: 'action', agentIntent: `Explain and analyze: ${params.selectedText}` });
      items.push({ id: 'sep2', label: '', type: 'separator' });
    }

    if (params.isTableTarget) {
      items.push({ id: 'agent_extract_table', label: 'Extract this Table to CSV / JSON', type: 'action', agentIntent: 'Extract table data from current element' });
    }

    items.push({ id: 'inspect_element', label: 'Inspect Element', type: 'action', action: 'devtools_inspect' });
    return items;
  }

  // --- Keyboard Shortcuts Catalogue ---
  public static readonly STANDARD_SHORTCUTS: Record<string, { description: string; action: string }> = {
    'Ctrl+T': { description: 'New Tab', action: 'tab_new' },
    'Ctrl+W': { description: 'Close Current Tab', action: 'tab_close' },
    'Ctrl+Shift+T': { description: 'Reopen Last Closed Tab', action: 'tab_reopen' },
    'Ctrl+L': { description: 'Focus Omnibar / Address Bar', action: 'omnibar_focus' },
    'Ctrl+F': { description: 'Find in Page', action: 'find_in_page' },
    'Ctrl+R': { description: 'Reload Page', action: 'tab_reload' },
    'Ctrl+Shift+R': { description: 'Hard Reload (Bypass Cache)', action: 'tab_hard_reload' },
    'Ctrl+Plus': { description: 'Zoom In', action: 'zoom_in' },
    'Ctrl+Minus': { description: 'Zoom Out', action: 'zoom_out' },
    'Ctrl+0': { description: 'Reset Zoom to 100%', action: 'zoom_reset' },
    'Ctrl+H': { description: 'Open Browsing History', action: 'open_history' },
    'Ctrl+B': { description: 'Toggle Bookmarks Bar', action: 'toggle_bookmarks' },
    'Ctrl+Shift+P': { description: 'Open Command Palette', action: 'open_command_palette' },
    'F11': { description: 'Toggle Fullscreen', action: 'toggle_fullscreen' },
    'Escape': { description: 'Stop Loading / Close Overlay', action: 'escape' }
  };
}
