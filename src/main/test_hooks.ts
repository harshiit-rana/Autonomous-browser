/**
 * Project Aegis - TEST-ONLY IPC hooks for real-app e2e runs of the live Grid (#232).
 *
 * Registered only when the app is started with `AEGIS_TEST_MODE=1` (never in a normal run; the log says so). They
 * drive REAL product code: a real SwarmManager spawns real WorkerHosts (own partitions, guards, CDP executor) that
 * navigate to a page given by the driver, and real Electron calls crash or retire them. Nothing here fabricates a
 * frame or a tile; frames still come from FrameHub's CDP screencast of those pages.
 */

import type { BrowserWindow, WebContents } from 'electron';
import { IPC_CHANNELS } from '../ipc/contract.js';
import { registerTypedHandler } from '../ipc/main_handler.js';
import { rootLogger } from '../infrastructure/logger.js';
import { SwarmManager } from '../swarm/swarm_manager.js';
import type { ViewManager } from './view_manager.js';

const logger = rootLogger.child('test-hooks');

export function isTestMode(): boolean {
  return process.env.AEGIS_TEST_MODE === '1';
}

type WorkerAction = 'crash' | 'retire' | 'recover' | 'viewport' | 'click' | 'hubStats' | 'shutdown' | 'restoreWindow';

export function registerTestHooks(getChrome: () => WebContents | null, viewManager: ViewManager, parentWindow?: BrowserWindow | null): void {
  logger.warn('AEGIS_TEST_MODE=1: test-only IPC hooks registered (spawn/crash/retire fixture workers). Not for normal use.');
  let swarm: SwarmManager | null = null;

  registerTypedHandler<{ count: number; url: string }, { ids: string[] }>(IPC_CHANNELS.TEST_SPAWN_WORKERS, getChrome, async (req) => {
    const count = Math.max(1, Math.min(24, Number(req?.count) || 1));
    if (!swarm) swarm = new SwarmManager({ maxWorkers: 24, missionId: 'e2e-grid', parentWindow: parentWindow || null });
    const workers = await swarm.spawnSwarm(count, 'fixture');
    for (const w of workers) {
      w.navigate(String(req.url)).catch(err => logger.warn('fixture worker navigation failed', { workerId: w.id, error: err.message }));
    }
    return { ids: workers.map(w => w.id) };
  });

  registerTypedHandler<{ action: WorkerAction; id?: string; x?: number; y?: number }, unknown>(IPC_CHANNELS.TEST_WORKER_ACTION, getChrome, async (req) => {
    const id = String(req?.id || '');
    const w = viewManager.getWorker(id);
    switch (req?.action) {
      case 'hubStats':
        return viewManager.frameHub.allStats();
      case 'restoreWindow':
        // The chrome renderer cannot un-minimise its own window; the driver needs this to test minimise/restore.
        parentWindow?.restore();
        return true;
      case 'shutdown':
        await swarm?.shutdown();
        swarm = null;
        return true;
      case 'retire':
        await swarm?.retireWorker(id);
        return true;
      case 'crash':
        if (!w) throw new Error(`no worker ${id}`);
        w.webContents.forcefullyCrashRenderer();
        return true;
      case 'recover':
        if (!w) throw new Error(`no worker ${id}`);
        return w.recover();
      case 'viewport':
        if (!w) throw new Error(`no worker ${id}`);
        return {
          zoom: w.webContents.getZoomFactor(),
          page: await w.webContents.executeJavaScript('({ innerWidth, innerHeight, dpr: devicePixelRatio, visibility: document.visibilityState, clicks: window.__clicks || 0, raf: window.__raf || 0, tmr: window.__tmr || 0 })')
        };
      case 'click':
        // The agent's own input path: ActionExecutor -> CDP Input.dispatchMouseEvent at page (CSS px) coordinates.
        if (!w) throw new Error(`no worker ${id}`);
        await w.executor.clickAt(Number(req.x), Number(req.y));
        return true;
      default:
        throw new Error(`unknown test action ${String(req?.action)}`);
    }
  });
}
