/**
 * Issue #239 PST-01: product wiring on top of the SQLite core. Real files, real DB, no mocks:
 * settings across restart (and API keys never reaching the database), legacy JSON import (+ .migrated markers,
 * originals kept), MissionRecorder, blackboard persistence per mission, MemoryStore on the shared DB, and
 * export/import (secrets excluded, checksum, zip-slip and newer-schema protection).
 */
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { unzipSync, zipSync } from 'fflate';
import { AegisDb, DbError, loadMigrations, setDb } from '../src/infrastructure/db.js';
import { createRepos } from '../src/infrastructure/repos/index.js';
import { SettingsManager, DEFAULT_SETTINGS } from '../src/infrastructure/settings.js';
import { importLegacyCheckpoints, importLegacySettings } from '../src/infrastructure/legacy_import.js';
import { MissionRecorder } from '../src/infrastructure/mission_recorder.js';
import { SharedBlackboard } from '../src/swarm/blackboard.js';
import { MemoryStore } from '../src/memory/memory_store.js';
import { exportData, importData, verifyExport } from '../src/infrastructure/data_transfer.js';
import { credentialVault } from '../src/infrastructure/credentials.js';

const tmp = (n: string): string => fs.mkdtempSync(path.join(os.tmpdir(), `aegis-${n}-`));

function dbBytes(file: string): string {
  // Every byte the database may have written, including the WAL.
  return [file, `${file}-wal`].filter(f => fs.existsSync(f)).map(f => fs.readFileSync(f).toString('latin1')).join('');
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (e: any) {
    assert.ok(e instanceof DbError && e.code === code, `expected ${code}, got ${e?.code}: ${e?.message}`);
    return;
  }
  assert.fail(`expected DbError ${code}`);
}

async function testSettingsAcrossRestartAndSecrets(): Promise<void> {
  const dir = tmp('settings');
  const file = path.join(dir, 'aegis.sqlite');
  const SECRET = 'AIzaSyTOPSECRET-do-not-persist-0123456789';

  let db = AegisDb.open(file);
  const mgr = SettingsManager.getInstance();
  mgr.attachRepo(createRepos(db).settings);
  mgr.updateSettings({ modelProvider: 'ollama', ollamaBaseUrl: 'http://127.0.0.1:1', demoMode: true, apiKeys: { gemini: SECRET } } as any); // demoMode was removed in #224: a caller or stale row must not revive it
  assert.strictEqual(mgr.getSettings().apiKeys.gemini, SECRET, 'keys are available to the runtime synchronously');
  db.close();
  mgr.detachRepo();

  // "Restart": fresh connection, fresh manager state.
  db = AegisDb.open(file);
  const loaded = mgr.attachRepo(createRepos(db).settings);
  assert.strictEqual(loaded.modelProvider, 'ollama');
  assert.strictEqual(loaded.ollamaBaseUrl, 'http://127.0.0.1:1');
  assert.ok(!('demoMode' in loaded), 'removed demoMode setting is not loaded back');
  assert.strictEqual(loaded.maxConcurrency, DEFAULT_SETTINGS.maxConcurrency, 'untouched fields keep defaults');
  const stored = createRepos(db).settings.all();
  assert.ok(!('apiKeys' in stored), 'apiKeys is never a database row');
  assert.ok(!('demoMode' in stored), 'removed demoMode setting is never persisted');
  db.close();
  assert.ok(!dbBytes(file).includes(SECRET), 'API key does not appear anywhere in the database or WAL');
  mgr.detachRepo();
  await credentialVault.deleteKey('gemini');
  console.log('PASS settings persist across restart; API key never written to SQLite');
}

