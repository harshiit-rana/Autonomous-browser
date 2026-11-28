import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FlightRecorder, MissionFlightRecorder, FLIGHT_SCHEMA_VERSION } from '../src/automation/flight_recorder.js';

console.log('--- Testing Milestone M3: Flight Recorder & Replay (Issue #143) ---');

async function runTests() {
  const recorder = new FlightRecorder();
  const testDir = path.resolve('tests/output');
  if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });

  // 1. Recording session with sensitive data
  const log = recorder.startRecording('mission_test_101', 'Search for flights with card 4111-2222-3333-4444 and password=secret123');
  assert.strictEqual(log.id, 'mission_test_101');
  assert(!log.goal.includes('4111-2222-3333-4444'), 'Credit cards must be redacted');
  assert(!log.goal.includes('secret123'), 'Passwords must be redacted');
  assert(log.goal.includes('[REDACTED_CARD]'));
  assert(log.goal.includes('password=[REDACTED]'));
  console.log('✓ Sensitive data redaction in FlightRecorder verified');

  // 2. Record frames with potential XSS payloads
  recorder.recordFrame({
    url: 'https://example.com?q=<script>alert("xss")</script>',
    action: 'click(ref="e1") </script><script>window.pwned=true</script>',
    thinking: 'Planning move <b>bold</b> and </script>',
    mousePosition: { x: 100, y: 150 }
  });

  const stoppedLog = recorder.stopRecording();
  assert(stoppedLog !== null);
  assert.strictEqual(stoppedLog.frames.length, 1);
  assert.strictEqual(stoppedLog.frames[0].step, 1);
  console.log('✓ Frame recording and step incrementing verified');

  // 3. Export HTML and verify XSS hardening
  const htmlPath = path.join(testDir, 'flight_replay_test.html');
  FlightRecorder.exportReplayHTML(stoppedLog, htmlPath);
  assert(fs.existsSync(htmlPath), 'HTML replay artifact must be generated');

  const htmlContent = fs.readFileSync(htmlPath, 'utf-8');
  assert(!htmlContent.includes('<script>alert("xss")</script>'), 'Raw script tags must not be interpolated into HTML');
  assert(!htmlContent.includes('window.pwned=true</script>'), 'Unescaped closing script tags must not exist');
  assert(htmlContent.includes('\\u003c/script\\u003e'), 'Script tags in JSON must be escaped with unicode sequences');
  console.log('✓ XSS hardening in HTML replay export verified');

  // 4. Export JSON artifact
  const jsonPath = path.join(testDir, 'flight_replay_test.json');
  recorder.exportJSON(stoppedLog, jsonPath);
  assert(fs.existsSync(jsonPath));
  const parsedJson = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  assert.strictEqual(parsedJson.id, 'mission_test_101');
  assert.strictEqual(parsedJson.frames.length, 1);
  console.log('✓ Deterministic JSON replay artifact export verified');

  // 5. #236 MissionFlightRecorder: durable NDJSON, crash-truncated tolerance, frame eviction, v0->v1 migration, redacted export
  const mDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-flight-236-'));
  try {
    const rec = new MissionFlightRecorder(mDir, { recordFrames: true, maxMissionBytes: 2500 });
    rec.appendEvent({ seq: 1, ts: 1000, missionId: 'm_236', kind: 'step_started', data: { title: 'Login' } });
    rec.appendEvent({ seq: 2, ts: 1200, missionId: 'm_236', kind: 'tool_call', data: { tool: 'type', targetLabel: 'Password', text: 'Hunter2!', apiKey: 'sk-1234567890abcdef123456' } });
    const f1 = rec.recordJpegFrame(Buffer.alloc(1200, 0xaa), { seq: 1, ts: 1000 });
    const f2 = rec.recordJpegFrame(Buffer.alloc(1200, 0xbb), { seq: 2, ts: 1200 });
    const f3 = rec.recordJpegFrame(Buffer.alloc(1200, 0xcc), { seq: 3, ts: 1400 });
    assert(f1 && f2 && f3);

    // Append truncated NDJSON line simulating sudden process kill
    fs.appendFileSync(rec.eventsPath, '{"seq":3,"kind":"broken', 'utf8');
    const loaded = MissionFlightRecorder.load(mDir);
    assert.strictEqual(loaded.schemaVersion, FLIGHT_SCHEMA_VERSION);
    assert.strictEqual(loaded.events.length, 2);
    assert.strictEqual(loaded.truncatedLines, 1);
    assert(loaded.frames.length < 3, 'Oldest frames evicted when exceeding mission byte cap');

    // Legacy v0 schema migration
    const legacyDir = path.join(mDir, 'legacy_v0');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'flight_manifest.json'), JSON.stringify({ schemaVersion: 0 }), 'utf8');
    fs.writeFileSync(path.join(legacyDir, 'events.ndjson'), JSON.stringify({ text: 'Legacy step' }) + '\n', 'utf8');
    const migrated = MissionFlightRecorder.load(legacyDir);
    assert.strictEqual(migrated.schemaVersion, FLIGHT_SCHEMA_VERSION);
    assert.strictEqual(migrated.events[0].seq, 1);

    // Export redacted bundle -> password & API key scrubbed, sensitive frame omitted
    const exportDir = path.join(mDir, 'export_bundle');
    const exp = MissionFlightRecorder.exportReplayBundle(mDir, exportDir, { blurSensitiveFrames: true });
    assert(fs.existsSync(exp.htmlPath) && fs.existsSync(exp.jsonPath));
    const exportedJson = fs.readFileSync(exp.jsonPath, 'utf8');
    assert(!exportedJson.includes('Hunter2!'));
    assert(!exportedJson.includes('sk-1234567890abcdef123456'));
    console.log('✓ #236 MissionFlightRecorder NDJSON, crash tolerance, eviction, migration & redacted export verified');
  } finally {
    fs.rmSync(mDir, { recursive: true, force: true });
  }

  console.log('✓ All Flight Recorder & Replay tests passed!\n');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
