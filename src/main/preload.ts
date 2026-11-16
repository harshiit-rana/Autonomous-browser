/**
 * Project Aegis - Secure Preload Bridge
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('aegis', {
  // Window controls
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  close: () => ipcRenderer.invoke('window:close'),

  // Tab navigation & lifecycle
  createTab: (url: string, isBackground = false) => ipcRenderer.invoke('tab:create', { url, isBackground }),
  navigateTab: (url: string) => ipcRenderer.invoke('tab:navigate', { url }),
  switchTab: (id: string) => ipcRenderer.invoke('tab:switch', { id }),
  closeTab: (id: string) => ipcRenderer.invoke('tab:close', { id }),
  listTabs: () => ipcRenderer.invoke('tab:list'),
  goBack: () => ipcRenderer.invoke('tab:go_back'),
  goForward: () => ipcRenderer.invoke('tab:go_forward'),
  reload: () => ipcRenderer.invoke('tab:reload'),

  // UI layout
  toggleDrawer: (open: boolean, width?: number) => ipcRenderer.invoke('drawer:toggle', { open, width }),

  // Swarm execution
  executeSwarm: (command: string, prompt: string, model: string) => ipcRenderer.invoke('swarm:execute', { command, prompt, model }),

  // Agent execution
  executeAction: (tabId: string, action: string, params: any) => ipcRenderer.invoke('agent:action', { tabId, action, params }),
  getDOM: (tabId: string) => ipcRenderer.invoke('agent:get_dom', { tabId }),

  // Real-time events from main process
  onWorkerEvent: (callback: (data: any) => void) => {
    ipcRenderer.on('worker:event', (_, data) => callback(data));
  },
  onEvidenceEvent: (callback: (data: any) => void) => {
    ipcRenderer.on('evidence:event', (_, data) => callback(data));
  },
  onTabUpdated: (callback: (data: any) => void) => {
    ipcRenderer.on('tab:updated', (_, data) => callback(data));
  }
});