function testLegacyImport(): void {
  const userData = tmp('legacy');
  const db = AegisDb.open(path.join(userData, 'aegis.sqlite'));
  const repos = createRepos(db);
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ version: 1, modelProvider: 'anthropic', modelName: 'claude-x', apiKeys: { anthropic: 'sk-ant-legacy', openai: '' }, maxConcurrency: 7 }));
  fs.mkdirSync(path.join(userData, 'missions'));
  fs.writeFileSync(path.join(userData, 'missions', 'm_old1.json'), JSON.stringify({ id: 'm_old1', prompt: 'old done', model: 'gpt', state: 'completed', stepCount: 4, result: 'ok', evidenceCount: 2, updatedAt: 1700000000000 }));
  fs.writeFileSync(path.join(userData, 'missions', 'm_old2.json'), JSON.stringify({ id: 'm_old2', prompt: 'was running', model: 'gpt', state: 'running', stepCount: 1, updatedAt: 1700000001000 }));
  fs.writeFileSync(path.join(userData, 'missions', 'broken.json'), '{ not json');

  const stored: Record<string, string> = {};
  const s = importLegacySettings(userData, repos.settings, (p, k) => { stored[p] = k; });
  assert.ok(s.settingsImported);
  assert.deepStrictEqual(stored, { anthropic: 'sk-ant-legacy' }, 'only non-empty keys go to the key store');
  assert.strictEqual(repos.settings.get('modelProvider'), 'anthropic');
  assert.strictEqual(repos.settings.get('maxConcurrency'), 7);
  assert.strictEqual(repos.settings.get('apiKeys'), undefined);
  assert.ok(fs.existsSync(path.join(userData, 'settings.json')), 'original settings.json is never deleted');
  assert.ok(fs.existsSync(path.join(userData, 'settings.json.migrated')));

  const c = importLegacyCheckpoints(userData, repos.missions);
  assert.strictEqual(c.checkpointsImported, 2);
  assert.strictEqual(c.checkpointsSkipped, 1);
  assert.ok(c.errors.some(e => e.includes('broken.json')));
  assert.strictEqual(repos.missions.getMission('m_old1')!.result, 'ok');
  assert.strictEqual(repos.missions.getMission('m_old1')!.importedFrom, 'm_old1.json');
  assert.strictEqual(repos.missions.getMission('m_old2')!.state, 'failed', 'a checkpoint that said "running" cannot still be running');
  assert.ok(fs.existsSync(path.join(userData, 'missions', 'm_old1.json')), 'checkpoint originals are kept');
  assert.ok(fs.existsSync(path.join(userData, 'missions', '.migrated')));

  // Second run is a no-op even if the DB value changed meanwhile.
  repos.settings.set('modelProvider', 'gemini');
  const again = importLegacySettings(userData, repos.settings, () => assert.fail('must not re-import'));
  assert.strictEqual(again.settingsImported, false);
  assert.strictEqual(repos.settings.get('modelProvider'), 'gemini');
  assert.strictEqual(importLegacyCheckpoints(userData, repos.missions).checkpointsImported, 0);

  // A corrupt settings.json is reported, left in place and retried (no marker).
  const bad = tmp('legacy-bad');
  fs.writeFileSync(path.join(bad, 'settings.json'), 'garbage{');
  const r = importLegacySettings(bad, repos.settings, () => {});
  assert.strictEqual(r.settingsImported, false);
  assert.ok(r.errors.length === 1 && !fs.existsSync(path.join(bad, 'settings.json.migrated')));
  db.close();
  console.log('PASS legacy settings.json + mission checkpoints imported once; .migrated markers; originals kept; corrupt input reported');
}

