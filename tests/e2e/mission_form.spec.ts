import { test, expect } from './fixtures.js';
import { openUrl, startMission, waitForStatus, screenshot } from './helpers.js';

/**
 * The agent loop types into a real form in a real native tab, then tries the irreversible submit. The safety policy must
 * hold the submit for human approval: the page values are really typed, the mission pauses, and the fixture server
 * (the only independent witness) never receives the submission.
 *
 * Approve/deny objects do not exist yet (#238): resuming discards the held action. That is recorded in
 * docs/limitations.md, so this spec ends by cancelling from the mission-control UI.
 */
test.describe('irreversible submit needs approval', () => {
  test.use({
    script: {
      build: () => [
        {
          expectTools: ['type', 'click', 'done'],
          expectPageContains: ['Complex Form - Web Arena', '[e1] input[type="text"]', '[e2] input[type="email"]', '[e4] button[type="submit"] "Complete Registration"'],
          respond: { text: 'The form needs a name and an email.', tool: 'type', args: { ref: 'e1', text: 'Ada Lovelace' } }
        },
        { respond: { tool: 'type', args: { ref: 'e2', text: 'ada@example.com' } } },
        { respond: { tool: 'click', args: { ref: 'e4' } } }
      ]
    }
  });

  test('typing runs, the submit is held, the server sees nothing, cancel ends the mission', async ({ app }, testInfo) => {
    const formUrl = `${app.arena.baseUrl}/forms`;
    await openUrl(app, formUrl);

    await startMission(app, 'register Ada Lovelace with the email ada@example.com on this form');

    // The loop reached the submit and the policy held it.
    const held = await waitForStatus(app, ['paused', 'completed', 'failed']);
    expect(held.status, held.message).toBe('paused');
    expect(held.message).toMatch(/approval.*write-irreversible.*Complete Registration/s);
    await expect(app.chromePage.locator('#evidence-feed')).toContainText('[Human Approval Required: write-irreversible]');
    expect((await app.snapshot()).approvals).toHaveLength(1);

    // The two type actions really ran in the page (read back from the native tab's own DOM).
    const tab = app.electronApp.windows().find(w => w.url() === formUrl);
    expect(tab, `native tab on ${formUrl}`).toBeTruthy();
    await expect(tab!.locator('#full_name')).toHaveValue('Ada Lovelace');
    await expect(tab!.locator('#email')).toHaveValue('ada@example.com');
    await expect(tab!.locator('#website_hp')).toHaveValue(''); // the honeypot was left alone

    // The held click did not run: the server has seen the form page and nothing else.
    const state = await app.arena.state();
    expect(state.submittedForms).toEqual([]);
    expect(state.pageViews).toEqual(['/forms']);

    await screenshot(app, testInfo, 'submit-held');

    await app.chromePage.locator('#cancel-mission-btn').click();
    const ended = await waitForStatus(app, 'cancelled');
    expect(ended.message).toContain('cancelled');
    // Nothing was submitted by the cancellation either.
    expect((await app.arena.state()).submittedForms).toEqual([]);
    expect((await app.snapshot()).model).toMatchObject({ consumed: 3, scriptSteps: 3, deviations: [] });
  });
});
