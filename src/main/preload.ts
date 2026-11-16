/**
 * Project Aegis - Secure Preload Bridge
 */

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('aegis', {
  // Window controls
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  close: () => ipcRenderer.invoke('window:close'),

  // Tab management
  createTab: (url: string, isBackground = false) => ipcRenderer.invoke('tab:create', { url, isBackground }),
  switchTab: (id: string) => ipcRenderer.invoke('tab:switch', { id }),
  closeTab: (id: string) => ipcRenderer.invoke('tab:close', { id }),
  listTabs: () => ipcRenderer.invoke('tab:list'),

  // Agent execution
  executeAction: (tabId: string, action: string, params: any) => ipcRenderer.invoke('agent:action', { tabId, action, params }),
  getDOM: (tabId: string) => ipcRenderer.invoke('agent:get_dom', { tabId }),
  onWorkerEvent: (callback: (data: any) => void) => {
    ipcRenderer.on('worker:event', (_, data) => callback(data));
  },
  onEvidenceEvent: (callback: (data: any) => void) => {
    ipcRenderer.on('evidence:event', (_, data) => callback(data));
  }
});
