// Preload for scripts/dev/spike_layout.mjs (design spike #237). Sandbox-safe: only contextBridge + ipcRenderer.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('spike', {
  report: (rect) => ipcRenderer.send('layout:report', rect),
  event: (name, payload) => ipcRenderer.send('spike:event', name, payload),
  onCommand: (cb) => ipcRenderer.on('spike:cmd', (_e, name, payload) => cb(name, payload)),
});
