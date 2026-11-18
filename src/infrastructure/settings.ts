import * as fs from 'node:fs';
import * as path from 'node:path';
import { getAppPaths } from './paths.js';
import { rootLogger } from './logger.js';

export interface AppSettings {
  version: number;
  modelProvider: 'gemini' | 'anthropic' | 'openai' | 'ollama' | 'local';
  modelName: string;
  apiKeys: {
    gemini?: string;
    anthropic?: string;
    openai?: string;
  };
  ollamaBaseUrl?: string;
  demoMode: boolean;
  defaultSearchEngine: string;
  maxConcurrency: number;
  telemetryEnabled: boolean;
}

const CURRENT_SETTINGS_VERSION = 1;

export const DEFAULT_SETTINGS: AppSettings = {
  version: CURRENT_SETTINGS_VERSION,
  modelProvider: 'gemini',
  modelName: 'gemini-2.0-flash',
  apiKeys: {},
  ollamaBaseUrl: 'http://localhost:11434',
  demoMode: false,
  defaultSearchEngine: 'https://duckduckgo.com/?q=',
  maxConcurrency: 3,
  telemetryEnabled: false
};

const logger = rootLogger.child('settings');

export class SettingsManager {
  private static instance: SettingsManager | null = null;
  private currentSettings: AppSettings = { ...DEFAULT_SETTINGS };
  private settingsFilePath: string | null = null;

  private constructor() {
    try {
      const paths = getAppPaths();
      this.settingsFilePath = path.join(paths.userData, 'settings.json');
      this.load();
    } catch (err: any) {
      logger.warn('Paths not yet initialized, running with in-memory defaults', { error: err.message });
    }
  }

  public static getInstance(): SettingsManager {
    if (!SettingsManager.instance) {
      SettingsManager.instance = new SettingsManager();
    }
    return SettingsManager.instance;
  }

  public load(): AppSettings {
    if (!this.settingsFilePath) {
      return this.currentSettings;
    }

    try {
      if (fs.existsSync(this.settingsFilePath)) {
        const raw = fs.readFileSync(this.settingsFilePath, 'utf-8');
        const parsed = JSON.parse(raw);
        this.currentSettings = this.migrate({ ...DEFAULT_SETTINGS, ...parsed });
      } else {
        this.currentSettings = { ...DEFAULT_SETTINGS };
        this.save();
      }
    } catch (err: any) {
      logger.error('Failed to parse settings.json, falling back to defaults', err);
      this.currentSettings = { ...DEFAULT_SETTINGS };
    }

    return this.currentSettings;
  }

  private migrate(loaded: AppSettings): AppSettings {
    if (!loaded.version || loaded.version < CURRENT_SETTINGS_VERSION) {
      logger.info('Migrating settings schema', { from: loaded.version, to: CURRENT_SETTINGS_VERSION });
      loaded.version = CURRENT_SETTINGS_VERSION;
      this.saveSettingsToFile(loaded);
    }
    return loaded;
  }

  public getSettings(): AppSettings {
    return { ...this.currentSettings };
  }

  public updateSettings(patch: Partial<AppSettings>): AppSettings {
    this.currentSettings = {
      ...this.currentSettings,
      ...patch,
      apiKeys: {
        ...this.currentSettings.apiKeys,
        ...(patch.apiKeys || {})
      }
    };
    this.save();
    return this.currentSettings;
  }

  public resetSettings(): AppSettings {
    this.currentSettings = { ...DEFAULT_SETTINGS };
    this.save();
    return this.currentSettings;
  }

  private save(): void {
    if (!this.settingsFilePath) return;
    this.saveSettingsToFile(this.currentSettings);
  }

  private saveSettingsToFile(settings: AppSettings): void {
    if (!this.settingsFilePath) return;
    try {
      const dir = path.dirname(this.settingsFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Atomic file write using temp file + rename
      const tempPath = `${this.settingsFilePath}.tmp.${Date.now()}`;
      fs.writeFileSync(tempPath, JSON.stringify(settings, null, 2), 'utf-8');
      fs.renameSync(tempPath, this.settingsFilePath);
      logger.info('Settings saved successfully');
    } catch (err: any) {
      logger.error('Failed to write settings to disk', err);
    }
  }
}

export function getSettings(): AppSettings {
  return SettingsManager.getInstance().getSettings();
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  return SettingsManager.getInstance().updateSettings(patch);
}
