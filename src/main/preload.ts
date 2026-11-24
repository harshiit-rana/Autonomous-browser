/**
 * Project Aegis - Secure Preload Bridge
 * Single source of truth for renderer-to-main IPC communication.
 */

import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC_CHANNELS,
  TabsSnapshot,
  TabPatch,
  WorkerEventPayload,
  EvidenceEventPayload,
  MissionStatusPayload,
  MissionStartRequest,
  MissionQuestionPayload,
  LayoutReport,
  GridSourcesPayload
} from '../ipc/contract.js';

contextBridge.exposeInMainWorld('aegis', {
  // Window controls
  minimize: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_MINIMIZE),
  maximize: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_MAXIMIZE),
  close: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_CLOSE),

  // Tab navigation & lifecycle
  createTab: (url?: string, isBackground = false) =>
    ipcRenderer.invoke(IPC_CHANNELS.TAB_CREATE, { url, isBackground }),
  navigateTab: (url: string, tabId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.TAB_NAVIGATE, { url, tabId }),
  switchTab: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.TAB_SWITCH, { id }),
  closeTab: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.TAB_CLOSE, { id }),
  requestTabsSync: () =>
    ipcRenderer.invoke(IPC_CHANNELS.TAB_SYNC_REQUEST),
  goBack: () => ipcRenderer.invoke(IPC_CHANNELS.TAB_GO_BACK),
  goForward: () => ipcRenderer.invoke(IPC_CHANNELS.TAB_GO_FORWARD),
  reload: () => ipcRenderer.invoke(IPC_CHANNELS.TAB_RELOAD),

  // UI layout (Issue #138)
  toggleDrawer: (open: boolean, width?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.DRAWER_TOGGLE, { open, width }),
  setLayoutMode: (mode: 'stage' | 'grid' | 'theatre') =>
    ipcRenderer.invoke(IPC_CHANNELS.LAYOUT_SET, { mode }),
  setOverlayActive: (active: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.OVERLAY_SET_ACTIVE, { active }),
  // Live Swarm Grid (#232). Frames arrive on a MessagePort that is handed to the page with window.postMessage
  // (contextBridge cannot carry a MessagePort); see the 'frames:port' listener at the bottom of this file.
  reportLayout: (report: LayoutReport) =>
    ipcRenderer.invoke(IPC_CHANNELS.LAYOUT_REPORT, report),
  getGridSources: () =>
    ipcRenderer.invoke(IPC_CHANNELS.GRID_SOURCES_GET),
  promoteToStage: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.GRID_PROMOTE, { id }),
  getRuntimeFlags: () =>
    ipcRenderer.invoke(IPC_CHANNELS.RUNTIME_FLAGS_GET),
  onGridSources: (callback: (data: GridSourcesPayload) => void) => {
    ipcRenderer.on(IPC_CHANNELS.EVENT_GRID_SOURCES, (_, data) => callback(data));
  },
  // TEST-ONLY (AEGIS_TEST_MODE=1); main rejects these channels in a normal run because no handler is registered.
  testSpawnWorkers: (count: number, url: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.TEST_SPAWN_WORKERS, { count, url }),
  testWorkerAction: (action: string, id?: string, x?: number, y?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.TEST_WORKER_ACTION, { action, id, x, y }),

  // Mission execution & steering (Issues #140, #211, #214)
  startMission: (prompt: string, model?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MISSION_START, { prompt, model } as MissionStartRequest),
  previewPlan: (prompt: string, model?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MISSION_PLAN_PREVIEW, { prompt, model }),
  pauseMission: () =>
    ipcRenderer.invoke(IPC_CHANNELS.MISSION_PAUSE),
  resumeMission: () =>
    ipcRenderer.invoke(IPC_CHANNELS.MISSION_RESUME),
  cancelMission: () =>
    ipcRenderer.invoke(IPC_CHANNELS.MISSION_CANCEL),
  takeoverMission: () =>
    ipcRenderer.invoke(IPC_CHANNELS.MISSION_TAKEOVER),
  handBackMission: () =>
    ipcRenderer.invoke(IPC_CHANNELS.MISSION_HANDBACK),
  steerMission: (message: string, type?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MISSION_STEER, { message, type }),
  undoAction: () =>
    ipcRenderer.invoke(IPC_CHANNELS.MISSION_UNDO),
  answerQuestion: (missionId: string, questionId: string, answer: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MISSION_ANSWER, { missionId, questionId, answer }),

  // Persistence: mission history, backup/restore (Issue #239)
  listMissions: (limit?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.MISSIONS_LIST, { limit }),
  getMissionEvents: (missionId: string, afterSeq?: number, limit?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.MISSION_EVENTS_GET, { missionId, afterSeq, limit }),
  exportData: () =>
    ipcRenderer.invoke(IPC_CHANNELS.DATA_EXPORT),
  importData: () =>
    ipcRenderer.invoke(IPC_CHANNELS.DATA_IMPORT),

  // Settings & Credentials (Issue #133)
  getSettings: () =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET),
  updateSettings: (settings: any) =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_UPDATE, { settings }),
  testCredentials: (provider: string, key: string, baseUrl?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CREDENTIALS_TEST, { provider, key, baseUrl }),
  setCredential: (provider: string, key: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CREDENTIALS_SET, { provider, key }),
  getCredentialStatus: () =>
    ipcRenderer.invoke(IPC_CHANNELS.CREDENTIALS_GET_STATUS),
  getModelStatus: (model?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MODEL_STATUS, { model }),

  // Replay demo: recorded transcript, no model (#224)
  startDemo: () =>
    ipcRenderer.invoke(IPC_CHANNELS.DEMO_START),
  stopDemo: () =>
    ipcRenderer.invoke(IPC_CHANNELS.DEMO_STOP),

  // Push event subscriptions
  onTabsSync: (callback: (snapshot: TabsSnapshot) => void) => {
    ipcRenderer.on(IPC_CHANNELS.EVENT_TABS_SYNC, (_, data) => callback(data));
  },
  onTabPatch: (callback: (patch: TabPatch) => void) => {
    ipcRenderer.on(IPC_CHANNELS.EVENT_TAB_PATCH, (_, data) => callback(data));
  },
  onWorkerEvent: (callback: (data: WorkerEventPayload) => void) => {
    ipcRenderer.on(IPC_CHANNELS.EVENT_WORKER, (_, data) => callback(data));
  },
  onEvidenceEvent: (callback: (data: EvidenceEventPayload) => void) => {
    ipcRenderer.on(IPC_CHANNELS.EVENT_EVIDENCE, (_, data) => callback(data));
  },
  onMissionStatus: (callback: (data: MissionStatusPayload) => void) => {
    ipcRenderer.on(IPC_CHANNELS.EVENT_MISSION_STATUS, (_, data) => callback(data));
  },
  onMissionQuestion: (callback: (data: MissionQuestionPayload) => void) => {
    ipcRenderer.on(IPC_CHANNELS.EVENT_MISSION_QUESTION, (_, data) => callback(data));
  },
  onTelemetry: (callback: (data: any) => void) => {
    ipcRenderer.on(IPC_CHANNELS.EVENT_TELEMETRY, (_, data) => callback(data));
  },
  onPresence: (callback: (data: any) => void) => {
    ipcRenderer.on(IPC_CHANNELS.EVENT_PRESENCE, (_, data) => callback(data));
  }
});

// Frames port (#232, ADR 0010): forward the MessagePort from main to the page's main world. Only this window's own
// origin receives it (the chrome is a file:// page, whose origin serialises as "null", so '*' is used with a tag).
ipcRenderer.on(IPC_CHANNELS.FRAMES_PORT, (event) => {
  window.postMessage({ type: 'aegis:frames-port' }, '*', event.ports);
});
