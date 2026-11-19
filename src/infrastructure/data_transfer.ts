/**
 * Backup / restore of user data (Issue #239 step 6): Settings -> "Export data" / "Import data".
 *
 * Export = zip containing a consistent snapshot of the database (via VACUUM INTO, so WAL contents are included),
 * the `missions/` and `deliverables/` folders, and a manifest with SHA-256 checksums.
 * Secrets are excluded by construction: only those two folders and the snapshot are read. `vault.enc`,
 * `settings.json` (legacy, may hold plain-text keys), logs and browser session data are never added. As defence in
 * depth the snapshot's `settings` table is scrubbed of any `apiKeys` row.
 *
 * Import validates the manifest, every checksum, path safety (zip-slip), and that the database opens and
 * migrates; only then is the live database replaced (the previous file is kept as `<db>.bak-pre-import`).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { unzipSync, zipSync } from 'fflate';
import { AegisDb, DbError, loadMigrations, retryTransient } from './db.js';

export const EXPORT_FORMAT = 'aegis-export';
export const EXPORT_VERSION = 1;
const DB_ENTRY = 'aegis.sqlite';
const DIR_ENTRIES = ['missions', 'deliverables'] as const;

export interface ExportManifest {
  format: typeof EXPORT_FORMAT;
  version: number;
  schemaVersion: number;
  createdAt: string;
  files: Array<{ path: string; bytes: number; sha256: string }>;
}

const sha256 = (b: Uint8Array): string => crypto.createHash('sha256').update(b).digest('hex');

function collectFiles(root: string, rel: string, out: Record<string, Uint8Array>): void {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const childRel = `${rel}/${entry.name}`;
    if (entry.isDirectory()) collectFiles(root, childRel, out);
    else if (entry.isFile() && !entry.name.endsWith('.tmp')) out[childRel] = new Uint8Array(fs.readFileSync(path.join(root, childRel)));
  }
}

export function exportData(db: AegisDb, userData: string, destZip: string): ExportManifest {
  const tmpDb = `${destZip}.snapshot.tmp`;
  try {
    db.backupTo(tmpDb);
    const snap = AegisDb.open(tmpDb, { readonly: false });
    try {
      snap.handle.prepare("DELETE FROM settings WHERE key = 'apiKeys'").run();
      snap.handle.exec('VACUUM');
    } finally {
      snap.close();
    }
    const files: Record<string, Uint8Array> = { [DB_ENTRY]: new Uint8Array(fs.readFileSync(tmpDb)) };
    for (const d of DIR_ENTRIES) collectFiles(userData, d, files);

    const manifest: ExportManifest = {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      schemaVersion: db.schemaVersion,
      createdAt: new Date().toISOString(),
      files: Object.entries(files).map(([p, b]) => ({ path: p, bytes: b.length, sha256: sha256(b) }))
    };
    const zipped = zipSync({ ...files, 'manifest.json': new TextEncoder().encode(JSON.stringify(manifest, null, 2)) }, { level: 6 });
    fs.mkdirSync(path.dirname(destZip), { recursive: true });
    const part = `${destZip}.part`;
    fs.writeFileSync(part, zipped);
    retryTransient(() => fs.renameSync(part, destZip));
    return manifest;
  } finally {
    for (const p of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(p, { force: true });
  }
}

export interface ImportOptions {
  zipPath: string;
  userData: string;
  dbFile: string;
  /** Must close the live database before the file is replaced. */
  closeLiveDb: () => void;
}

export interface ImportResult {
  schemaVersion: number;
  filesRestored: number;
  previousDbBackup: string;
}

function isSafeEntry(name: string): boolean {
  if (!name || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) return false;
  const parts = name.split('/');
  if (parts.some(p => p === '' || p === '.' || p === '..')) return false;
  return name === DB_ENTRY || name === 'manifest.json' || (DIR_ENTRIES as readonly string[]).includes(parts[0]);
}

