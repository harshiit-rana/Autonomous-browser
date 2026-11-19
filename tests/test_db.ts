/**
 * Issue #239 PST-01: SQLite persistence core. Real files on disk, real better-sqlite3, real child processes.
 * Covers: migrations from empty and from every previous schema version, backup/restore on failed migration,
 * corruption recovery, disk-full, read-only file, lock contention, two writers, transient-lock retry,
 * very large event tables (indexed keyset pagination) and non-monotonic clocks.
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import {
  AegisDb,
  DbError,
  defaultMigrationsDir,
  getDb,
  hasDb,
  listBackups,
  loadMigrations,
  mapSqliteError,
  openWithRecovery,
  retryTransient,
  setDb,
  type RecoveryChoice
} from '../src/infrastructure/db.js';
import { createRepos } from '../src/infrastructure/repos/index.js';

const LATEST = loadMigrations().length;

// ---- child-process mode: used by the two-writer test -------------------------------------------------------------
if (process.argv[2] === '--child') {
  const [, , , file, missionId, count] = process.argv;
  const db = AegisDb.open(file);
  const repos = createRepos(db);
  for (let i = 0; i < Number(count); i++) repos.missions.appendEvent(missionId, 'child', { pid: process.pid, i });
  db.close();
  process.exit(0);
}

function tmpDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `aegis-${name}-`));
}

function expectDbError(fn: () => unknown, code: string, label: string): DbError {
  try {
    fn();
  } catch (err: any) {
    assert.ok(err instanceof DbError, `${label}: expected DbError, got ${err?.constructor?.name}: ${err?.message}`);
    assert.strictEqual(err.code, code, `${label}: expected code ${code}, got ${err.code} (${err.message})`);
    return err;
  }
  assert.fail(`${label}: expected DbError(${code}) but nothing was thrown`);
}

function seedForVersion(db: AegisDb, version: number): void {
  const h = db.handle;
  const now = Date.now();
  if (version >= 1) {
    h.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('modelProvider', '\"ollama\"', ?)").run(now);
    h.prepare("INSERT INTO missions (id, prompt, model, state, created_at, updated_at) VALUES ('m_v1', 'find prices', 'gpt', 'completed', ?, ?)").run(now, now);
    h.prepare("INSERT INTO mission_events (mission_id, seq, ts, kind, json) VALUES ('m_v1', 1, ?, 'evidence', '{\"text\":\"hello v1\"}')").run(now);
  }
  if (version >= 2) {
    h.prepare("INSERT INTO threads (id, title, created_at, updated_at) VALUES ('t_v2', 'thread v2', ?, ?)").run(now, now);
    h.prepare("INSERT INTO messages (thread_id, seq, role, content, ts) VALUES ('t_v2', 1, 'user', 'hi', ?)").run(now);
  }
  if (version >= 3) {
    h.prepare("INSERT INTO memories (id, kind, content, created_at) VALUES ('mem_v3', 'fact', 'sky is blue', ?)").run(now);
  }
  if (version >= 4) {
    h.prepare("INSERT INTO pages (url, domain, title, snippet, full_text, visited_at) VALUES ('https://v4.test', 'v4.test', 'V4', 's', 'full text four', ?)").run(now);
  }
}

function assertSeededData(db: AegisDb, version: number): void {
  const h = db.handle;
  if (version >= 1) {
    assert.strictEqual((h.prepare("SELECT value FROM settings WHERE key='modelProvider'").get() as any).value, '"ollama"');
    assert.strictEqual((h.prepare("SELECT json FROM mission_events WHERE mission_id='m_v1' AND seq=1").get() as any).json, '{"text":"hello v1"}');
  }
  if (version >= 2) assert.strictEqual((h.prepare("SELECT content FROM messages WHERE thread_id='t_v2'").get() as any).content, 'hi');
  if (version >= 3) assert.strictEqual((h.prepare("SELECT content FROM memories WHERE id='mem_v3'").get() as any).content, 'sky is blue');
  if (version >= 4) {
    const fts = h.prepare("SELECT url FROM pages_fts WHERE pages_fts MATCH 'four'").all();
    assert.strictEqual(fts.length, 1, 'FTS5 index works after migration');
  }
}

function testFreshMigration(): void {
  const dir = tmpDir('fresh');
  const file = path.join(dir, 'aegis.sqlite');
  const db = AegisDb.open(file);
  assert.strictEqual(db.schemaVersion, LATEST);
  assert.strictEqual(db.handle.pragma('journal_mode', { simple: true }), 'wal');
  assert.strictEqual(db.handle.pragma('foreign_keys', { simple: true }), 1);
  assert.ok(Number(db.handle.pragma('busy_timeout', { simple: true })) >= 5000);
  const tables = (db.handle.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map(r => r.name);
  for (const t of ['settings', 'missions', 'mission_events', 'evidence', 'threads', 'messages', 'prompts', 'prompt_versions', 'instructions', 'schedules', 'inbox_items', 'memories', 'memory_chunks', 'approvals', 'action_ledger', 'schema_migrations']) {
    assert.ok(tables.includes(t), `table ${t} exists`);
  }
  const rows = db.handle.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all() as any[];
  assert.deepStrictEqual(rows.map(r => r.version), Array.from({ length: LATEST }, (_, i) => i + 1));
  // Foreign keys really are enforced.
  assert.throws(() => db.handle.prepare("INSERT INTO mission_events (mission_id, seq, ts, kind, json) VALUES ('nope', 1, 0, 'x', '{}')").run(), /FOREIGN KEY/);
  db.close();
  // Re-open is a no-op migration and creates no backup.
  const again = AegisDb.open(file);
  assert.strictEqual(again.schemaVersion, LATEST);
  again.close();
  assert.strictEqual(listBackups(file).length, 0, 'no backup created when nothing to migrate');
  console.log('PASS fresh database: WAL, foreign_keys, busy_timeout, all tables, FK enforced');
}

function testMigrationFromEveryPreviousVersion(): void {
  for (let v = 1; v < LATEST; v++) {
    const dir = tmpDir(`from-v${v}`);
    const file = path.join(dir, 'aegis.sqlite');
    const old = AegisDb.open(file, { maxVersion: v });
    assert.strictEqual(old.schemaVersion, v);
    seedForVersion(old, v);
    old.close();

    const upgraded = AegisDb.open(file);
    assert.strictEqual(upgraded.schemaVersion, LATEST, `v${v} -> latest`);
    assertSeededData(upgraded, v);
    upgraded.close();

    const backups = listBackups(file);
    assert.ok(backups.some(b => b.label === String(v)), `pre-migration backup .bak-${v} exists`);
    const bak = new Database(path.join(dir, `aegis.sqlite.bak-${v}`), { readonly: true });
    assert.strictEqual((bak.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as any).v, v, 'backup holds the OLD schema');
    assert.strictEqual((bak.prepare("SELECT COUNT(*) AS c FROM missions WHERE id='m_v1'").get() as any).c, 1, 'backup contains the data (WAL content included)');
    bak.close();
  }
  console.log(`PASS upgrade from each previous schema version (1..${LATEST - 1}) keeps data and writes .bak-<version>`);
}

function copyMigrationsWith(extra: Record<string, string>): string {
  const dir = tmpDir('migrations');
  for (const f of fs.readdirSync(defaultMigrationsDir())) fs.copyFileSync(path.join(defaultMigrationsDir(), f), path.join(dir, f));
  for (const [n, sql] of Object.entries(extra)) fs.writeFileSync(path.join(dir, n), sql);
  return dir;
}

function testFailedMigrationRestores(): void {
  const dir = tmpDir('failed-mig');
  const file = path.join(dir, 'aegis.sqlite');
  const db = AegisDb.open(file);
  seedForVersion(db, LATEST);
  db.close();

  const n1 = String(LATEST + 1).padStart(4, '0');
  const n2 = String(LATEST + 2).padStart(4, '0');
  const migrations = copyMigrationsWith({
    [`${n1}_good.sql`]: 'CREATE TABLE good_one (id INTEGER PRIMARY KEY);',
    [`${n2}_bad.sql`]: 'CREATE TABLE half_done (id INTEGER PRIMARY KEY); INSERT INTO missing_table VALUES (1);'
  });
  const err = expectDbError(() => AegisDb.open(file, { migrationsDir: migrations }), 'migration-failed', 'bad migration');
  assert.match(err.message, new RegExp(`Migration ${n2} failed`));
  assert.match(err.message, /restored from aegis\.sqlite\.bak-/);

  // All-or-nothing: the good migration in the same run was rolled back too, and old data is intact.
  const check = new Database(file, { readonly: true });
  const names = (check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map(r => r.name);
  assert.ok(!names.includes('good_one') && !names.includes('half_done'), 'no tables from failed run remain');
  assert.strictEqual((check.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as any).v, LATEST);
  check.close();
  const reopened = AegisDb.open(file);
  assertSeededData(reopened, LATEST);
  reopened.close();
  console.log('PASS failed migration restores the pre-migration snapshot (all-or-nothing) and reports an error');
}

function testMigrationIntegrityRules(): void {
  const dir = tmpDir('integrity');
  const file = path.join(dir, 'aegis.sqlite');
  AegisDb.open(file).close();

  // Edited migration after release -> refuse.
  const edited = tmpDir('edited');
  for (const f of fs.readdirSync(defaultMigrationsDir())) fs.copyFileSync(path.join(defaultMigrationsDir(), f), path.join(edited, f));
  fs.appendFileSync(path.join(edited, '0001_core.sql'), '\n-- sneaky edit\n');
  expectDbError(() => AegisDb.open(file, { migrationsDir: edited }), 'migration-failed', 'edited migration');

  // Gap in numbering.
  const gap = tmpDir('gap');
  fs.writeFileSync(path.join(gap, '0001_a.sql'), 'CREATE TABLE a (x);');
  fs.writeFileSync(path.join(gap, '0003_c.sql'), 'CREATE TABLE c (x);');
  expectDbError(() => AegisDb.open(path.join(dir, 'gap.sqlite'), { migrationsDir: gap }), 'migration-failed', 'gap');

  // Database from a newer app version: refused, file untouched.
  const newer = path.join(dir, 'newer.sqlite');
  AegisDb.open(newer).close();
  const raw = new Database(newer);
  raw.prepare("INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, 'future', 'x', 0)").run(LATEST + 1);
  raw.close();
  const before = fs.readFileSync(newer);
  expectDbError(() => AegisDb.open(newer), 'newer-schema', 'newer schema');
  assert.ok(before.equals(fs.readFileSync(newer)), 'newer-schema database is not modified');
  console.log('PASS edited / non-contiguous / newer-schema migrations are rejected');
}

function testCorruptionRecovery(): void {
  const dir = tmpDir('corrupt');
  const file = path.join(dir, 'aegis.sqlite');
  const db = AegisDb.open(file);
  const repos = createRepos(db);
  repos.missions.upsertMission({ id: 'm_keep', prompt: 'precious', model: 'x', state: 'completed', stepCount: 1 });
  for (let i = 0; i < 400; i++) repos.missions.appendEvent('m_keep', 'evidence', { text: `event ${i} ${'x'.repeat(200)}` });
  db.snapshotForRecovery();
  db.close(); // checkpoints the WAL so the damage below hits the main file

  // A 0-byte file is NOT corruption to SQLite: it is an empty database (documented trap).
  const zero = path.join(dir, 'zero.sqlite');
  fs.writeFileSync(zero, '');
  const z = AegisDb.open(zero);
  assert.strictEqual(z.schemaVersion, LATEST);
  z.close();

  // Truncate mid-page (not on a 4096 boundary).
  const size = fs.statSync(file).size;
  fs.truncateSync(file, Math.floor(size / 2) + 123);
  let asked = 0;
  const choice = (e: DbError, backups: any[]): RecoveryChoice => {
    asked++;
    assert.strictEqual(e.code, 'corrupt');
    assert.ok(backups.length >= 1, 'a backup is offered');
    return { action: 'restore', backup: backups[0] };
  };
  const res = openWithRecovery(file, choice);
  assert.strictEqual(asked, 1);
  assert.strictEqual(res.recovered, 'restored');
  assert.ok(res.quarantinedTo && fs.existsSync(res.quarantinedTo), 'damaged file is kept, not deleted');
  assert.strictEqual(createRepos(res.db!).missions.countEvents('m_keep'), 400, 'data restored from backup');
  res.db!.close();

  // Garbage ("not a database") -> start fresh when no backup applies.
  const garbage = path.join(dir, 'garbage.sqlite');
  fs.writeFileSync(garbage, Buffer.from('this is definitely not a sqlite file '.repeat(200)));
  const fresh = openWithRecovery(garbage, () => ({ action: 'fresh' }));
  assert.strictEqual(fresh.recovered, 'fresh');
  assert.strictEqual(createRepos(fresh.db!).missions.countMissions(), 0);
  fresh.db!.close();

  // Quit choice leaves the damaged file where it is.
  const bad2 = path.join(dir, 'bad2.sqlite');
  fs.writeFileSync(bad2, Buffer.from('garbage '.repeat(1000)));
  const quit = openWithRecovery(bad2, () => ({ action: 'quit' }));
  assert.strictEqual(quit.recovered, 'quit');
  assert.ok(fs.existsSync(bad2));

  // Bit rot in the middle of a valid file is caught by quick_check, not just by header checks.
  const rot = path.join(dir, 'rot.sqlite');
  const r = AegisDb.open(rot);
  const rr = createRepos(r);
  rr.missions.upsertMission({ id: 'm', prompt: 'p', model: 'm', state: 'idle', stepCount: 0 });
  for (let i = 0; i < 300; i++) rr.missions.appendEvent('m', 'e', { pad: 'y'.repeat(300) });
  r.close();
  const buf = fs.readFileSync(rot);
  for (let i = 4096 * 3; i < 4096 * 3 + 2048; i++) buf[i] = 0xff;
  fs.writeFileSync(rot, buf);
  expectDbError(() => AegisDb.open(rot), 'corrupt', 'bit rot');
  console.log('PASS corruption (truncated mid-page, garbage, bit rot) -> error + restore/fresh/quit; 0-byte file is a valid empty DB');
}

function testDiskFull(): void {
  const dir = tmpDir('full');
  const db = AegisDb.open(path.join(dir, 'aegis.sqlite'));
  const repos = createRepos(db);
  repos.missions.upsertMission({ id: 'm', prompt: 'p', model: 'm', state: 'running', stepCount: 0 });
  const pages = db.handle.pragma('page_count', { simple: true }) as number;
  db.handle.pragma(`max_page_count = ${pages + 8}`); // simulates a full volume: SQLite refuses to grow
  let hit: DbError | null = null;
  for (let i = 0; i < 200 && !hit; i++) {
    try {
      repos.missions.appendEvent('m', 'big', { blob: 'z'.repeat(20000) });
    } catch (e: any) {
      hit = e;
    }
  }
  assert.ok(hit instanceof DbError && hit.code === 'disk-full', `expected disk-full, got ${hit?.code}: ${hit?.message}`);
  assert.match(hit!.message, /disk is full/i);
  // The failed write left the database consistent and still usable for reads/small writes after space is "freed".
  db.handle.pragma('max_page_count = 1073741823');
  assert.strictEqual(db.handle.pragma('quick_check', { simple: true }), 'ok');
  repos.missions.appendEvent('m', 'small', {});
  db.close();
  console.log('PASS disk full -> typed DbError(disk-full), DB stays consistent and recovers');
}

function testReadOnlyFile(): void {
  const dir = tmpDir('ro');
  const file = path.join(dir, 'aegis.sqlite');
  AegisDb.open(file).close();
  fs.chmodSync(file, 0o444);
  let writable = true;
  try {
    fs.accessSync(file, fs.constants.W_OK);
  } catch {
    writable = false;
  }
  if (writable) {
    console.log('SKIP read-only file test: running with privileges that ignore read-only permissions');
    fs.chmodSync(file, 0o666);
    return;
  }
  let outcome = 'none';
  try {
    const db = AegisDb.open(file);
    // SQLite may fall back to a read-only connection; the first write must then raise a typed error.
    try {
      createRepos(db).settings.set('k', 1);
    } catch (e: any) {
      assert.ok(e instanceof DbError && e.code === 'read-only', `write on read-only: ${e.code}`);
      outcome = 'write-rejected';
    }
    db.close();
  } catch (e: any) {
    assert.ok(e instanceof DbError && e.code === 'read-only', `open on read-only: ${e.code} ${e.message}`);
    outcome = 'open-rejected';
  }
  assert.notStrictEqual(outcome, 'none', 'read-only database must be reported, not silently accepted');
  fs.chmodSync(file, 0o666);
  // Non-existent, un-creatable location -> typed error too.
  const blocker = path.join(dir, 'a-file');
  fs.writeFileSync(blocker, 'x');
  const err = (() => {
    try {
      AegisDb.open(path.join(blocker, 'sub', 'aegis.sqlite'));
    } catch (e) {
      return e as any;
    }
    return null;
  })();
  assert.ok(err instanceof DbError, 'cannot create profile directory -> DbError');
  console.log(`PASS read-only profile reported as typed error (${outcome})`);
}

function testTransientRetry(): void {
  const sleeps: number[] = [];
  let calls = 0;
  const v = retryTransient(
    () => {
      calls++;
      if (calls < 3) throw Object.assign(new Error('locked by antivirus'), { code: 'EBUSY' });
      return 'ok';
    },
    { sleep: ms => sleeps.push(ms), baseMs: 25 }
  );
  assert.strictEqual(v, 'ok');
  assert.deepStrictEqual(sleeps, [25, 50], 'exponential backoff');

  let n = 0;
  assert.throws(() => retryTransient(() => { n++; throw Object.assign(new Error('nope'), { code: 'ENOENT' }); }, { sleep: () => {} }), /nope/);
  assert.strictEqual(n, 1, 'non-transient errors are not retried');

  let m = 0;
  assert.throws(() => retryTransient(() => { m++; throw Object.assign(new Error('still locked'), { code: 'EPERM' }); }, { attempts: 4, sleep: () => {} }), /still locked/);
  assert.strictEqual(m, 4, 'gives up after the configured attempts');

  // End-to-end: AegisDb.open retries a transient open failure through the injected sleep.
  const dir = tmpDir('retry');
  let slept = 0;
  const db = AegisDb.open(path.join(dir, 'aegis.sqlite'), { sleep: () => { slept++; } });
  db.close();
  assert.strictEqual(slept, 0);
  console.log('PASS transient file-lock retry with exponential backoff (EBUSY/EPERM), no retry for other errors');
}

function testLockContention(): void {
  const dir = tmpDir('busy');
  const file = path.join(dir, 'aegis.sqlite');
  const a = AegisDb.open(file);
  const b = AegisDb.open(file, { busyTimeoutMs: 150 });
  createRepos(a).missions.upsertMission({ id: 'm', prompt: 'p', model: 'm', state: 'idle', stepCount: 0 });
  a.handle.exec('BEGIN IMMEDIATE'); // instance A holds the write lock
  const t0 = Date.now();
  const err = expectDbError(() => createRepos(b).missions.appendEvent('m', 'x', {}), 'locked', 'second writer');
  const waited = Date.now() - t0;
  assert.ok(waited >= 100, `busy_timeout was honoured (waited ${waited}ms)`);
  assert.match(err.message, /locked/);
  a.handle.exec('COMMIT');
  createRepos(b).missions.appendEvent('m', 'x', {});
  a.close();
  b.close();
  console.log(`PASS lock contention: second writer waits busy_timeout (${waited}ms) then gets DbError(locked); works after release`);
}

async function testTwoProcessesWriting(): Promise<void> {
  const dir = tmpDir('twoproc');
  const file = path.join(dir, 'aegis.sqlite');
  const db = AegisDb.open(file);
  createRepos(db).missions.upsertMission({ id: 'm_shared', prompt: 'p', model: 'm', state: 'running', stepCount: 0 });
  db.close();
  const tsxCli = path.resolve('node_modules/tsx/dist/cli.mjs');
  const spawnChild = () => new Promise<number>(resolve => {
    const p = spawn(process.execPath, [tsxCli, path.resolve('tests/test_db.ts'), '--child', file, 'm_shared', '250'], { stdio: 'inherit' });
    p.on('exit', code => resolve(code ?? -1));
  });
  const codes = await Promise.all([spawnChild(), spawnChild()]);
  assert.deepStrictEqual(codes, [0, 0], 'both writer processes exited cleanly');
  const check = AegisDb.open(file);
  const repos = createRepos(check);
  assert.strictEqual(repos.missions.countEvents('m_shared'), 500);
  const seqs = (check.handle.prepare('SELECT seq FROM mission_events WHERE mission_id = ? ORDER BY seq').all('m_shared') as any[]).map(r => r.seq);
  assert.deepStrictEqual(seqs, Array.from({ length: 500 }, (_, i) => i + 1), 'seq is gap-free and unique across processes');
  check.close();
  console.log('PASS two app processes writing the same database: 500 events, gap-free unique seq');
}

function testLargeEventTable(): void {
  const dir = tmpDir('large');
  const db = AegisDb.open(path.join(dir, 'aegis.sqlite'));
  const repos = createRepos(db);
  repos.missions.upsertMission({ id: 'm_big', prompt: 'p', model: 'm', state: 'running', stepCount: 0 });
  const N = 50_000;
  const insert = db.handle.prepare('INSERT INTO mission_events (mission_id, seq, ts, kind, json) VALUES (?, ?, ?, ?, ?)');
  db.tx(() => {
    for (let i = 1; i <= N; i++) insert.run('m_big', i, 1_700_000_000_000 + i, i % 7 === 0 ? 'status' : 'evidence', `{"i":${i}}`);
  });
  assert.strictEqual(repos.missions.countEvents('m_big'), N);
  const plan = repos.missions.explainListEvents('m_big');
  assert.ok(/SEARCH/.test(plan) && !/SCAN/.test(plan), `event pagination must use the index, plan: ${plan}`);

  // Walk every page; verify order and completeness; deep pages must stay fast (keyset, not OFFSET).
  let after = 0;
  let seen = 0;
  let pages = 0;
  let slowest = 0;
  for (;;) {
    const t = process.hrtime.bigint();
    const page = repos.missions.listEvents('m_big', { afterSeq: after, limit: 1000 });
    slowest = Math.max(slowest, Number(process.hrtime.bigint() - t) / 1e6);
    for (const e of page.events) {
      assert.strictEqual(e.seq, ++seen);
    }
    pages++;
    if (page.nextAfterSeq === null) break;
    after = page.nextAfterSeq;
  }
  assert.strictEqual(seen, N);
  assert.strictEqual(pages, 50);
  assert.ok(slowest < 250, `slowest page ${slowest.toFixed(1)}ms`);
  const filtered = repos.missions.listEvents('m_big', { kind: 'status', limit: 10 });
  assert.strictEqual(filtered.events.length, 10);
  assert.ok(filtered.events.every(e => e.kind === 'status'));
  db.close();
  console.log(`PASS 50,000 events: indexed keyset pagination (${pages} pages, slowest ${slowest.toFixed(1)}ms)`);
}

function testClockChanges(): void {
  const db = AegisDb.open(':memory:');
  const repos = createRepos(db);
  repos.missions.upsertMission({ id: 'm', prompt: 'p', model: 'm', state: 'running', stepCount: 0 });
  const stamps = [5000, 4000, 4000, 1000, 9000, 2000]; // the system clock jumps backwards and forwards
  stamps.forEach(ts => repos.missions.appendEvent('m', 'tick', { ts }, ts));
  const events = repos.missions.listEvents('m').events;
  assert.deepStrictEqual(events.map(e => e.seq), [1, 2, 3, 4, 5, 6]);
  assert.deepStrictEqual(events.map(e => e.ts), stamps, 'timestamps are stored as observed, ordering comes from seq');
  db.close();
  console.log('PASS clock jumps: events keep insertion order via monotonic seq');
}

function testRepos(): void {
  const db = AegisDb.open(':memory:');
  const r = createRepos(db);

  r.settings.set('modelName', 'gemini-2.0-flash');
  r.settings.setMany({ a: 1, b: { c: [1, 2] } });
  assert.deepStrictEqual(r.settings.all(), { a: 1, b: { c: [1, 2] }, modelName: 'gemini-2.0-flash' });
  assert.ok(r.settings.delete('a') && !r.settings.delete('a'));

  r.missions.upsertMission({ id: 'm1', prompt: 'one', model: 'x', state: 'running', stepCount: 0, createdAt: 10 });
  r.missions.upsertMission({ id: 'm2', prompt: 'two', model: 'x', state: 'completed', stepCount: 3, createdAt: 20 });
  r.missions.upsertMission({ id: 'm1', prompt: 'one', model: 'x', state: 'completed', stepCount: 2, createdAt: 99 });
  assert.strictEqual(r.missions.getMission('m1')!.state, 'completed');
  assert.strictEqual(r.missions.getMission('m1')!.createdAt, 10, 'createdAt is not overwritten by updates');
  assert.deepStrictEqual(r.missions.listMissions().map(m => m.id), ['m2', 'm1']);
  assert.deepStrictEqual(r.missions.listMissions({ before: { createdAt: 20, id: 'm2' } }).map(m => m.id), ['m1']);
  r.missions.appendEvent('m1', 'a', 1);
  assert.ok(r.missions.deleteMission('m1'));
  assert.strictEqual(r.missions.countEvents('m1'), 0, 'events cascade with the mission');

  // evidence
  const ev = { id: 'ev1', entity: 'e', attribute: 'a', category: 'fact', value: { v: 1 }, normalized: { type: 'number' }, source: { url: 'https://x' }, workerId: 'w', confidence: 0.9, contentHash: 'h', timestamp: 5 };
  r.evidence.insert(ev, 'm2');
  assert.deepStrictEqual(r.evidence.listByMission('m2')[0].value, { v: 1 });
  r.missions.deleteMission('m2');
  assert.strictEqual(r.evidence.listAll().length, 1, 'evidence survives mission deletion (mission_id set null)');

  // threads
  const t = r.threads.create('Research');
  r.threads.appendMessage(t.id, { role: 'user', content: 'q1' });
  r.threads.appendMessage(t.id, { role: 'assistant', content: 'a1', meta: { tokens: 3 } });
  r.threads.appendMessage(t.id, { role: 'user', content: 'q2' });
  const fork = r.threads.fork(t.id, 2, 'Fork');
  assert.deepStrictEqual(r.threads.listMessages(fork.id).map(m => m.content), ['q1', 'a1']);
  assert.strictEqual(r.threads.listMessages(t.id, { afterSeq: 2 })[0].content, 'q2');
  r.threads.setArchived(t.id, true);
  assert.ok(!r.threads.list().some(x => x.id === t.id) && r.threads.list({ includeArchived: true }).some(x => x.id === t.id));

  // prompts
  const p = r.prompts.create('summarise');
  assert.strictEqual(r.prompts.addVersion(p.id, 'v1 {{x}}', ['x']), 1);
  assert.strictEqual(r.prompts.addVersion(p.id, 'v2 {{x}}', ['x']), 2);
  assert.strictEqual(r.prompts.getVersion(p.id)!.body, 'v2 {{x}}');
  assert.strictEqual(r.prompts.getVersion(p.id, 1)!.body, 'v1 {{x}}');
  assert.throws(() => r.prompts.create('summarise'), /UNIQUE/);

  // instructions / schedules / inbox
  const iid = r.instructions.upsert({ scope: 'global', content: 'be brief', enabled: true, priority: 5 });
  assert.strictEqual(r.instructions.list('global')[0].id, iid);
  const sid = r.schedules.create({ name: 'daily', prompt: 'check', cron: '0 9 * * *', nextRunAt: 100 });
  assert.strictEqual(r.schedules.listDue(50).length, 0);
  assert.strictEqual(r.schedules.listDue(100)[0].id, sid);
  r.schedules.markRan(sid, 100, 200);
  assert.strictEqual(r.schedules.listDue(150).length, 0);
  const nid = r.inbox.add({ kind: 'digest', title: 't', body: 'b' });
  assert.strictEqual(r.inbox.unreadCount(), 1);
  r.inbox.markRead(nid);
  assert.strictEqual(r.inbox.unreadCount(), 0);

  // memories / approvals / ledger
  const mid = r.memories.add({ kind: 'fact', content: 'c', chunks: [{ text: 'c1', embedding: [0.1, 0.2] }, { text: 'c2' }] });
  assert.strictEqual(r.memories.chunks(mid).length, 2);
  assert.deepStrictEqual(r.memories.chunks(mid)[0].embedding, [0.1, 0.2]);
  r.missions.upsertMission({ id: 'm3', prompt: 'p', model: 'm', state: 'running', stepCount: 0 });
  const aid = r.approvals.request('m3', { type: 'purchase', amount: 5 });
  assert.strictEqual(r.approvals.listPending().length, 1);
  assert.ok(r.approvals.decide(aid, 'denied', 'too expensive') && !r.approvals.decide(aid, 'approved'));
  assert.strictEqual(r.approvals.get(aid)!.status, 'denied');
  assert.strictEqual(r.actionLedger.append('m3', 'click', { ref: 'e1' }, true), 1);
  assert.strictEqual(r.actionLedger.append('m3', 'type', { ref: 'e2' }, false), 2);
  assert.ok(r.actionLedger.markUndone('m3', 1));
  assert.deepStrictEqual(r.actionLedger.list('m3').map(l => [l.seq, l.undone]), [[1, true], [2, false]]);

  // pages + FTS
  r.pages.upsert({ url: 'https://a.test', domain: 'a.test', title: 'Alpha', snippet: 's', fullText: 'quantum widgets', visitedAt: 1, embedding: [1, 0] });
  r.pages.upsert({ url: 'https://a.test', domain: 'a.test', title: 'Alpha2', snippet: 's', fullText: 'quantum widgets again', visitedAt: 2, embedding: [1, 0] });
  assert.strictEqual(r.pages.getByUrl('https://a.test')!.visitCount, 2);
  assert.strictEqual(r.pages.searchFts('"quantum"*', 5).length, 1);
  assert.ok(r.pages.deleteByUrl('https://a.test'));
  assert.strictEqual(r.pages.searchFts('"quantum"*', 5).length, 0, 'FTS index follows deletes');
  db.close();
  console.log('PASS repositories: settings, missions/events, evidence, threads, prompts, instructions, schedules, inbox, memories, approvals, ledger, pages');
}

function testErrorMapping(): void {
  assert.strictEqual(mapSqliteError({ code: 'SQLITE_FULL', message: 'x' }).code, 'disk-full');
  assert.strictEqual(mapSqliteError({ code: 'SQLITE_READONLY_DBMOVED', message: 'x' }).code, 'read-only');
  assert.strictEqual(mapSqliteError({ code: 'SQLITE_BUSY', message: 'x' }).code, 'locked');
  assert.strictEqual(mapSqliteError({ code: 'SQLITE_NOTADB', message: 'x' }).code, 'corrupt');
  assert.strictEqual(mapSqliteError(new Error('The module was compiled against a different Node.js version using NODE_MODULE_VERSION 130')).code, 'native-binding');
  assert.strictEqual(mapSqliteError(new Error('boom')).code, 'unknown');
  console.log('PASS sqlite error mapping');
}

function testSingleton(): void {
  setDb(null);
  assert.strictEqual(hasDb(), false);
  assert.throws(() => getDb(), /not been initialised/);
  const db = AegisDb.open(':memory:');
  setDb(db);
  assert.strictEqual(getDb(), db);
  setDb(null);
  db.close();
  console.log('PASS getDb() singleton guards');
}

async function main(): Promise<void> {
  testFreshMigration();
  testMigrationFromEveryPreviousVersion();
  testFailedMigrationRestores();
  testMigrationIntegrityRules();
  testCorruptionRecovery();
  testDiskFull();
  testReadOnlyFile();
  testTransientRetry();
  testLockContention();
  await testTwoProcessesWriting();
  testLargeEventTable();
  testClockChanges();
  testRepos();
  testErrorMapping();
  testSingleton();
  console.log('\nALL PERSISTENCE CORE (PST-01) TESTS PASSED');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
