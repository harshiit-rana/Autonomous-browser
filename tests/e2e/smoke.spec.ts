import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect, ROOT } from './fixtures.js';
import { openUrl, startMission, waitForStatus, assertArenaState, screenshot, verifierPasses } from './helpers.js';

/**
 * Smoke: the REAL app launches, and a scripted mission drives it end to end.
 * Each assertion would fail if the matching part of the product broke (see the comments); none compares a value to itself.
 */

const electronPkgVersion: string = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')).version;

test.describe('launch', () => {
  test('the real Electron app starts on an isolated profile and renders its chrome', async ({ app }, testInfo) => {
    const snap = await app.snapshot();

    // It is the real Electron runtime, the installed version, not a stub process.
    expect(snap.electronVersion).toBe(electronPkgVersion);
    // Both profiles are the throw-away ones (Chromium's via --user-data-dir), so a test can never touch or lock a real profile.
    expect(path.dirname(path.resolve(snap.userData))).toBe(path.dirname(path.resolve(app.userDataDir)));
    // The product opened its database in that profile (initialisePersistence ran), proving main-process startup completed.
    await expect.poll(() => fs.readdirSync(app.userDataDir).some(f => /\.sqlite|\.db/.test(f)), { message: 'database file in the isolated profile' }).toBe(true);

    // The chrome window is the product's renderer, loaded from dist/renderer, with the preload bridge present.
    expect(app.chromePage.url()).toMatch(/renderer[\\/]index\.html$/);
    await expect(app.chromePage.locator('#omnibar-input')).toBeVisible();
    await expect(app.chromePage.locator('#swarm-run-btn')).toBeVisible();
    await expect(app.chromePage.locator('#tab-strip')).toBeVisible();
    expect(await app.chromePage.evaluate(() => typeof (window as any).aegis.startMission)).toBe('function');

    // The native tab view exists and is a WebContents of the main process (the renderer cannot fake this).
    await expect.poll(async () => (await app.snapshot()).tabs.length, { message: 'tab strip populated by the main process' }).toBeGreaterThan(0);
    expect((await app.snapshot()).contents.some(c => c.type === 'window' || c.type === 'browserView')).toBe(true);

    // The product's own startup log line is in its log file inside the isolated profile (CI uploads the folder).
    const appLog = path.join(app.userDataDir, 'logs', 'app.log');
    await expect.poll(() => (fs.existsSync(appLog) ? fs.readFileSync(appLog, 'utf8') : ''), { message: 'startup log line' }).toContain('Electron app ready');

    await screenshot(app, testInfo, 'launch');
  });
});

test.describe('scripted mission', () => {
  test.use({
    script: {
      build: () => [
        {
          // The loop perceived the arena index the user opened, including its links, before asking the model.
          expectTools: ['click', 'done'],
          expectPageContains: ['Web Arena Test Suite', '[e1] a "/shop - E-Commerce Store"'],
          respond: { text: 'The shop link is the first one.', tool: 'click', args: { ref: 'e1' } }
        },
        {
          // The click really navigated the native tab: the loop now perceives the shop page.
          expectPageContains: ['Hardware Shop - Web Arena', 'button "Buy Now"', 'h1: Hardware Express'],
          respond: { tool: 'done', args: { result: 'Shop reached: Hardware Express lists three GPUs.', evidence: ['Hardware Express'] } }
        }
      ]
    },
    verifierScript: { build: () => [verifierPasses('Shop reached')] }
  });

  test('clicks through to the arena shop and completes', async ({ app }, testInfo) => {
    await openUrl(app, `${app.arena.baseUrl}/`);
    await startMission(app, 'open the shop and report what it sells');
    const done = await waitForStatus(app, ['completed', 'failed', 'cancelled']);
    expect(done.status, done.message).toBe('completed');
    expect(done.message).toContain('Shop reached');

    // The fixture server saw the user's page load and then the agent's click, in that order: independent of the app.
    await assertArenaState(app, state => expect(state.pageViews).toEqual(['/', '/shop']));

    // The native tab sits on the shop (Electron's own answer, and the product's report to the chrome window).
    const snap = await app.snapshot();
    expect(snap.contents.some(c => c.url === `${app.arena.baseUrl}/shop`), JSON.stringify(snap.contents)).toBe(true);
    expect(snap.tabs.some(t => t.url === `${app.arena.baseUrl}/shop`)).toBe(true);
    // The step feed in the chrome UI shows the agent's action.
    await expect(app.chromePage.locator('#evidence-feed')).toContainText('[Action] click');
    // The model was consulted exactly as scripted, nothing more.
    // The independent verifier ran as a separate call and passed; its verdict is in the status message.
    expect(done.message).toMatch(/verifier: pass/);
    expect(snap.model).toMatchObject({ mode: 'scripted', deviations: [], roles: { actor: { consumed: 2, scriptSteps: 2 }, verifier: { consumed: 1, scriptSteps: 1 } } });

    await screenshot(app, testInfo, 'mission-completed');
  });
});
