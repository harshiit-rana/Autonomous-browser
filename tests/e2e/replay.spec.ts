/**
 * Real-App E2E (#236 [LIV-05]): Flight recorder & Replay
 * - Runs a fixture mission with frame capture (`AEGIS_RECORD_FRAMES=1`)
 * - Opens Replay in `lab.html`, scrubs to the middle step, and verifies the displayed frame hash
 *   matches the recorded `frames/NNNN.jpg` SHA-256 on disk
 * - Appends a crash-truncated NDJSON line to `events.ndjson` and verifies the partial log still opens
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from './fixtures';
import { startMission, waitForStatus } from './helpers.js';

const EVIDENCE_DIR = path.join(process.cwd(), 'docs', 'audits', 'evidence', '236');

test.describe('Flight recorder & Replay (#236)', () => {
  test.use({
    script: {
      build: ({ arenaUrl }) => [
        { respond: { tool: 'navigate', args: { url: `${arenaUrl}/forms` } } },
        { respond: { tool: 'wait', args: { ms: 50 } } },
        { respond: { tool: 'done', args: { result: 'Visited Forms cleanly', evidence: ['Complex Form loaded'] } } }
      ]
    },
    verifierScript: {
      build: () => [{ respond: { tool: 'report_verdict', args: { verdict: 'pass', reasons: ['ok'] } } }]
    }
  });

  test('records events + JPEG frames, scrubs in Replay matching disk SHA-256, and tolerates truncated crash log', async ({ app }) => {
    await app.electronApp.evaluate(() => {
      process.env.AEGIS_RECORD_FRAMES = '1';
    });

    const startRes = await startMission(app, 'visit Forms for replay verification');
    const done = await waitForStatus(app, ['completed', 'completed_unverified', 'failed', 'cancelled'], 30_000);
    expect(['completed', 'completed_unverified']).toContain(done.status);
    const missionId = done.missionId || startRes.missionId!;
    expect(missionId).toBeTruthy();

    const missionDir = path.join(app.userDataDir, 'missions', missionId);
    const eventsPath = path.join(missionDir, 'events.ndjson');
    expect(fs.existsSync(eventsPath)).toBe(true);

    // Wait briefly for async capturePage JPEG flush if any frame was written
    await expect.poll(() => {
      const framesDir = path.join(missionDir, 'frames');
      return fs.existsSync(framesDir) ? fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg')).length : 0;
    }, { timeout: 5_000 }).toBeGreaterThanOrEqual(1);

    // Simulate sudden mid-mission crash leaving a truncated trailing NDJSON line
    fs.appendFileSync(eventsPath, '{"seq":9999,"kind":"tool_cal', 'utf8');

    await app.chromePage.evaluate((id) => {
      window.location.assign(`./lab.html?missionId=${encodeURIComponent(id)}`);
    }, missionId);
    await app.chromePage.waitForURL(/lab\.html/, { timeout: 10_000 });

    await expect.poll(async () => {
      return app.chromePage.evaluate(() => (window as any).__motionLab?.stats()?.replayEvents ?? 0);
    }, { timeout: 10_000 }).toBeGreaterThanOrEqual(3);

    const frameFiles = fs.readdirSync(path.join(missionDir, 'frames')).filter(f => f.endsWith('.jpg')).sort();
    const expectedHashes = frameFiles.map(f =>
      crypto.createHash('sha256').update(fs.readFileSync(path.join(missionDir, 'frames', f))).digest('hex')
    );

    const middleIdx = await app.chromePage.evaluate(() => {
      const lab = (window as any).__motionLab;
      const total = lab.stats().replayEvents;
      const mid = Math.floor(total / 2);
      lab.scrubToStep(mid);
      return { mid, stats: lab.stats() };
    });

    expect(middleIdx.stats.replayFrames).toBeGreaterThanOrEqual(1);
    expect(expectedHashes).toContain(middleIdx.stats.activeFrameHash);

    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    await app.chromePage.screenshot({ path: path.join(EVIDENCE_DIR, 'replay_scrubber.png') });
  });
});