/** Validates an export archive without touching live data. Throws DbError('migration-failed') describing the problem. */
export function verifyExport(zipPath: string): { manifest: ExportManifest; entries: Record<string, Uint8Array> } {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(fs.readFileSync(zipPath)));
  } catch (err: any) {
    throw new DbError('migration-failed', `Not a valid export archive: ${err.message}`);
  }
  for (const name of Object.keys(entries)) {
    if (name.endsWith('/')) continue; // directory marker
    if (!isSafeEntry(name)) throw new DbError('migration-failed', `Unsafe or unexpected entry in archive: ${name}`);
  }
  const rawManifest = entries['manifest.json'];
  if (!rawManifest) throw new DbError('migration-failed', 'Archive has no manifest.json');
  let manifest: ExportManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(rawManifest));
  } catch {
    throw new DbError('migration-failed', 'manifest.json is not valid JSON');
  }
  if (manifest.format !== EXPORT_FORMAT || manifest.version !== EXPORT_VERSION) {
    throw new DbError('migration-failed', `Unsupported export format ${manifest.format} v${manifest.version}`);
  }
  const known = new Set(manifest.files.map(f => f.path));
  for (const f of manifest.files) {
    if (!isSafeEntry(f.path)) throw new DbError('migration-failed', `Unsafe path in manifest: ${f.path}`);
    const data = entries[f.path];
    if (!data) throw new DbError('migration-failed', `Archive is missing ${f.path}`);
    if (data.length !== f.bytes || sha256(data) !== f.sha256) throw new DbError('migration-failed', `Checksum mismatch for ${f.path}; the archive is damaged or was modified.`);
  }
  for (const name of Object.keys(entries)) {
    if (name !== 'manifest.json' && !name.endsWith('/') && !known.has(name)) throw new DbError('migration-failed', `Entry not listed in manifest: ${name}`);
  }
  if (!entries[DB_ENTRY]) throw new DbError('migration-failed', 'Archive has no database snapshot');
  if (manifest.schemaVersion > loadMigrations().length) {
    throw new DbError('newer-schema', `Archive was created by a newer app version (schema ${manifest.schemaVersion}).`);
  }
  return { manifest, entries };
}

export function importData(opts: ImportOptions): ImportResult {
  const { manifest, entries } = verifyExport(opts.zipPath);

  // Prove the snapshot opens, passes quick_check and migrates BEFORE touching live data.
  const staging = `${opts.dbFile}.import-tmp`;
  for (const p of [staging, `${staging}-wal`, `${staging}-shm`]) fs.rmSync(p, { force: true });
  fs.writeFileSync(staging, entries[DB_ENTRY]);
  let migratedVersion: number;
  try {
    const probe = AegisDb.open(staging);
    migratedVersion = probe.schemaVersion;
    probe.close();
  } catch (err) {
    for (const p of [staging, `${staging}-wal`, `${staging}-shm`]) fs.rmSync(p, { force: true });
    throw err;
  }

  opts.closeLiveDb();
  const previousDbBackup = `${opts.dbFile}.bak-pre-import`;
  try {
    if (fs.existsSync(opts.dbFile)) retryTransient(() => fs.copyFileSync(opts.dbFile, previousDbBackup));
    for (const s of ['-wal', '-shm']) fs.rmSync(`${opts.dbFile}${s}`, { force: true });
    retryTransient(() => fs.renameSync(staging, opts.dbFile));
    for (const s of ['-wal', '-shm']) fs.rmSync(`${staging}${s}`, { force: true });
  } catch (err) {
    // Put the original back if the swap failed half-way.
    if (fs.existsSync(previousDbBackup) && !fs.existsSync(opts.dbFile)) fs.copyFileSync(previousDbBackup, opts.dbFile);
    throw err;
  }

  let restored = 1;
  for (const f of manifest.files) {
    if (f.path === DB_ENTRY) continue;
    const target = path.join(opts.userData, ...f.path.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entries[f.path]);
    restored++;
  }
  return { schemaVersion: migratedVersion, filesRestored: restored, previousDbBackup };
}
