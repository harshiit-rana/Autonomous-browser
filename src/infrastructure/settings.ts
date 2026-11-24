import { rootLogger } from './logger.js';
import { credentialVault } from './credentials.js';
import type { SettingsRepo } from './repos/settings_repo.js';
import type { PrivacyMode } from '../security/privacy_governor.js';
import type { PolicyRule } from '../security/action_policy.js';

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
  defaultSearchEngine: string;
  maxConcurrency: number;
  telemetryEnabled: boolean;
  /** Privacy mode applied to every agent observation (#225; was hardcoded 'Careful'). */
  privacyMode: PrivacyMode;
  /** User policy rules applied by the action policy engine for every mission (#225). */
  policyRules: PolicyRule[];
  /** Default step budget and cost cap of a single-agent mission; a mission brief may lower them (#225). */
  maxSteps: number;
  maxCostUSD: number;
  /** Model used by the completion verifier; empty = the mission's own model (#225). */
  verifierModel: string;
  /** Swarm workers that run at the same time (#227). Default 3; consumers clamp to 1..8 with `clampMaxWorkers`. */
  maxWorkers: number;
}

export const MAX_WORKERS_HARD_LIMIT = 8;
export const DEFAULT_MAX_WORKERS = 3;

/** Whatever is stored, a swarm never runs fewer than 1 or more than 8 workers at once. */
export function clampMaxWorkers(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : DEFAULT_MAX_WORKERS;
  return Math.max(1, Math.min(MAX_WORKERS_HARD_LIMIT, n));
}

export const CURRENT_SETTINGS_VERSION = 2;

/**
 * Settings migrations, applied in order to the stored rows on load. Each takes the stored object (from version
 * `from`) and returns the fields to write. v1 -> v2 (#225): agent loop keys with safe defaults.
 */
export const SETTINGS_MIGRATIONS: Array<{ from: number; to: number; migrate: (stored: Record<string, unknown>) => Record<string, unknown> }> = [
  {
    from: 1,
    to: 2,
    migrate: stored => ({
      privacyMode: stored.privacyMode ?? 'Careful',
      policyRules: Array.isArray(stored.policyRules) ? stored.policyRules : [],
      maxSteps: typeof stored.maxSteps === 'number' ? stored.maxSteps : 25,
      maxCostUSD: typeof stored.maxCostUSD === 'number' ? stored.maxCostUSD : 1,
      verifierModel: typeof stored.verifierModel === 'string' ? stored.verifierModel : ''
    })
  }
];

/** Runs every migration needed to bring `stored` (version `stored.version`, default 1) to the current version. */
export function migrateSettings(stored: Record<string, unknown>): { fields: Record<string, unknown>; changed: boolean } {
  let version = typeof stored.version === 'number' ? stored.version : 1;
  let fields = { ...stored };
  let changed = false;
  for (const m of SETTINGS_MIGRATIONS) {
    if (version === m.from) {
      fields = { ...fields, ...m.migrate(fields), version: m.to };
      version = m.to;
      changed = true;
    }
  }
  return { fields, changed };
}

export const DEFAULT_SETTINGS: AppSettings = {
  version: CURRENT_SETTINGS_VERSION,
  modelProvider: 'gemini',
  modelName: 'gemini-2.0-flash',
  apiKeys: {},
  ollamaBaseUrl: 'http://localhost:11434',
  defaultSearchEngine: 'https://duckduckgo.com/?q=',
  maxConcurrency: 3,
  telemetryEnabled: false,
  privacyMode: 'Careful',
  policyRules: [],
  maxSteps: 25,
  maxCostUSD: 1,
  verifierModel: '',
  maxWorkers: DEFAULT_MAX_WORKERS
};

const logger = rootLogger.child('settings');

/** Settings removed from the product (demoMode, #224): ignored on load and on update so a stale stored value cannot revive them. */
const REMOVED_SETTING_KEYS = new Set(['demoMode']);

const API_KEY_PROVIDERS =['gemini', 'anthropic', 'openai'] as const;

