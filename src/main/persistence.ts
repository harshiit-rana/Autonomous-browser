/**
 * Main-process wiring for the SQLite persistence layer (Issue #239).
 *
 * `initialisePersistence()` runs once after `app.whenReady()`: opens `<userData>/aegis.sqlite`, offers restore on
 * corruption, imports the legacy JSON stores once, binds settings to the database, and closes interrupted missions.
 * `registerPersistenceIPC()` exposes mission history and data export/import to the chrome renderer.
 */

import { app, dialog, BrowserWindow, WebContents } from 'electron';
import * as path from 'node:path';
import { getAppPaths } from '../infrastructure/paths.js';
import { rootLogger } from '../infrastructure/logger.js';
import {
  AegisDb,
  DbError,
  getDb,
  hasDb,
  openWithRecovery,
  setDb,
  type BackupInfo,
  type RecoveryChoice
} from '../infrastructure/db.js';
import { getRepos } from '../infrastructure/repos/index.js';
import { SettingsManager } from '../infrastructure/settings.js';
import { credentialVault } from '../infrastructure/credentials.js';
import { importLegacyCheckpoints, importLegacySettings } from '../infrastructure/legacy_import.js';
import { MissionRecorder } from '../infrastructure/mission_recorder.js';
import { exportData, importData } from '../infrastructure/data_transfer.js';
import { registerTypedHandler } from '../ipc/main_handler.js';
import { AgentRuntime } from '../agent/runtime.js';
import {
  IPC_CHANNELS,
  type DataTransferResult,
  type MissionEventsRequest,
  type MissionEventsResponse,
  type MissionHistoryItem
} from '../ipc/contract.js';

const logger = rootLogger.child('persistence');

function chooseRecovery(err: DbError, backups: BackupInfo[]): RecoveryChoice {
  const newest = backups[0];
  const buttons = newest ? ['Restore latest backup', 'Start with a fresh database', 'Quit'] : ['Start with a fresh database', 'Quit'];
  const idx = dialog.showMessageBoxSync({
    type: 'error',
    title: 'Autonomous Browser - database problem',
    message: 'Your data file is damaged and cannot be opened.',
    detail:
      `${err.message}\n\n` +
      (newest
        ? `The newest backup is ${path.basename(newest.path)} (${new Date(newest.mtimeMs).toLocaleString()}). The damaged file will be kept next to it with a ".corrupt-" suffix.`
        : 'No backup is available. The damaged file will be kept next to the new one with a ".corrupt-" suffix.'),
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
    noLink: true
  });
  const label = buttons[idx];
  if (label === 'Restore latest backup' && newest) return { action: 'restore', backup: newest };
  if (label === 'Start with a fresh database') return { action: 'fresh' };
  return { action: 'quit' };
}

/** Returns the open database, or null if startup must be aborted (the app is already quitting). */
export function initialisePersistence(): AegisDb | null {
  const paths = getAppPaths();
  let db: AegisDb | null;
  try {
    const result = openWithRecovery(paths.database, chooseRecovery);
    db = result.db;
    if (result.recovered === 'quit') {
      logger.warn('User chose to quit after database corruption');
      app.exit(1);
      return null;
    }
    if (result.recovered !== 'none') {
      logger.warn('Database recovered after corruption', { recovered: result.recovered, quarantinedTo: result.quarantinedTo });
    }
  } catch (err: any) {
    const e = err instanceof DbError ? err : new DbError('unknown', err?.message ?? String(err), err);
    logger.error('Database could not be opened', err, { code: e.code });
    dialog.showErrorBox('Autonomous Browser cannot open its data file', `${e.message}\n\nFile: ${paths.database}`);
    app.exit(1);
    return null;
  }
  if (!db) return null;
  setDb(db);

  const repos = getRepos();
  const settingsReport = importLegacySettings(paths.userData, repos.settings, (provider, key) => {
    void credentialVault.setKey(provider, key);
  });
  const ckptReport = importLegacyCheckpoints(paths.userData, repos.missions);
  if (settingsReport.settingsImported || ckptReport.checkpointsImported || settingsReport.errors.length || ckptReport.errors.length) {
    logger.info('Legacy JSON import', { ...settingsReport, ...ckptReport });
  }
  SettingsManager.getInstance().attachRepo(repos.settings);
  const interrupted = MissionRecorder.recoverInterrupted();
  logger.info('Persistence ready', { file: paths.database, schemaVersion: db.schemaVersion, interruptedMissions: interrupted });

  let snapshotted = false;
  app.on('before-quit', () => {
    if (snapshotted || !hasDb()) return;
    snapshotted = true;
    try {
      getDb().snapshotForRecovery();
    } catch (err: any) {
      logger.warn('Could not write recovery snapshot', { error: err.message });
    }
  });
  app.on('will-quit', () => {
    try {
      if (hasDb()) getDb().close();
    } catch (err: any) {
      logger.warn('Error closing database', { error: err.message });
    }
  });
  return db;
}