function testMissionRecorderAcrossRestart(): void {
  const dir = tmp('recorder');
  const file = path.join(dir, 'aegis.sqlite');
  assert.strictEqual(MissionRecorder.event('m_nodb', 'x', {}), null, 'no-op without a database');

  let db = AegisDb.open(file);
  setDb(db);
  const mission = { id: 'm_rec', prompt: 'compare prices', model: 'gpt', state: 'planning' as const, stepCount: 0, evidenceCollected: [] as string[] };
  MissionRecorder.checkpoint(mission); // row first (FK), as the runtime does
  const s1 = MissionRecorder.event('m_rec', 'status', { status: 'planning', message: 'Planning goal' });
  const s2 = MissionRecorder.event('m_rec', 'evidence', { text: '[Mission m_rec] Initialized', timestamp: '12:00:00' });
  mission.state = 'completed';
  mission.stepCount = 3;
  (mission as any).result = 'done';
  MissionRecorder.checkpoint(mission);
  assert.deepStrictEqual([s1, s2], [1, 2]);
  // Event for a mission that has no row yet must not throw into the agent loop.
  assert.strictEqual(MissionRecorder.event('m_missing_row', 'status', {}), null);
  assert.ok(MissionRecorder.lastError && /FOREIGN KEY/.test(MissionRecorder.lastError));

  // A mission still "running" when the process dies.
  MissionRecorder.checkpoint({ id: 'm_dead', prompt: 'long task', model: 'gpt', state: 'running', stepCount: 2, evidenceCollected: [] });
  MissionRecorder.event('m_dead', 'status', { status: 'running' });
  db.close();
  setDb(null);

  db = AegisDb.open(file);
  setDb(db);
  assert.strictEqual(MissionRecorder.recoverInterrupted(), 1);
  const repos = createRepos(db);
  const ev = repos.missions.listEvents('m_rec').events;
  assert.deepStrictEqual(ev.map(e => [e.seq, e.kind]), [[1, 'status'], [2, 'evidence']]);
  assert.deepStrictEqual((ev[1].data as any).text, '[Mission m_rec] Initialized');
  assert.strictEqual(repos.missions.getMission('m_rec')!.result, 'done');
  const dead = repos.missions.getMission('m_dead')!;
  assert.strictEqual(dead.state, 'failed');
  assert.match(dead.error!, /Interrupted/);
  assert.deepStrictEqual(repos.missions.listEvents('m_dead').events.map(e => e.kind), ['status', 'mission.interrupted']);
  db.close();
  setDb(null);
  console.log('PASS mission + events survive a restart; interrupted missions are closed out honestly');
}

function testBlackboardPersistsPerMission(): void {
  const dir = tmp('bb');
  const file = path.join(dir, 'aegis.sqlite');
  let db = AegisDb.open(file);
  setDb(db);
  createRepos(db).missions.upsertMission({ id: 'm_a', prompt: 'p', model: 'm', state: 'running', stepCount: 0 });
  createRepos(db).missions.upsertMission({ id: 'm_b', prompt: 'p', model: 'm', state: 'running', stepCount: 0 });

  const bb = new SharedBlackboard({ missionId: 'm_a' });
  const r1 = bb.postEvidence({ entity: 'Widget', attribute: 'price', value: '$19.99', workerId: 'w1', source: { url: 'https://shop.test/w', quote: 'Only $19.99' } });
  assert.ok(r1.posted);
  assert.strictEqual(createRepos(db).evidence.countByMission('m_a'), 1);
  db.close();
  setDb(null);

  db = AegisDb.open(file);
  setDb(db);
  const resumed = new SharedBlackboard({ missionId: 'm_a' });
  assert.strictEqual(resumed.getAllEvidence().length, 1, 'same mission reloads its evidence');
  assert.strictEqual(resumed.getAllEvidence()[0].source.quote, 'Only $19.99');
  assert.strictEqual(resumed.postEvidence({ entity: 'Widget', attribute: 'price', value: '$19.99', workerId: 'w2' }).posted, false, 'dedupe state restored');
  const other = new SharedBlackboard({ missionId: 'm_b' });
  assert.strictEqual(other.getAllEvidence().length, 0, 'another mission starts clean');
  assert.ok(other.postEvidence({ entity: 'Widget', attribute: 'price', value: '$19.99', workerId: 'w3' }).posted);
  const memoryOnly = new SharedBlackboard({ inMemory: true });
  memoryOnly.postEvidence({ entity: 'x', attribute: 'y', value: 1, workerId: 'w' });
  assert.strictEqual(createRepos(db).evidence.listAll().length, 2, 'inMemory blackboards never touch the database');
  db.close();
  setDb(null);
  console.log('PASS blackboard evidence persisted per mission and restored after restart');
}

