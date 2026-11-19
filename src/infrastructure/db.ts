/**
 * Project Aegis - SQLite persistence core (Issue #239 PST-01).
 *
 * - better-sqlite3 (native, prebuilt for Electron ABI 130 / Node 20; see docs/adr/0013-database.md)
 * - WAL journal, foreign keys ON, busy_timeout, quick_check on open
 * - forward-only migrations from `migrations/NNNN_name.sql`, each applied in its own transaction,
 *   with a consistent pre-migration backup (`<db>.bak-<version>`) and automatic restore on failure
 * - typed error mapping (disk full, read-only profile, lock contention, corruption)
 *
 * This module intentionally does NOT import `electron`: callers pass the database path in, so it also runs
 * under plain Node (tests, CLI). SQL lives only here and in `repos/*.ts`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import Database from 'better-sqlite3';

export type DbErrorCode =
  | 'disk-full'
  | 'read-only'
  | 'locked'
  | 'corrupt'
  | 'constraint'
  | 'migration-failed'
  | 'newer-schema'
  | 'native-binding'
  | 'unknown';

export class DbError extends Error {
  constructor(public readonly code: DbErrorCode, message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'DbError';
  }
}

export type SqliteHandle = Database.Database;

export interface MigrationFile {
  version: number;
  name: string;
  file: string;
  sql: string;
  checksum: string;
}

export interface OpenOptions {
  /** Directory holding NNNN_name.sql files. Defaults to the migrations folder next to this module. */
  migrationsDir?: string;
  /** Stop after this schema version (used by tests to build "previous version" databases). */
  maxVersion?: number;
  /** Custom busy timeout in ms (default 5000). */
  busyTimeoutMs?: number;
  /** Open an existing file read-only (no migrations, no WAL pragma). */
  readonly?: boolean;
  /** Override for the native binding path (otherwise resolved automatically, see resolveNativeBinding). */
  nativeBinding?: string;
  /** Sleep used by the retry helper; injectable for tests. */
  sleep?: (ms: number) => void;
}

const MIGRATION_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export function defaultMigrationsDir(): string {
  return path.join(__dirname, 'migrations');
}

export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const TRANSIENT_FS_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'EMFILE', 'ENFILE']);

/**
 * Retries a synchronous operation that fails with a transient file-lock error. On Windows an antivirus scanner or
 * indexer commonly holds the file for a few hundred milliseconds. Backoff: base, 2*base, 4*base ... (capped).
 */
export function retryTransient<T>(
  fn: () => T,
  opts: { attempts?: number; baseMs?: number; maxMs?: number; sleep?: (ms: number) => void; onRetry?: (err: any, attempt: number) => void } = {}
): T {
  const attempts = opts.attempts ?? 6;
  const base = opts.baseMs ?? 25;
  const max = opts.maxMs ?? 1000;
  const sleep = opts.sleep ?? sleepSync;
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try {
      return fn();
    } catch (err: any) {
      lastErr = err;
      const transient = TRANSIENT_FS_CODES.has(err?.code) || err?.code === 'SQLITE_BUSY' || err?.code === 'SQLITE_CANTOPEN';
      if (!transient || i === attempts - 1) throw err;
      opts.onRetry?.(err, i + 1);
      sleep(Math.min(max, base * 2 ** i));
    }
  }
  throw lastErr;
}

export function mapSqliteError(err: any): DbError {
  if (err instanceof DbError) return err;
  const code: string = err?.code || '';
  const msg: string = err?.message || String(err);
  if (code.startsWith('SQLITE_FULL') || /database or disk is full/i.test(msg)) {
    return new DbError('disk-full', 'The disk is full or the database reached its size limit. Free up space and retry.', err);
  }
  if (code.startsWith('SQLITE_READONLY') || code === 'SQLITE_CANTOPEN' || code === 'EROFS' || /readonly database/i.test(msg)) {
    return new DbError('read-only', 'The profile directory or database file is read-only. Check folder permissions.', err);
  }
  if (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED')) {
    return new DbError('locked', 'The database is locked by another process.', err);
  }
  if (code.startsWith('SQLITE_CORRUPT') || code === 'SQLITE_NOTADB' || /malformed|not a database/i.test(msg)) {
    return new DbError('corrupt', 'The database file is corrupt.', err);
  }
  if (code.startsWith('SQLITE_CONSTRAINT')) {
    return new DbError('constraint', msg, err);
  }
  if (/NODE_MODULE_VERSION|was compiled against a different Node\.js version|Could not locate the bindings file|better_sqlite3\.node/i.test(msg)) {
    return new DbError('native-binding', `better-sqlite3 native binding does not match this runtime (run "npm run rebuild"): ${msg}`, err);
  }
  return new DbError('unknown', msg, err);
}

/**
 * Electron needs the ABI-130 build of better-sqlite3 while node_modules holds the Node build used by tests/CI.
 * `npm run rebuild` stores the Electron build in `<repo>/.native/`; use it when present. Packaged apps ship the
 * Electron build in node_modules (electron-builder rebuilds + asarUnpack), so no override is needed there.
 */
