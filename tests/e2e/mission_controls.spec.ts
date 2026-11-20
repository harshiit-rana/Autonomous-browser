import { test, expect } from './fixtures.js';
import { startMission, waitForStatus } from './helpers.js';

/** Pause and Resume in the mission-control drawer act on the running loop in the main process. */
test.describe('pause and resume a running mission', () => {
  const waits = Array.from({ length: 8 }, () => ({ expectTools: ['wait'], respond: { tool: 'wait', args: { ms: 100 } } }));
  test.use({
    script: {
      build: () => [...waits, { respond: { tool: 'done', args: { result: 'Finished after a pause.', evidence: [] } } }]
    }
  });

  test('pausing holds the loop, resuming lets it finish', async ({ app }) => {
    await startMission(app, 'wait a little and then report that you are done');
    await expect(app.chromePage.locator('#evidence-feed')).toContainText('[Step 1]');

    await app.chromePage.locator('#pause-agent-btn').click();
    await waitForStatus(app, 'paused');
    await expect(app.chromePage.locator('#pause-agent-btn')).toHaveText('Resume');

    // With the loop parked, the remaining ~8 steps (about 0.7 s each) cannot finish: the mission must NOT complete.
    await expect(waitForStatus(app, 'completed', 3_000)).rejects.toThrow(/Timed out/);

    await app.chromePage.locator('#pause-agent-btn').click();
    const done = await waitForStatus(app, ['completed', 'failed', 'cancelled'], 60_000);
    expect(done.status, done.message).toBe('completed');

    const order = (await app.snapshot()).statusHistory.map(s => s.status);
    const paused = order.indexOf('paused');
    expect(paused).toBeGreaterThan(-1);
    expect(order.slice(paused)).toEqual(expect.arrayContaining(['running', 'completed']));
    expect(order.indexOf('running', paused)).toBeLessThan(order.lastIndexOf('completed'));
    expect((await app.snapshot()).model).toMatchObject({ consumed: 9, scriptSteps: 9, deviations: [] });
  });
});
