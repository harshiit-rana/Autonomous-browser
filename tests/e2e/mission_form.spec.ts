import { test, expect } from './fixtures.js';
import { approve, deny, openUrl, startMission, waitForStatus, verifierPasses, screenshot } from './helpers.js';

/**
 * The agent loop types into a real form in a real native tab, then tries the irreversible submit. The safety policy must
 * hold the submit until the user answers the approval card in the chrome UI. The fixture server (the only independent
 * witness) must see no submission before Approve, exactly one after it, and none at all after Deny.
 */
const FORM_STEPS = [
  {
    expectTools: ['type', 'click', 'done'],
    expectPageContains: ['Complex Form - Web Arena', '[e1] input[type="text"]', '[e2] input[type="email"]', '[e4] button[type="submit"] "Complete Registration"'],
    respond: { text: 'The form needs a name and an email.', tool: 'type', args: { ref: 'e1', text: 'Ada Lovelace' } }
  },
  { respond: { tool: 'type', args: { ref: 'e2', text: 'ada@example.com' } } },
  { respond: { tool: 'click', args: { ref: 'e4' } } }
];

const BRIEF = 'register Ada Lovelace with the email ada@example.com on this form';

test.describe('irreversible submit needs approval: Approve', () => {
  test.use({
    script: {
      build: () => [
        ...FORM_STEPS,
        {
          // The approved click really submitted: the browser followed the POST and the loop perceived the arena's answer.
          expectPageContains: ['"success":true'],
          respond: { tool: 'done', args: { result: 'Registration submitted for Ada Lovelace.', evidence: ['{"success":true,"honeypotTriggered":false}'] } }
        }
      ]
    },
    verifierScript: { build: () => [verifierPasses('Registration submitted for Ada Lovelace.')] }
  });

  test('the submit waits for the user, then reaches the server exactly once', async ({ app }, testInfo) => {
    const formUrl = `${app.arena.baseUrl}/forms`;
    await openUrl(app, formUrl);
    await startMission(app, BRIEF);

    // The loop reached the submit and asked; the mission is waiting for the user.
    const asked = await waitForStatus(app, ['waiting_approval', 'completed', 'failed']);
    expect(asked.status, asked.message).toBe('waiting_approval');
    const card = app.chromePage.locator('#question-card');
    await expect(card).not.toHaveClass(/hidden/);
    await expect(card.locator('#question-kind')).toHaveText('Approval needed');
    await expect(card.locator('#question-text')).toContainText('Complete Registration');
    const snapshot = await app.snapshot();
    expect(snapshot.approvals).toHaveLength(1);
    expect(snapshot.approvals[0].options).toEqual(['Approve', 'Deny']);

    // The two type actions really ran in the page (read back from the native tab's own DOM); the honeypot was left alone.
    const tab = app.electronApp.windows().find(w => w.url() === formUrl);
    expect(tab, `native tab on ${formUrl}`).toBeTruthy();
    await expect(tab!.locator('#full_name')).toHaveValue('Ada Lovelace');
    await expect(tab!.locator('#email')).toHaveValue('ada@example.com');
    await expect(tab!.locator('#website_hp')).toHaveValue('');

    // While the question is open the click has NOT run: the server has seen the form page and nothing else.
    const before = await app.arena.state();
    expect(before.submittedForms).toEqual([]);
    expect(before.pageViews).toEqual(['/forms']);
    await screenshot(app, testInfo, 'approval-card');

    await approve(app);
    const done = await waitForStatus(app, ['completed', 'completed_unverified', 'failed', 'cancelled']);
    expect(done.status, done.message).toBe('completed');

    const after = await app.arena.state();
    expect(after.submittedForms).toHaveLength(1);
    expect(after.submittedForms[0].formId).toBe('user_registration');
    expect(after.submittedForms[0].fields).toMatchObject({ full_name: 'Ada Lovelace', email: 'ada@example.com', company_size: '1-10' });
    expect(after.submittedForms[0].honeypotTriggered, 'the agent must not fill the hidden honeypot field').toBe(false);

    // The mission is persisted by the product (SQLite in the isolated profile) as a finished record.
    const missions = await app.chromePage.evaluate(() => (window as any).aegis.listMissions(10));
    expect(missions.data.find((m: { id: string }) => m.id === done.missionId)?.state).toBe('completed');
    await expect(app.chromePage.locator('#evidence-feed')).toContainText('[Policy] User approved click');
    expect((await app.snapshot()).model).toMatchObject({ deviations: [], roles: { actor: { consumed: 4, scriptSteps: 4 }, verifier: { consumed: 1, scriptSteps: 1 } } });
  });
});

test.describe('irreversible submit needs approval: Deny', () => {
  test.use({
    script: {
      build: () => [
        ...FORM_STEPS,
        {
          // The denial reached the model as a tool result it must react to.
          expectPageContains: ['Complex Form - Web Arena'],
          respond: { tool: 'done', args: { result: 'The user denied the submission, so nothing was sent.', evidence: [] } }
        }
      ]
    },
    verifierScript: { build: () => [verifierPasses('nothing was sent')] }
  });

  test('a denied submit never reaches the server', async ({ app }) => {
    await openUrl(app, `${app.arena.baseUrl}/forms`);
    await startMission(app, BRIEF);

    const asked = await waitForStatus(app, ['waiting_approval', 'completed', 'failed']);
    expect(asked.status, asked.message).toBe('waiting_approval');
    await deny(app);

    const done = await waitForStatus(app, ['completed', 'completed_unverified', 'failed', 'cancelled']);
    expect(done.status, done.message).not.toBe('cancelled');
    await expect(app.chromePage.locator('#evidence-feed')).toContainText('[Policy] User denied click');

    const state = await app.arena.state();
    expect(state.submittedForms, 'a denied irreversible action must not reach the server').toEqual([]);
    expect(state.pageViews).toEqual(['/forms']);
  });
});