export function resolveNativeBinding(): string | undefined {
  if (process.env.AEGIS_SQLITE_BINDING) return process.env.AEGIS_SQLITE_BINDING;
  if (!process.versions.electron) return undefined;
  const dir = `electron-abi${process.versions.modules}-${process.platform}-${process.arch}`;
  const candidate = path.resolve(__dirname, '..', '..', '.native', dir, 'better_sqlite3.node');
  return fs.existsSync(candidate) ? candidate : undefined;
}

export function loadMigrations(dir: string = defaultMigrationsDir()): MigrationFile[] {
  if (!fs.existsSync(dir)) {
    throw new DbError('migration-failed', `Migrations directory not found: ${dir}`);
  }
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  const out: MigrationFile[] = [];
  for (const f of files) {
    const m = MIGRATION_RE.exec(f);
    if (!m) throw new DbError('migration-failed', `Invalid migration file name: ${f} (expected NNNN_name.sql)`);
    const version = Number(m[1]);
    const expected = out.length + 1;
    if (version !== expected) {
      throw new DbError('migration-failed', `Migration versions must be contiguous: expected ${String(expected).padStart(4, '0')}, found ${f}`);
    }
    // Normalise CRLF so the checksum is identical on Windows checkouts.
    const sql = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n');
    out.push({ version, name: m[2], file: f, sql, checksum: crypto.createHash('sha256').update(sql).digest('hex') });
  }
  return out;
}

function sidecars(file: string): string[] {
  return [`${file}-wal`, `${file}-shm`];
}

function removeIfExists(p: string): void {
  retryTransient(() => fs.rmSync(p, { force: true }));
}

export class AegisDb {
  private closed = false;

  private constructor(
    public readonly file: string,
    public readonly handle: SqliteHandle,
    public readonly schemaVersion: number,
    private readonly opts: OpenOptions
  ) {}

