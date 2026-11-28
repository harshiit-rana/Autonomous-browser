/**
 * Unit tests for #234 [LIV-03]: Motion engine, tokens, photosensitivity ceiling,
 * frame budget auto-degradation, and settings v3 -> v4 motionMode migration.
 */
import assert from 'node:assert';
import {
  ChoreographyEngine,
  FrameBudgetMonitor,
  PHOTOSENSITIVITY_MIN_PERIOD_MS
} from '../src/ui/motion_engine.js';
import {
  migrateSettings,
  SettingsManager,
  CURRENT_SETTINGS_VERSION,
  DEFAULT_SETTINGS
} from '../src/infrastructure/settings.js';

console.log('--- Testing #234 [LIV-03]: Motion Engine & Frame Budget ---');

// 1. Out-of-order & duplicate sequence numbers are dropped per worker stream
{
  let clock = 1000;
  const engine = new ChoreographyEngine({ now: () => clock });
  const a1 = engine.enqueue({ type: 'click', workerId: 'w1', seq: 5, x: 10, y: 20 });
  const dup = engine.enqueue({ type: 'click', workerId: 'w1', seq: 5, x: 10, y: 20 });
  const ooo = engine.enqueue({ type: 'click', workerId: 'w1', seq: 3, x: 10, y: 20 });
  const w2 = engine.enqueue({ type: 'click', workerId: 'w2', seq: 1, x: 50, y: 60 });
  assert.ok(a1, 'Initial seq accepted');
  assert.strictEqual(dup, null, 'Duplicate seq dropped');
  assert.strictEqual(ooo, null, 'Out-of-order seq dropped');
  assert.ok(w2, 'Independent worker stream accepts seq 1');
  assert.strictEqual(engine.drain().length, 2);
}

// 2. 100 rapid scroll events within coalescing window coalesce cleanly without dropping independent streams
{
  let clock = 5000;
  const engine = new ChoreographyEngine({ scrollCoalesceWindowMs: 120, now: () => clock });
  let emitted = 0;
  for (let i = 1; i <= 100; i++) {
    clock += 1; // 100ms total span (< 120ms after first event)
    if (engine.enqueue({ type: 'scroll', workerId: 'w1', seq: i })) {
      emitted += 1;
    }
  }
  assert.strictEqual(emitted, 1, `100 scroll events inside 120ms window must coalesce to 1, got ${emitted}`);
  clock += 150;
  const next = engine.enqueue({ type: 'scroll', workerId: 'w1', seq: 101 });
  assert.ok(next, 'Scroll after window opens emits again');
}

// 3. Motion modes: 'full' (uses transform), 'reduced' (opacity-only fades, usesTransform=false), 'off' (durationMs=0)
{
  let clock = 1000;
  const engine = new ChoreographyEngine({ motionMode: 'full', now: () => clock });
  const fullSpawn = engine.mapEventToIntent({ type: 'worker_spawn', workerId: 'w1', seq: 1 });
  assert.ok(fullSpawn && fullSpawn.usesTransform && fullSpawn.durationMs > 0);

  engine.setMotionMode('reduced');
  const redSpawn = engine.mapEventToIntent({ type: 'worker_spawn', workerId: 'w1', seq: 2 });
  assert.ok(redSpawn);
  assert.strictEqual(redSpawn.usesTransform, false, 'Reduced mode must never emit transform intents');
  assert.ok(redSpawn.durationMs > 0 && redSpawn.durationMs <= 120, 'Reduced mode uses short opacity fade');

  engine.setMotionMode('off');
  const offSpawn = engine.mapEventToIntent({ type: 'worker_spawn', workerId: 'w1', seq: 3 });
  assert.ok(offSpawn);
  assert.strictEqual(offSpawn.durationMs, 0, 'Off mode must have 0ms duration');
}

// 4. Photosensitivity safety cap (< 3 flashes/s => minPeriodMs >= 350ms on approval/error/complete)
{
  assert.ok(PHOTOSENSITIVITY_MIN_PERIOD_MS >= 334, 'Photosensitivity period constant must enforce < 3 Hz');
  const engine = new ChoreographyEngine({ motionMode: 'full' });
  const approval = engine.mapEventToIntent({ type: 'approval', workerId: 'w1', seq: 1, text: 'Pay' });
  const err = engine.mapEventToIntent({ type: 'error', workerId: 'w1', seq: 2, text: 'Timeout' });
  const done = engine.mapEventToIntent({ type: 'complete', seq: 3 });
  assert.ok((approval?.minPeriodMs ?? 0) >= PHOTOSENSITIVITY_MIN_PERIOD_MS);
  assert.ok((err?.minPeriodMs ?? 0) >= PHOTOSENSITIVITY_MIN_PERIOD_MS);
  assert.ok((done?.minPeriodMs ?? 0) >= PHOTOSENSITIVITY_MIN_PERIOD_MS);
}

// 5. FrameBudgetMonitor stays healthy under 16ms frames and degrades after sustained >20ms p95 for >= 3000ms
{
  const mon = new FrameBudgetMonitor({ budgetMs: 20, sustainMs: 3000, windowSize: 60 });
  for (let i = 0; i < 30; i++) {
    const s = mon.recordFrame(12, i * 16);
    assert.strictEqual(s.degraded, false);
  }
  mon.reset();
  let t = 0;
  let last = mon.snapshot();
  // Brief spike under 3s should not degrade yet
  for (let i = 0; i < 20; i++) {
    t += 50;
    last = mon.recordFrame(28, t);
  }
  assert.strictEqual(last.degraded, false, 'Transient jank < 3000ms must not degrade immediately');
  // Sustained >20ms p95 crossing 3000ms
  for (let i = 0; i < 65; i++) {
    t += 50;
    last = mon.recordFrame(28, t);
  }
  assert.strictEqual(last.degraded, true, 'Sustained >20ms p95 for >= 3s must trigger degradation');
  assert.ok(last.p95Ms > 20);
}

// 6. Settings v3 -> v4 migration defaults motionMode='full' and SettingsManager persists updates via repo
{
  assert.strictEqual(CURRENT_SETTINGS_VERSION, 4);
  assert.strictEqual(DEFAULT_SETTINGS.motionMode, 'full');

  const migratedDefault = migrateSettings({ version: 3, modelProvider: 'gemini' });
  assert.strictEqual(migratedDefault.changed, true);
  assert.strictEqual(migratedDefault.fields.version, 4);
  assert.strictEqual(migratedDefault.fields.motionMode, 'full');

  const migratedPreserved = migrateSettings({ version: 3, motionMode: 'reduced' });
  assert.strictEqual(migratedPreserved.fields.motionMode, 'reduced');

  const rows: Record<string, unknown> = { version: 3, modelProvider: 'gemini' };
  const fakeRepo: any = {
    all: () => ({ ...rows }),
    set: (k: string, v: unknown) => { rows[k] = v; },
    setMany: (entries: Record<string, unknown>) => { Object.assign(rows, entries); }
  };
  const mgr = SettingsManager.getInstance();
  try {
    const loaded = mgr.attachRepo(fakeRepo);
    assert.strictEqual(loaded.version, 4);
    assert.strictEqual(loaded.motionMode, 'full');
    const updated = mgr.updateSettings({ motionMode: 'reduced' });
    assert.strictEqual(updated.motionMode, 'reduced');
    const reloaded = mgr.load();
    assert.strictEqual(reloaded.motionMode, 'reduced');
  } finally {
    mgr.detachRepo();
  }
}

console.log('✓ All #234 Motion Engine unit tests passed!');
