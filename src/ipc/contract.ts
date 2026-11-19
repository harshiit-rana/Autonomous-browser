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

/**
 * Typed error code (#224): no usable model for the selected provider. It is a normal, expected first-run state, not a
 * failure: the renderer opens Settings on the provider section with `message` and no mission is started.
 */
export const MODEL_NOT_CONFIGURED = 'MODEL_NOT_CONFIGURED' as const;

/** Resolved model provider behind a model name + saved settings. */
export type ModelProviderId = 'gemini' | 'anthropic' | 'openai' | 'ollama';

export interface MissionStartResponse {
  started: boolean;
  missionId?: string;
  reason?: 'agent-runtime-not-available' | 'no-api-key' | 'invalid-request' | 'error';
  /** Set when the mission was refused because no model is usable. */
  code?: typeof MODEL_NOT_CONFIGURED;
  provider?: ModelProviderId;
  message?: string;
}

export interface ModelStatusRequest {
  model?: string;
}

export interface ModelStatusResponse {
  configured: boolean;
  provider: ModelProviderId;
  model: string;
  code?: typeof MODEL_NOT_CONFIGURED;
  /** Actionable text shown in Settings when `configured` is false. */
  message?: string;
  /** Ollama only: the base URL that was tried. */
  baseUrl?: string;
  /** Rough cost of one agent step; `costUSD` is null when the model has no pricing entry. */
  estimate: { costUSD: number | null; promptTokens: number; completionTokens: number };
}

/** Where mission output came from. `demo` = recorded transcript replay, no model ran. */
export type MissionSource = 'live' | 'demo';

export interface DemoStartResponse {
  started: boolean;
  message?: string;
}

export interface WorkerEventPayload {
  id: string;
  name?: string;
  /** Stable per-worker identity (#229): CSS colour and glyph shown next to the name everywhere. */
  color?: string;
  glyph?: string;
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
  /** `demo` while a recorded replay is playing: the renderer shows the DEMO banner. Absent means a live mission. */
  source?: MissionSource;
}

export interface TelemetryEventPayload {
  tokensTotal: number;
  costTotal: number;
  stepTokens?: number;
  stepCost?: number;
}

export interface PresenceEventPayload {
  tabId: string;
  type: 'move' | 'click' | 'type' | 'scroll';
  x: number;
  y: number;
  workerName?: string;
  color?: string;
  label?: string;
}

export interface SwarmPreviewItem {
  tabId: string;
  title: string;
  url: string;
  owner: string;
  thumbnailBase64?: string;
  isActive: boolean;
}

export interface PlanPreviewRequest {
  prompt: string;
  model?: string;
}

export interface PlanPreviewResponse {
  goal: string;
  steps: Array<{ stepNumber: number; title: string; description: string; toolHint: string }>;
  estimatedCostUSD: number;
  estimatedDurationSec: number;
}

export interface MissionHistoryItem {
  id: string;
  prompt: string;
  model: string;
  state: string;
  stepCount: number;
  result?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface MissionEventsRequest {
  missionId: string;
  afterSeq?: number;
  limit?: number;
}

export interface MissionEventItem {
  seq: number;
  ts: number;
  kind: string;
  data: unknown;
}

export interface MissionEventsResponse {
  events: MissionEventItem[];
  nextAfterSeq: number | null;
  total: number;
}

export interface DataTransferResult {
  cancelled?: boolean;
  path?: string;
  message: string;
}

export const IPC_CHANNELS = {
  // Window & Layout (Issue #138)
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE: 'window:maximize',
  WINDOW_CLOSE: 'window:close',
  LAYOUT_SET: 'layout:set',
  OVERLAY_SET_ACTIVE: 'overlay:set_active',

  // Tabs & Swarm Grid (Issue #135, #168)
  TAB_CREATE: 'tab:create',
  TAB_NAVIGATE: 'tab:navigate',
  TAB_SWITCH: 'tab:switch',
  TAB_CLOSE: 'tab:close',
  TAB_SYNC_REQUEST: 'tab:sync_request',
  TAB_GO_BACK: 'tab:go_back',
  TAB_GO_FORWARD: 'tab:go_forward',
  TAB_RELOAD: 'tab:reload',
  TAB_REOPEN: 'tab:reopen',
  TAB_DUPLICATE: 'tab:duplicate',
  TAB_PIN: 'tab:pin',
  TAB_MUTE: 'tab:mute',
  SWARM_PREVIEWS_GET: 'swarm:previews_get',

  // Standard Browser UX & Fundamentals (Issues #169, #174, #175)
  ZOOM_SET: 'zoom:set',
  ZOOM_IN: 'zoom:in',
  ZOOM_OUT: 'zoom:out',
  ZOOM_RESET: 'zoom:reset',
  FIND_IN_PAGE: 'find:start',
  FIND_STOP: 'find:stop',
  BOOKMARKS_GET: 'bookmarks:get',
  BOOKMARK_ADD: 'bookmark:add',
  HISTORY_GET: 'history:get',
  HISTORY_CLEAR: 'history:clear',
  CONTENT_BLOCKER_GET_STATS: 'content_blocker:get_stats',
  CONTENT_BLOCKER_ALLOW_ORIGIN: 'content_blocker:allow_origin',

  // UI
  DRAWER_TOGGLE: 'drawer:toggle',

  // Mission Lifecycle & Plan Preview (Issue #140)
  MISSION_START: 'mission:start',
  MISSION_PLAN_PREVIEW: 'mission:plan_preview',
  MISSION_PAUSE: 'mission:pause',
  MISSION_RESUME: 'mission:resume',
  MISSION_CANCEL: 'mission:cancel',
  MISSION_TAKEOVER: 'mission:takeover',
  MISSION_HANDBACK: 'mission:handback',
  MISSION_STEER: 'mission:steer',
  MISSION_UNDO: 'mission:undo',

  // Persistence: mission history and backup/restore (Issue #239)
  MISSIONS_LIST: 'missions:list',
  MISSION_EVENTS_GET: 'mission:events_get',
  DATA_EXPORT: 'data:export',
  DATA_IMPORT: 'data:import',

  // Settings & Credentials
  SETTINGS_GET: 'settings:get',
  SETTINGS_UPDATE: 'settings:update',
  CREDENTIALS_TEST: 'credentials:test',
  CREDENTIALS_SET: 'credentials:set',
  CREDENTIALS_GET_STATUS: 'credentials:get_status',
  MODEL_STATUS: 'model:status',
  DEMO_START: 'demo:start',
  DEMO_STOP: 'demo:stop',

  // Security & Audit (Issues #160, #164)
  KILL_SWITCH_TRIGGER: 'security:kill_switch_trigger',
  KILL_SWITCH_RESET: 'security:kill_switch_reset',
  KILL_SWITCH_GET_STATUS: 'security:kill_switch_get_status',
  AUDIT_LOG_GET: 'security:audit_log_get',
  AUDIT_LOG_VERIFY: 'security:audit_log_verify',

  // Push Events from Main to Renderer
  EVENT_TABS_SYNC: 'tabs:sync',
  EVENT_TAB_PATCH: 'tab:patch',
  EVENT_WORKER: 'worker:event',
  EVENT_EVIDENCE: 'evidence:event',
  EVENT_MISSION_STATUS: 'mission:status',
  EVENT_TELEMETRY: 'telemetry:event',
  EVENT_PRESENCE: 'presence:event'
} as const;

export type IPCChannelName = typeof IPC_CHANNELS[keyof typeof IPC_CHANNELS];