function testMemoryStoreOnSharedDatabase(): void {
  const dir = tmp('memory');
  const file = path.join(dir, 'aegis.sqlite');
  const a = new MemoryStore(file);
  a.recordPage({ url: 'https://docs.test/x', domain: 'docs.test', title: 'Electron native modules', snippet: 'rebuild', fullText: 'better-sqlite3 needs an electron specific ABI build' });
  a.close();
  const b = new MemoryStore(file);
  const hit = b.searchFTS('electron ABI', 5);
  assert.strictEqual(hit.length, 1);
  assert.strictEqual(hit[0].page.url, 'https://docs.test/x');
  b.close();

  // Shared handle: closing the store must not close the app database.
  const db = AegisDb.open(path.join(dir, 'shared.sqlite'));
  const store = new MemoryStore(db);
  store.recordPage({ url: 'https://s.test', domain: 's.test', title: 'S', snippet: 's', fullText: 'shared handle' });
  store.close();
  assert.ok(db.isOpen);
  assert.strictEqual(createRepos(db).pages.getByUrl('https://s.test')!.title, 'S');
  db.close();
  console.log('PASS MemoryStore persists on better-sqlite3 (FTS5) and respects a shared database handle');
}

function populateForExport(userData: string): { db: AegisDb; secret: string } {
  const secret = 'sk-live-SUPER-SECRET-12345';
  const db = AegisDb.open(path.join(userData, 'aegis.sqlite'));
  const r = createRepos(db);
  r.settings.set('modelProvider', 'ollama');
  r.settings.set('apiKeys', { openai: secret }); // must be scrubbed even if something wrote it
  r.missions.upsertMission({ id: 'm_exp', prompt: 'export me', model: 'm', state: 'completed', stepCount: 2 });
  for (let i = 0; i < 25; i++) r.missions.appendEvent('m_exp', 'evidence', { text: `fact ${i}` });
  fs.mkdirSync(path.join(userData, 'deliverables'), { recursive: true });
  fs.writeFileSync(path.join(userData, 'deliverables', 'm_exp_report.md'), '# Report\nfindings');
  fs.mkdirSync(path.join(userData, 'missions'), { recursive: true });
  fs.writeFileSync(path.join(userData, 'missions', 'm_old.json'), '{"id":"m_old"}');
  fs.writeFileSync(path.join(userData, 'vault.enc'), `vault with ${secret}`);
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ apiKeys: { openai: secret } }));
  return { db, secret };
}

function testExportImport(): void {
  const userData = tmp('export-src');
  const { db, secret } = populateForExport(userData);
  const zip = path.join(tmp('export-out'), 'backup.zip');
  const manifest = exportData(db, userData, zip);
  assert.strictEqual(manifest.schemaVersion, loadMigrations().length);
  const names = manifest.files.map(f => f.path).sort();
  assert.deepStrictEqual(names, ['aegis.sqlite', 'deliverables/m_exp_report.md', 'missions/m_old.json']);

  // Secrets: not in any entry, not in the raw archive, vault/settings.json not included.
  const entries = unzipSync(new Uint8Array(fs.readFileSync(zip)));
  for (const [n, data] of Object.entries(entries)) {
    assert.ok(!Buffer.from(data).includes(secret), `secret leaked into ${n}`);
  }
  assert.ok(!entries['vault.enc'] && !entries['settings.json']);
  assert.ok(!fs.readFileSync(zip).includes(secret));
  const verified = verifyExport(zip);
  assert.strictEqual(verified.manifest.files.length, 3);

  // Import into a different, empty profile and check content.
  const target = tmp('export-dst');
  const dstDb = AegisDb.open(path.join(target, 'aegis.sqlite'));
  createRepos(dstDb).settings.set('modelProvider', 'gemini'); // will be replaced
  let closed = false;
  const res = importData({ zipPath: zip, userData: target, dbFile: path.join(target, 'aegis.sqlite'), closeLiveDb: () => { dstDb.close(); closed = true; } });
  assert.ok(closed);
  assert.ok(fs.existsSync(res.previousDbBackup), 'previous database kept as .bak-pre-import');
  const after = AegisDb.open(path.join(target, 'aegis.sqlite'));
  const repos = createRepos(after);
  assert.strictEqual(repos.settings.get('modelProvider'), 'ollama');
  assert.strictEqual(repos.settings.get('apiKeys'), undefined, 'scrubbed from the exported snapshot');
  assert.strictEqual(repos.missions.countEvents('m_exp'), 25);
  assert.strictEqual(fs.readFileSync(path.join(target, 'deliverables', 'm_exp_report.md'), 'utf8'), '# Report\nfindings');
  after.close();
  db.close();

  // The previous profile's data is still reachable through the backup file.
  const prev = AegisDb.open(res.previousDbBackup);
  assert.strictEqual(createRepos(prev).settings.get('modelProvider'), 'gemini');
  prev.close();
  console.log('PASS export (secrets excluded, manifest + checksums) and import into a fresh profile; old DB kept');
}

