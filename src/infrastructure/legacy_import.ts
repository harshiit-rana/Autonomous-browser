/**
 * One-time import of the pre-SQLite JSON stores (Issue #239 step 5).
 *
 * - `<userData>/settings.json`           -> settings table (+ API keys to the credential vault)
 * - `<userData>/missions/<id>.json`      -> missions table (checkpoints written by the old runtime)
 *
 * Originals are NEVER deleted. A `.migrated` marker is written next to them so the import runs exactly once.
 * (Plain-text API keys in the original settings.json stay on disk because originals are never touched; the
 * report returned here lets the UI tell the user they can delete the file.)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SettingsRepo } from './repos/settings_repo.js';
import type { MissionsRepo, PersistedMissionState } from './repos/missions_repo.js';

export interface LegacyImportReport {
  settingsImported: boolean;
  settingsFields: number;
  apiKeysImported: number;
  checkpointsImported: number;
  checkpointsSkipped: number;
  errors: string[];
}

const VALID_STATES = new Set<string>(['idle', 'planning', 'running', 'paused', 'completed', 'failed', 'cancelled']);

function writeMarker(markerPath: string, info: Record<string, unknown>): void {
  fs.writeFileSync(markerPath, JSON.stringify({ migratedAt: new Date().toISOString(), ...info }, null, 2), 'utf8');
}

export function importLegacySettings(
  userData: string,
  settings: SettingsRepo,
  storeApiKey: (provider: string, key: string) => void
): Pick<LegacyImportReport, 'settingsImported' | 'settingsFields' | 'apiKeysImported' | 'errors'> {
  const file = path.join(userData, 'settings.json');
  const marker = `${file}.migrated`;
  const out = { settingsImported: false, settingsFields: 0, apiKeysImported: 0, errors: [] as string[] };
  if (!fs.existsSync(file) || fs.existsSync(marker)) return out;

  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('settings.json is not an object');
    const { apiKeys, ...rest } = parsed as Record<string, any>;
    // Do not overwrite values the user already set in the database.
    const existing = settings.all();
    const toWrite: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) {
      if (!(k in existing)) toWrite[k] = v;
    }
    settings.setMany(toWrite);
    out.settingsFields = Object.keys(toWrite).length;
    if (apiKeys && typeof apiKeys === 'object') {
      for (const [provider, key] of Object.entries(apiKeys as Record<string, unknown>)) {
        if (typeof key === 'string' && key.trim()) {
          storeApiKey(provider, key.trim());
          out.apiKeysImported++;
        }
      }
    }
    writeMarker(marker, { source: file, fields: out.settingsFields, apiKeys: out.apiKeysImported });
    out.settingsImported = true;
  } catch (err: any) {
    // No marker on failure: a corrupt file is retried (and reported) on the next start without losing the original.
    out.errors.push(`settings.json: ${err.message}`);
  }
  return out;
}

export function importLegacyCheckpoints(
  userData: string,
  missions: MissionsRepo
): Pick<LegacyImportReport, 'checkpointsImported' | 'checkpointsSkipped' | 'errors'> {
  const dir = path.join(userData, 'missions');
  const marker = path.join(dir, '.migrated');
  const out = { checkpointsImported: 0, checkpointsSkipped: 0, errors: [] as string[] };
  if (!fs.existsSync(dir) || fs.existsSync(marker)) return out;

  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.json')).sort()) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (!d || typeof d.id !== 'string' || typeof d.prompt !== 'string') throw new Error('missing id/prompt');
      if (missions.getMission(d.id)) {
        out.checkpointsSkipped++;
        continue;
      }
      let state: PersistedMissionState = VALID_STATES.has(d.state) ? d.state : 'failed';
      // A checkpoint that says "running" belongs to a process that no longer exists.
      if (state === 'running' || state === 'planning' || state === 'paused') state = 'failed';
      const updatedAt = typeof d.updatedAt === 'number' ? d.updatedAt : Date.now();
      missions.upsertMission({
        id: d.id,
        prompt: d.prompt,
        model: typeof d.model === 'string' ? d.model : 'unknown',
        state,
        stepCount: Number(d.stepCount) || 0,
        tabId: typeof d.tabId === 'string' ? d.tabId : undefined,
        result: typeof d.result === 'string' ? d.result : undefined,
        error: typeof d.error === 'string' ? d.error : state === 'failed' && d.state !== 'failed' ? 'Interrupted before the database migration' : undefined,
        evidenceCount: Number(d.evidenceCount) || 0,
        createdAt: updatedAt,
        updatedAt,
        importedFrom: f
      });
      out.checkpointsImported++;
    } catch (err: any) {
      out.checkpointsSkipped++;
      out.errors.push(`missions/${f}: ${err.message}`);
    }
  }
  try {
    writeMarker(marker, { imported: out.checkpointsImported, skipped: out.checkpointsSkipped });
  } catch (err: any) {
    out.errors.push(`marker: ${err.message}`);
  }
  return out;
}
