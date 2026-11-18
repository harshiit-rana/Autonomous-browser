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
  MissionStartRequest
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
  getSwarmPreviews: () =>
    ipcRenderer.invoke(IPC_CHANNELS.SWARM_PREVIEWS_GET),

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
  onTelemetry: (callback: (data: any) => void) => {
    ipcRenderer.on(IPC_CHANNELS.EVENT_TELEMETRY, (_, data) => callback(data));
  },
  onPresence: (callback: (data: any) => void) => {
    ipcRenderer.on(IPC_CHANNELS.EVENT_PRESENCE, (_, data) => callback(data));
  }
});
