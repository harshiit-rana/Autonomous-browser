import { test, expect } from './fixtures.js';
import { openUrl, startMission, waitForStatus } from './helpers.js';

/**
 * Negative test of the harness itself: when the loop deviates from the script, the mission fails loudly and the deviation
 * is recorded. (Every other spec gets the same recording turned into a test failure by the `app` fixture; this one opts
 * out with allowDeviations so the mechanism can be observed.)
 */
test.describe('scripted model deviations are detected', () => {
  test.use({
    allowDeviations: true,
    script: {
      build: () => [
        // The page the user opened is the arena index; the script claims otherwise.
        { expectPageContains: ['THIS TEXT IS NOT ON THE PAGE'], respond: { tool: 'click', args: { ref: 'e1' } } }
      ]
    }
  });

  test('a wrong page observation fails the mission before any action runs', async ({ app }) => {
    await openUrl(app, `${app.arena.baseUrl}/`);
    await startMission(app, 'follow the first link');

    const failed = await waitForStatus(app, ['failed', 'completed', 'completed_unverified', 'cancelled']);
    expect(failed.status).toBe('failed');
    expect(failed.message).toContain('E2E script deviation');

    const model = (await app.snapshot()).model as { deviations: string[]; roles: { actor: { consumed: number } } };
    expect(model.deviations).toHaveLength(1);
    expect(model.deviations[0]).toContain('THIS TEXT IS NOT ON THE PAGE');
    expect(model.roles.actor.consumed).toBe(0);

    // The scripted click was never executed: the server saw only the page the user opened.
    expect((await app.arena.state()).pageViews).toEqual(['/']);
  });
});