export function registerPersistenceIPC(getWindow: () => BrowserWindow | null): void {
  const getChrome = (): WebContents | null => getWindow()?.webContents ?? null;

  registerTypedHandler<{ limit?: number } | undefined, MissionHistoryItem[]>(IPC_CHANNELS.MISSIONS_LIST, getChrome, req => {
    return getRepos()
      .missions.listMissions({ limit: req?.limit ?? 50 })
      .map(m => ({
        id: m.id,
        prompt: m.prompt,
        model: m.model,
        state: m.state,
        stepCount: m.stepCount,
        result: m.result,
        error: m.error,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt
      }));
  });

  registerTypedHandler<MissionEventsRequest, MissionEventsResponse>(IPC_CHANNELS.MISSION_EVENTS_GET, getChrome, req => {
    if (!req || typeof req.missionId !== 'string') throw new Error('missionId is required');
    const repos = getRepos();
    const page = repos.missions.listEvents(req.missionId, { afterSeq: req.afterSeq, limit: req.limit });
    return {
      events: page.events.map(e => ({ seq: e.seq, ts: e.ts, kind: e.kind, data: e.data })),
      nextAfterSeq: page.nextAfterSeq,
      total: repos.missions.countEvents(req.missionId)
    };
  });

  registerTypedHandler<void, DataTransferResult>(IPC_CHANNELS.DATA_EXPORT, getChrome, async () => {
    const win = getWindow();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const pick = await dialog.showSaveDialog(win!, {
      title: 'Export Autonomous Browser data',
      defaultPath: path.join(app.getPath('documents'), `autonomous-browser-export-${stamp}.zip`),
      filters: [{ name: 'Zip archive', extensions: ['zip'] }]
    });
    if (pick.canceled || !pick.filePath) return { cancelled: true, message: 'Export cancelled' };
    const manifest = exportData(getDb(), getAppPaths().userData, pick.filePath);
    return {
      path: pick.filePath,
      message: `Exported ${manifest.files.length} files (database schema ${manifest.schemaVersion}). API keys and the credential vault are not included.`
    };
  });

  registerTypedHandler<void, DataTransferResult>(IPC_CHANNELS.DATA_IMPORT, getChrome, async () => {
    const win = getWindow();
    const active = AgentRuntime.getInstance().getActiveMission();
    if (active && ['planning', 'running', 'paused'].includes(active.state)) {
      throw new Error('Stop the running mission before importing data.');
    }
    const pick = await dialog.showOpenDialog(win!, {
      title: 'Import Autonomous Browser data',
      properties: ['openFile'],
      filters: [{ name: 'Zip archive', extensions: ['zip'] }]
    });
    if (pick.canceled || !pick.filePaths[0]) return { cancelled: true, message: 'Import cancelled' };
    const confirm = dialog.showMessageBoxSync(win!, {
      type: 'warning',
      title: 'Replace current data?',
      message: 'Importing replaces your missions, history and settings with the contents of the archive.',
      detail: 'Your current database is kept as a backup file next to it. The app will restart afterwards.',
      buttons: ['Import and restart', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    });
    if (confirm !== 0) return { cancelled: true, message: 'Import cancelled' };

    const paths = getAppPaths();
    const result = importData({
      zipPath: pick.filePaths[0],
      userData: paths.userData,
      dbFile: paths.database,
      closeLiveDb: () => {
        getDb().close();
        setDb(null);
      }
    });
    logger.info('Data import complete; restarting', { ...result });
    setTimeout(() => {
      app.relaunch();
      app.exit(0);
    }, 300);
    return { path: pick.filePaths[0], message: `Imported ${result.filesRestored} files. Restarting...` };
  });
}
