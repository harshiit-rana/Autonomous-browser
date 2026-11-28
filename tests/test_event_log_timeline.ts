/**
 * Unit + Golden DOM tests for #235 [LIV-04]:
 * - MissionEvent schema validator
 * - EventLog monotonic seq, secret/PII redaction BEFORE persistence, binary payload omission, since(seq) resync
 * - TimelineStore idempotency (duplicates, out-of-order), scroll collapsing, 10k+ row scale, live-region rate limit
 * - Golden snapshot check on fixtures/events/swarm3.json
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isMissionEvent, type MissionEvent } from '../src/ipc/contract.js';
import { EventLog } from '../src/agent/event_log.js';
import { TimelineStore, renderTimelineRowHtml, LIVE_REGION_MIN_INTERVAL_MS } from '../src/renderer/timeline.js';

console.log('--- Testing #235 [LIV-04]: EventLog & Timeline Store ---');

// 1. Secret & binary redaction BEFORE persistence
{
  const persisted: MissionEvent[] = [];
  const forwarded: MissionEvent[] = [];
  const log = new EventLog('m_sec', {
    privacyMode: 'Careful',
    persist: ev => persisted.push(ev),
    forward: ev => forwarded.push(ev),
    now: () => 1700000000000
  });

  log.emit('tool_call', {
    tool: 'type',
    targetLabel: 'Password field',
    text: 'SuperSecretPass123!',
    apiKey: 'sk-1234567890abcdef123456',
    screenshot: Buffer.from('raw-binary-bytes'),
    emailNote: 'user@example.com'
  }, { workerId: 'w1', stepId: 's1' });

  assert.strictEqual(persisted.length, 1);
  assert.strictEqual(forwarded.length, 1);
  const ev = persisted[0];
  assert.strictEqual(isMissionEvent(ev), true);
  assert.strictEqual(ev.seq, 1);
  assert.strictEqual(ev.data.text, '[REDACTED_INPUT]');
  assert.strictEqual(ev.data.apiKey, '[REDACTED]');
  assert.strictEqual(ev.data.emailNote, '[REDACTED_EMAIL]');
  assert.deepStrictEqual(ev.data.screenshot, { binaryOmitted: true, byteLength: 16 });
  console.log('✓ Secret, PII & binary redaction verified before persistence');
}

// 2. Duplicate/out-of-order idempotency, since(seq) resync, scroll collapsing, 10k+ scale
{
  const log = new EventLog('m_scale', { now: () => 1700000001000 });
  const ev1 = log.emit('step_started', { task: 'Start' }, { workerId: 'w1' });
  const ev2 = log.emit('tool_call', { tool: 'scroll', direction: 'down' }, { workerId: 'w1' });
  const ev3 = log.emit('tool_call', { tool: 'scroll', direction: 'down' }, { workerId: 'w1' });
  const ev4 = log.emit('tool_call', { tool: 'scroll', direction: 'down' }, { workerId: 'w1' });
  assert.strictEqual(log.since(2).map(e => e.seq).join(','), '3,4');

  const store = new TimelineStore();
  // Deliver out of order & with duplicate seq
  store.apply(ev4);
  store.apply(ev2);
  store.apply(ev1);
  store.apply(ev2);
  store.apply(ev3);
  const rows = store.query({ category: 'all', workerId: 'all', search: '', pinnedOnly: false });
  assert.strictEqual(rows.length, 2, '3 consecutive scrolls collapsed into 1 row');
  assert.strictEqual(rows[1].collapsedScrollCount, 3);

  // Scale test: 10,500 events
  const t0 = Date.now();
  for (let i = 5; i <= 10500; i++) {
    store.apply({
      seq: i,
      ts: 1700000000000 + i,
      missionId: 'm_scale',
      workerId: i % 2 === 0 ? 'w1' : 'w2',
      kind: 'tool_call',
      data: { tool: 'click', targetLabel: `Btn ${i}` }
    });
  }
  const queried = store.query({ category: 'all', workerId: 'w2', search: '', pinnedOnly: false });
  assert.ok(queried.length > 5000);
  assert.ok(Date.now() - t0 < 2000, '10.5k event reduction + query completed fast');
  assert.ok(LIVE_REGION_MIN_INTERVAL_MS >= 2000);
  console.log('✓ Idempotent reducer, scroll collapse, since(seq), and 10k+ scale verified');
}

// 3. Golden test: replay fixtures/events/swarm3.json into TimelineStore & verify rendered DOM cards
{
  const fixturePath = path.resolve(process.cwd(), 'fixtures', 'events', 'swarm3.json');
  const fixtureEvents: MissionEvent[] = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const store = new TimelineStore();
  store.applyBatch(fixtureEvents);

  const entries = store.query({ category: 'all', workerId: 'all', search: '', pinnedOnly: false });
  assert.strictEqual(entries.length, fixtureEvents.length);
  const html = entries.map(renderTimelineRowHtml).join('\n');

  // Verify exact worker chips, distinct Okabe-Ito colors, and golden DOM structure
  assert.ok(html.includes('Alpha Shop') && html.includes('#56B4E9'));
  assert.ok(html.includes('Beta Shop') && html.includes('#E69F00'));
  assert.ok(html.includes('Gamma Shop') && html.includes('#009E73'));
  assert.ok(html.includes('data-seq="14"') && html.includes('data-worker-id="swarm_worker_1"'));
  // Replay a second time (resync idempotency) -> identical HTML output
  store.applyBatch(fixtureEvents.slice(0, 6));
  const entriesAfterDup = store.query({ category: 'all', workerId: 'all', search: '', pinnedOnly: false });
  assert.strictEqual(entriesAfterDup.map(renderTimelineRowHtml).join('\n'), html);
  console.log('✓ Golden DOM snapshot on fixtures/events/swarm3.json verified');
}

console.log('✓ All #235 EventLog & Timeline tests passed!');
