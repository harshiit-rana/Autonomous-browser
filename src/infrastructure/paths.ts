import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

export interface AppPaths {
  isPortable: boolean;
  userData: string;
  sessionData: string;
  diskCache: string;
  database: string;
  vault: string;
  logs: string;
  recordings: string;
  downloads: string;
}

let cachedPaths: AppPaths | null = null;

export function initializeAppPaths(): AppPaths {
  if (cachedPaths) return cachedPaths;

  const appDir = path.dirname(app.getPath('exe'));
  const isPortableFlag = process.argv.includes('--portable') ||
    fs.existsSync(path.join(appDir, '.portable')) ||
    Boolean(process.env.AEGIS_PORTABLE);

  let userDir: string;
  if (isPortableFlag) {
    userDir = path.join(appDir, 'data');
  } else if (process.env.AEGIS_USER_DATA) {
    userDir = path.resolve(process.env.AEGIS_USER_DATA);
  } else {
    userDir = path.join(app.getPath('appData'), 'autonomous-browser');
  }

  if (!fs.existsSync(userDir)) {
    fs.mkdirSync(userDir, { recursive: true });
  }

  const sessionDir = path.join(userDir, 'session');
  const cacheDir = path.join(userDir, 'cache');
  const logsDir = path.join(userDir, 'logs');
  const recordingsDir = path.join(userDir, 'recordings');
  const downloadsDir = path.join(userDir, 'downloads');

  [sessionDir, cacheDir, logsDir, recordingsDir, downloadsDir].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });

  cachedPaths = {
    isPortable: isPortableFlag,
    userData: userDir,
    sessionData: sessionDir,
    diskCache: cacheDir,
    database: path.join(userDir, 'aegis.sqlite'),
    vault: path.join(userDir, 'vault.enc'),
    logs: logsDir,
    recordings: recordingsDir,
    downloads: downloadsDir
  };

  return cachedPaths;
}

export function getAppPaths(): AppPaths {
  if (!cachedPaths) {
    return initializeAppPaths();
  }
  return cachedPaths;
}
