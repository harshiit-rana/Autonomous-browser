import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FlightRecorder, FlightLog } from '../src/automation/flight_recorder.js';

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

  console.log('✓ All Flight Recorder & Replay tests passed!\n');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
