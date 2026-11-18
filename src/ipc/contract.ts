/**
 * Project Aegis - Typed IPC Channel Contract & Schemas
 * Single source of truth for all main <-> renderer communications.
 */

export interface TabState {
  id: string;
  url: string;
  title: string;
  favicon?: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  isAudible?: boolean;
  isCrashed?: boolean;
  owner: 'user' | string; // 'user' or 'agent:<workerId>'
}

export interface TabsSnapshot {
  tabs: TabState[];
  activeTabId: string | null;
}

export interface TabPatch {
  id: string;
  patch: Partial<TabState>;
}

export interface IPCResult<T = void> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface TabCreateRequest {
  url?: string;
  isBackground?: boolean;
}

export interface TabNavigateRequest {
  tabId?: string;
  url: string;
}

export interface TabSwitchRequest {
  id: string;
}

export interface TabCloseRequest {
  id: string;
}

export interface DrawerToggleRequest {
  open: boolean;
  width?: number;
}

export interface MissionStartRequest {
  prompt: string;
  model?: string;
  options?: Record<string, any>;
}

export interface MissionStartResponse {
  started: boolean;
  missionId?: string;
  reason?: 'agent-runtime-not-available' | 'no-api-key' | 'invalid-request' | 'error';
  message?: string;
}

export interface WorkerEventPayload {
  id: string;
  name?: string;
  task: string;
  progress: number;
  status: 'running' | 'done' | 'idle' | 'failed';
}

export interface EvidenceEventPayload {
  text: string;
  timestamp: string;
  source?: string;
}

export interface MissionStatusPayload {
  missionId?: string;
  status: 'idle' | 'planning' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  message?: string;
}

export const IPC_CHANNELS = {
  // Window
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE: 'window:maximize',
  WINDOW_CLOSE: 'window:close',

  // Tabs
  TAB_CREATE: 'tab:create',
  TAB_NAVIGATE: 'tab:navigate',
  TAB_SWITCH: 'tab:switch',
  TAB_CLOSE: 'tab:close',
  TAB_SYNC_REQUEST: 'tab:sync_request',
  TAB_GO_BACK: 'tab:go_back',
  TAB_GO_FORWARD: 'tab:go_forward',
  TAB_RELOAD: 'tab:reload',

  // UI
  DRAWER_TOGGLE: 'drawer:toggle',

  // Mission
  MISSION_START: 'mission:start',
  MISSION_PAUSE: 'mission:pause',
  MISSION_RESUME: 'mission:resume',
  MISSION_CANCEL: 'mission:cancel',
  MISSION_TAKEOVER: 'mission:takeover',
  MISSION_HANDBACK: 'mission:handback',

  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_UPDATE: 'settings:update',

  // Push Events from Main to Renderer
  EVENT_TABS_SYNC: 'tabs:sync',
  EVENT_TAB_PATCH: 'tab:patch',
  EVENT_WORKER: 'worker:event',
  EVENT_EVIDENCE: 'evidence:event',
  EVENT_MISSION_STATUS: 'mission:status'
} as const;

export type IPCChannelName = typeof IPC_CHANNELS[keyof typeof IPC_CHANNELS];