  /** Opens (creating if needed), configures and migrates the database. Throws DbError. */
  static open(file: string, opts: OpenOptions = {}): AegisDb {
    const sleep = opts.sleep ?? sleepSync;
    const inMemory = file === ':memory:';
    if (!inMemory) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
      } catch (err) {
        throw mapSqliteError(err);
      }
    }
    const binding = opts.nativeBinding ?? resolveNativeBinding();

    let handle: SqliteHandle | null = null;
    try {
      handle = retryTransient(
        () => new Database(file, { readonly: opts.readonly === true, nativeBinding: binding }),
        { sleep }
      );
      if (!opts.readonly) {
        handle.pragma('journal_mode = WAL');
        handle.pragma('synchronous = NORMAL');
      }
      handle.pragma('foreign_keys = ON');
      handle.pragma(`busy_timeout = ${opts.busyTimeoutMs ?? 5000}`);

      // Detect real corruption up-front (a 0-byte file is a valid empty database to SQLite).
      const check = handle.pragma('quick_check', { simple: true });
      if (check !== 'ok') {
        throw new DbError('corrupt', `Database integrity check failed: ${String(check)}`);
      }
    } catch (err) {
      try { handle?.close(); } catch { /* ignore */ }
      throw mapSqliteError(err);
    }

    let version: number;
    try {
      version = opts.readonly ? AegisDb.readVersion(handle) : AegisDb.migrate(file, handle, opts);
    } catch (err) {
      try { handle.close(); } catch { /* ignore */ }
      throw err instanceof DbError ? err : mapSqliteError(err);
    }
    return new AegisDb(file, handle, version, opts);
  }

  private static readVersion(handle: SqliteHandle): number {
    const has = handle.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
    if (!has) return 0;
    const row = handle.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as { v: number };
    return row.v;
  }

  private static migrate(file: string, handle: SqliteHandle, opts: OpenOptions): number {
    handle.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )`);

    const all = loadMigrations(opts.migrationsDir);
    const target = Math.min(opts.maxVersion ?? all.length, all.length);
    const applied = handle.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all() as Array<{ version: number; name: string; checksum: string }>;
    const current = applied.length ? applied[applied.length - 1].version : 0;

    if (current > all.length) {
      throw new DbError('newer-schema', `This database was created by a newer version of the app (schema ${current}, this build knows ${all.length}). Update the app; the file was not modified.`);
    }
    for (const a of applied) {
      const known = all[a.version - 1];
      if (!known || known.name !== a.name || known.checksum !== a.checksum) {
        throw new DbError('migration-failed', `Applied migration ${a.version}_${a.name} does not match the migration file shipped with this build (edited after release?).`);
      }
    }
    if (current >= target) return current;

    const inMemory = file === ':memory:';
    let backupPath: string | null = null;
    if (!inMemory && current > 0) {
      backupPath = `${file}.bak-${current}`;
      AegisDb.backupInto(handle, backupPath);
    }

    let lastApplied = current;
    try {
      for (const m of all.slice(current, target)) {
        const apply = handle.transaction(() => {
          handle.exec(m.sql);
          handle.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')
            .run(m.version, m.name, m.checksum, Date.now());
        });
        apply();
        lastApplied = m.version;
      }
    } catch (err: any) {
      // Roll the whole run back to the pre-migration snapshot so we never leave a half-migrated file behind.
      try { handle.close(); } catch { /* ignore */ }
      let restored = false;
      if (backupPath && fs.existsSync(backupPath)) {
        try {
          AegisDb.restoreFile(backupPath, file);
          restored = true;
        } catch { /* reported below */ }
      }
      throw new DbError(
        'migration-failed',
        `Migration ${String(lastApplied + 1).padStart(4, '0')} failed: ${err?.message ?? err}. ` +
          (restored ? `The database was restored from ${path.basename(backupPath!)}.` : 'No earlier data needed restoring.'),
        err
      );
    }
    return lastApplied;
  }

  /** Consistent snapshot of a (possibly WAL-mode) database. Never use fs.copyFile for this. */
  private static backupInto(handle: SqliteHandle, dest: string): void {
    removeIfExists(dest);
    handle.prepare('VACUUM INTO ?').run(dest);
  }

  private static restoreFile(backup: string, target: string): void {
    for (const s of sidecars(target)) removeIfExists(s);
    retryTransient(() => fs.copyFileSync(backup, target));
  }

  // ---- public API ---------------------------------------------------------------------------------------------

  /** Runs `fn`, converting driver errors into typed DbErrors. */
  guard<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      throw mapSqliteError(err);
    }
  }

  /** Runs `fn` inside an IMMEDIATE transaction (safe for concurrent writers across processes). */
  tx<T>(fn: () => T): T {
    return this.guard(() => this.handle.transaction(fn).immediate());
  }

  /** Consistent online backup written to `dest` (replaces an existing file). */
  backupTo(dest: string): void {
    this.guard(() => AegisDb.backupInto(this.handle, dest));
  }

  /** Writes `<db>.bak-last`, the snapshot offered for restore after corruption. */
  snapshotForRecovery(): string {
    const dest = `${this.file}.bak-last`;
    this.backupTo(dest);
    return dest;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.handle.pragma('wal_checkpoint(TRUNCATE)');
    } catch { /* best effort */ }
    this.handle.close();
  }

  get isOpen(): boolean {
    return !this.closed && this.handle.open;
  }
}

// ---- recovery helpers ---------------------------------------------------------------------------------------

export interface BackupInfo {
  path: string;
  label: string;
  mtimeMs: number;
  bytes: number;
}

export function listBackups(file: string): BackupInfo[] {
  const dir = path.dirname(file);
  const base = path.basename(file);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.startsWith(`${base}.bak-`))
    .map(f => {
      const p = path.join(dir, f);
      const st = fs.statSync(p);
      return { path: p, label: f.slice(base.length + 5), mtimeMs: st.mtimeMs, bytes: st.size };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Moves a damaged database (and its WAL/SHM) aside so it is kept for forensics but no longer opened. */
export function quarantineDatabase(file: string): string {
  const dest = `${file}.corrupt-${Date.now()}`;
  retryTransient(() => fs.renameSync(file, dest));
  for (const s of sidecars(file)) removeIfExists(s);
  return dest;
}

export type RecoveryChoice = { action: 'restore'; backup: BackupInfo } | { action: 'fresh' } | { action: 'quit' };

export interface RecoveryResult {
  db: AegisDb | null;
  recovered: 'none' | 'restored' | 'fresh' | 'quit';
  error?: DbError;
  quarantinedTo?: string;
}

/**
 * Opens the database; if it is corrupt, asks `choose` (the app shows a dialog) whether to restore the newest
 * valid backup, start fresh, or quit. The damaged file is always quarantined, never deleted.
 */
export function openWithRecovery(
  file: string,
  choose: (err: DbError, backups: BackupInfo[]) => RecoveryChoice,
  opts: OpenOptions = {}
): RecoveryResult {
  try {
    return { db: AegisDb.open(file, opts), recovered: 'none' };
  } catch (err) {
    const e = err instanceof DbError ? err : mapSqliteError(err);
    if (e.code !== 'corrupt') throw e;

    const backups = listBackups(file);
    const choice = choose(e, backups);
    if (choice.action === 'quit') return { db: null, recovered: 'quit', error: e };

    const quarantinedTo = quarantineDatabase(file);
    if (choice.action === 'restore') {
      // Prove the backup is healthy before trusting it.
      fs.copyFileSync(choice.backup.path, file);
      try {
        return { db: AegisDb.open(file, opts), recovered: 'restored', error: e, quarantinedTo };
      } catch (restoreErr) {
        removeIfExists(file);
        throw new DbError('corrupt', `Backup ${path.basename(choice.backup.path)} could not be opened: ${(restoreErr as Error).message}`, restoreErr);
      }
    }
    return { db: AegisDb.open(file, opts), recovered: 'fresh', error: e, quarantinedTo };
  }
}

// ---- process-wide singleton ---------------------------------------------------------------------------------

let current: AegisDb | null = null;

export function setDb(db: AegisDb | null): void {
  current = db;
}

export function getDb(): AegisDb {
  if (!current || !current.isOpen) {
    throw new DbError('unknown', 'Database has not been initialised (call initialisePersistence first).');
  }
  return current;
}

export function hasDb(): boolean {
  return current !== null && current.isOpen;
}