function testImportRejectsBadArchives(): void {
  const userData = tmp('bad-src');
  const { db } = populateForExport(userData);
  const good = path.join(tmp('bad-out'), 'good.zip');
  exportData(db, userData, good);
  const dst = tmp('bad-dst');
  const dstFile = path.join(dst, 'aegis.sqlite');
  const live = AegisDb.open(dstFile);
  createRepos(live).settings.set('keep', 'me');
  live.close();
  const attempt = (zipPath: string): void => {
    importData({ zipPath, userData: dst, dbFile: dstFile, closeLiveDb: () => assert.fail('live DB must not be closed for a rejected archive') });
  };

  // Tampered content -> checksum mismatch.
  const entries = unzipSync(new Uint8Array(fs.readFileSync(good)));
  const tampered = { ...entries, 'deliverables/m_exp_report.md': new TextEncoder().encode('# EVIL') };
  const tamperedZip = path.join(dst, 'tampered.zip');
  fs.writeFileSync(tamperedZip, zipSync(tampered));
  expectCode(() => attempt(tamperedZip), 'migration-failed');

  // Zip-slip entry.
  const slip = path.join(dst, 'slip.zip');
  fs.writeFileSync(slip, zipSync({ ...entries, '../evil.txt': new TextEncoder().encode('pwn') }));
  expectCode(() => attempt(slip), 'migration-failed');
  assert.ok(!fs.existsSync(path.join(path.dirname(dst), 'evil.txt')) && !fs.existsSync(path.join(dst, '..', 'evil.txt')));

  // Unexpected top-level path (e.g. trying to drop vault.enc).
  const vault = path.join(dst, 'vault.zip');
  fs.writeFileSync(vault, zipSync({ ...entries, 'vault.enc': new TextEncoder().encode('x') }));
  expectCode(() => attempt(vault), 'migration-failed');

  // Not a zip at all.
  const junk = path.join(dst, 'junk.zip');
  fs.writeFileSync(junk, 'this is not a zip');
  expectCode(() => attempt(junk), 'migration-failed');

  // Archive from a newer app version.
  const m = JSON.parse(new TextDecoder().decode(entries['manifest.json']));
  m.schemaVersion = 999;
  const newer = path.join(dst, 'newer.zip');
  fs.writeFileSync(newer, zipSync({ ...entries, 'manifest.json': new TextEncoder().encode(JSON.stringify(m)) }));
  expectCode(() => attempt(newer), 'newer-schema');

  // Snapshot that is not a database.
  const mm = JSON.parse(new TextDecoder().decode(entries['manifest.json']));
  const fakeDb = new TextEncoder().encode('not sqlite '.repeat(500));
  const entry = mm.files.find((f: any) => f.path === 'aegis.sqlite');
  entry.bytes = fakeDb.length;
  entry.sha256 = require('node:crypto').createHash('sha256').update(fakeDb).digest('hex');
  const fake = path.join(dst, 'fake.zip');
  fs.writeFileSync(fake, zipSync({ ...entries, 'aegis.sqlite': fakeDb, 'manifest.json': new TextEncoder().encode(JSON.stringify(mm)) }));
  expectCode(() => attempt(fake), 'corrupt');

  // Live data untouched by every rejected import.
  const still = AegisDb.open(dstFile);
  assert.strictEqual(createRepos(still).settings.get('keep'), 'me');
  still.close();
  db.close();
  console.log('PASS import rejects tampered / zip-slip / foreign-path / non-zip / newer-schema / non-database archives without touching live data');
}

async function main(): Promise<void> {
  await testSettingsAcrossRestartAndSecrets();
  testLegacyImport();
  testMissionRecorderAcrossRestart();
  testBlackboardPersistsPerMission();
  testMemoryStoreOnSharedDatabase();
  testExportImport();
  testImportRejectsBadArchives();
  console.log('\nALL PERSISTENCE WIRING (PST-01) TESTS PASSED');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
