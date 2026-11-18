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

  // UI layout
  toggleDrawer: (open: boolean, width?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.DRAWER_TOGGLE, { open, width }),

  // Mission execution
  startMission: (prompt: string, model?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MISSION_START, { prompt, model } as MissionStartRequest),
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

  // Settings
  getSettings: () =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET),
  updateSettings: (settings: any) =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_UPDATE, { settings }),

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
  }
});
