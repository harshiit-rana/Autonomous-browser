/**
 * The Electron half of the presence layer (#233, ADR 0011): builds the transparent, frameless, non-focusable,
 * click-through child window and hands it to `PresenceLayer` as an `OverlayWindowLike`. Windows and macOS only: ADR 0011
 * measured option C on Windows; `setIgnoreMouseEvents(..., { forward: true })` does not exist on Linux, where the layer
 * draws nothing (the cross-platform fallback B2 of the ADR is not built, see docs/limitations.md).
 */
import * as path from 'node:path';
import { BrowserWindow, screen } from 'electron';
import { IPC_CHANNELS, type PresenceMessage, type LayoutRect } from '../ipc/contract.js';
import { rootLogger } from '../infrastructure/logger.js';
import type { OverlayWindowLike, ParentWindowLike, DisplayEventsLike } from './presence_layer.js';

const logger = rootLogger.child('presence-window');

export function presenceSupported(platform: string = process.platform): boolean {
  return platform === 'win32' || platform === 'darwin';
}

export function electronDisplays(): DisplayEventsLike | null {
  try { return screen; } catch { return null; }
}

export function electronOverlayFactory(parent: BrowserWindow): (() => OverlayWindowLike) | null {
  if (!presenceSupported()) {
    logger.warn('Presence layer not available on this platform (no click-through window); agent cursors are not drawn', { platform: process.platform });
    return null;
  }
  return () => {
    const win = new BrowserWindow({
      parent,
      width: 100,
      height: 100,
      show: false,
      transparent: true,
      frame: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      title: 'Autonomous Browser presence layer',
      backgroundColor: '#00000000',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        preload: path.resolve(__dirname, 'presence_preload.js')
      }
    });
    // Never takes a click: the user's mouse reaches the page below (forward keeps hover for the overlay itself, harmless).
    win.setIgnoreMouseEvents(true, { forward: true });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.session.setPermissionRequestHandler((_, __, cb) => cb(false));
    const html = path.resolve(__dirname, '../renderer/presence.html');
    let readyCb: (() => void) | null = null;
    win.webContents.once('did-finish-load', () => readyCb?.());
    win.loadFile(html).catch((err) => logger.warn('presence page failed to load', { error: String(err?.message || err) }));
    return {
      setBounds: (b: LayoutRect) => win.setBounds(b),
      showInactive: () => win.showInactive(),
      hide: () => win.hide(),
      isVisible: () => win.isVisible(),
      isDestroyed: () => win.isDestroyed(),
      send: (m: PresenceMessage) => { if (!win.isDestroyed()) win.webContents.send(IPC_CHANNELS.EVENT_PRESENCE, m); },
      onReady: (cb) => { readyCb = cb; if (!win.webContents.isLoading() && win.webContents.getURL()) cb(); },
      close: () => { if (!win.isDestroyed()) win.close(); }
    };
  };
}

export type { ParentWindowLike };