/**
 * Settings live in the SQLite `settings` table (one row per field). API keys are never written to the database:
 * they are stored through the OS-backed credential vault (Electron safeStorage). Until `attachRepo` is called
 * (tests, early startup) settings are in-memory defaults.
 */
export class SettingsManager {
  private static instance: SettingsManager | null = null;
  private currentSettings: AppSettings = { ...DEFAULT_SETTINGS, apiKeys: {} };
  private repo: SettingsRepo | null = null;

  private constructor() {}

  public static getInstance(): SettingsManager {
    if (!SettingsManager.instance) {
      SettingsManager.instance = new SettingsManager();
    }
    return SettingsManager.instance;
  }

  /** Binds the manager to the database and loads persisted settings. */
  public attachRepo(repo: SettingsRepo): AppSettings {
    this.repo = repo;
    return this.load();
  }

  public detachRepo(): void {
    this.repo = null;
  }

  public load(): AppSettings {
    const merged: AppSettings = { ...DEFAULT_SETTINGS, apiKeys: {} };
    if (this.repo) {
      try {
        const raw = this.repo.all();
        const hasRows = Object.keys(raw).length > 0;
        const { fields: stored, changed } = hasRows ? migrateSettings(raw) : { fields: raw, changed: false };
        for (const [k, v] of Object.entries(stored)) {
          if (k === 'apiKeys' || REMOVED_SETTING_KEYS.has(k)) continue;
          (merged as any)[k] = v;
        }
        if (changed) {
          const { apiKeys: _k, ...plain } = stored as any;
          for (const k of REMOVED_SETTING_KEYS) delete plain[k];
          this.repo.setMany(plain);
          logger.info('Settings migrated', { from: raw.version ?? 1, to: CURRENT_SETTINGS_VERSION });
        }
        merged.version = CURRENT_SETTINGS_VERSION;
      } catch (err: any) {
        logger.error('Failed to read settings from database, using defaults', err);
      }
    }
    merged.apiKeys = this.readApiKeys();
    this.currentSettings = merged;
    return this.currentSettings;
  }

  private readApiKeys(): AppSettings['apiKeys'] {
    const keys: AppSettings['apiKeys'] = {};
    for (const p of API_KEY_PROVIDERS) {
      try {
        const k = credentialVault.getKeySync(p);
        if (k) keys[p] = k;
      } catch {
        // vault unavailable (e.g. before app ready); keys resolve lazily on next load()
      }
    }
    return keys;
  }

  public getSettings(): AppSettings {
    return { ...this.currentSettings, apiKeys: { ...this.currentSettings.apiKeys } };
  }

  public updateSettings(patch: Partial<AppSettings>): AppSettings {
    const { apiKeys, ...rest } = patch;
    for (const k of REMOVED_SETTING_KEYS) delete (rest as Record<string, unknown>)[k];
    this.currentSettings = {
      ...this.currentSettings,
      ...rest,
      apiKeys: { ...this.currentSettings.apiKeys, ...(apiKeys || {}) }
    };
    this.persist(rest, apiKeys);
    return this.getSettings();
  }

  public resetSettings(): AppSettings {
    for (const p of API_KEY_PROVIDERS) {
      void credentialVault.deleteKey(p);
    }
    this.currentSettings = { ...DEFAULT_SETTINGS, apiKeys: {} };
    this.persist({ ...DEFAULT_SETTINGS } as Partial<AppSettings>, undefined);
    return this.getSettings();
  }

  private persist(fields: Partial<AppSettings>, apiKeys: AppSettings['apiKeys'] | undefined): void {
    if (apiKeys) {
      for (const [provider, key] of Object.entries(apiKeys)) {
        void credentialVault.setKey(provider, key || '');
      }
    }
    if (!this.repo) return;
    try {
      const { apiKeys: _ignored, ...plain } = fields as any;
      this.repo.setMany({ ...plain, version: CURRENT_SETTINGS_VERSION });
    } catch (err: any) {
      logger.error('Failed to write settings to database', err);
    }
  }
}

export function getSettings(): AppSettings {
  return SettingsManager.getInstance().getSettings();
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  return SettingsManager.getInstance().updateSettings(patch);
}
