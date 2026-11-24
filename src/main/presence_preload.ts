/**
 * Preload of the presence overlay window (#233). Sandboxed: it may only require `electron`, so the channel name is
 * repeated here (tests/test_presence_layer.ts asserts it equals IPC_CHANNELS.EVENT_PRESENCE) and nothing else is imported.
 * The page gets one function that receives messages from the main process; it can send nothing back.
 */
import { contextBridge, ipcRenderer } from 'electron';

const EVENT_PRESENCE = 'presence:event';

contextBridge.exposeInMainWorld('presence', {
  onMessage: (callback: (message: unknown) => void) => {
    ipcRenderer.on(EVENT_PRESENCE, (_event, message) => callback(message));
  }
});
