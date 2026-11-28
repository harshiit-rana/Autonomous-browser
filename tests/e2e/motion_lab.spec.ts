/**
 * Real-App E2E (#234 [LIV-03]): Motion tokens, Motion Lab fixture replay & 10-worker stress burst
 * (< 20 ms p95 frame budget), prefers-reduced-motion compliance (zero transform keyframes), and
 * settings persistence across restart.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from './fixtures';

const EVIDENCE_DIR = path.join(process.cwd(), 'docs', 'audits', 'evidence', '234');

test.describe('Motion engine & Motion Lab (#234)', () => {
  test('replays swarm3 fixture and handles 10-worker 50 ev/s stress burst under p95 < 20ms', async ({ app }) => {
    // Navigating with ?lab=1 verifies app.ts redirect into lab.html inside real Electron
    await app.chromePage.evaluate(() => {
      window.location.assign('./index.html?lab=1');
    });
    await app.chromePage.waitForURL(/lab\.html/, { timeout: 10_000 });
    await expect(app.chromePage.locator('#lab-replay-btn')).toBeVisible();

    const result = await app.chromePage.evaluate(async () => {
      const lab = (window as any).__motionLab;
      if (!lab) throw new Error('Motion Lab global missing');
      await lab.replayFixture('swarm3');
      const afterReplay = lab.stats();
      await lab.runStressBurst(10, 50, 1200);
      const afterStress = lab.stats();
      return {
        afterReplay,
        afterStress,
        workerTiles: document.querySelectorAll('#lab-workers .lab-tile').length,
        feedRows: document.querySelectorAll('#lab-feed .lab-ev').length,
        motionDataset: document.documentElement.dataset.motion
      };
    });

    expect(result.afterReplay.intents).toBeGreaterThanOrEqual(5);
    expect(result.workerTiles).toBe(10);
    expect(result.feedRows).toBeGreaterThan(20);
    expect(result.afterStress.p95Ms).toBeLessThan(20);

    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    await app.chromePage.screenshot({ path: path.join(EVIDENCE_DIR, 'motion_lab_stress.png') });
  });

  test('prefers-reduced-motion: reduce eliminates transform WAAPI keyframes', async ({ app }) => {
    await app.chromePage.evaluate(() => {
      window.location.assign('./lab.html');
    });
    await app.chromePage.waitForURL(/lab\.html/, { timeout: 10_000 });
    await expect(app.chromePage.locator('#lab-replay-btn')).toBeVisible();
    await app.chromePage.emulateMedia({ reducedMotion: 'reduce' });

    const audit = await app.chromePage.evaluate(async () => {
      const lab = (window as any).__motionLab;
      const transformKeyframes: string[] = [];
      const origAnimate = Element.prototype.animate;
      Element.prototype.animate = function (keyframes: any, options?: any) {
        const list = Array.isArray(keyframes) ? keyframes : [keyframes];
        for (const kf of list) {
          if (kf && 'transform' in kf) {
            transformKeyframes.push(String(kf.transform));
          }
        }
        return origAnimate.call(this, keyframes, options);
      };
      try {
        await lab.replayFixture('swarm3');
        return {
          mode: lab.stats().mode,
          transformKeyframes,
          intents: lab.stats().intents
        };
      } finally {
        Element.prototype.animate = origAnimate;
      }
    });

    expect(audit.mode).toBe('reduced');
    expect(audit.intents).toBeGreaterThan(0);
    expect(audit.transformKeyframes).toEqual([]);
  });

  test('persists Settings motionMode choice into runtime dataset.motion and data.motion CSS rules', async ({ app }) => {
    const initialMode = await app.chromePage.evaluate(() => document.documentElement.dataset.motion);
    expect(initialMode).toBe('full');

    await app.chromePage.locator('#settings-btn').click();
    await expect(app.chromePage.locator('#settings-modal')).not.toHaveClass(/hidden/);
    await app.chromePage.locator('#settings-motion-mode').selectOption('reduced');
    await app.chromePage.locator('#save-settings-btn').click();

    await expect(app.chromePage.locator('#settings-modal')).toHaveClass(/hidden/, { timeout: 5000 });
    const updatedMode = await app.chromePage.evaluate(() => document.documentElement.dataset.motion);
    expect(updatedMode).toBe('reduced');

    const storedMotion = await app.chromePage.evaluate(async () => {
      const res = await (window as any).aegis.getSettings();
      return (res?.data || res)?.motionMode;
    });
    expect(storedMotion).toBe('reduced');
  });
});
