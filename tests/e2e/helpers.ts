/**
 * Thin helpers over the real app (#254). Waits are event-based: `waitForStatus` resolves from the main process the moment
 * the runtime emits the status, it does not poll or sleep.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TestInfo } from '@playwright/test';
import { expect, type AppHandle, type ArenaState } from './fixtures.js';
import type { E2ESnapshot } from '../../src/main/e2e_hooks.js';
import type { MissionStatusPayload } from '../../src/ipc/contract.js';

export type MissionState = MissionStatusPayload['status'];

/**
 * Navigates the active tab the way a user does (omnibar + Enter) and waits until the native view reports the URL.
 * Missions are scoped to the origin of the page they start on, so a mission test first opens its fixture page.
 */
export async function openUrl(app: AppHandle, url: string): Promise<void> {
  const omnibar = app.chromePage.locator('#omnibar-input');
  await omnibar.fill(url);
  await expect(omnibar).toHaveValue(url);
  await omnibar.press('Enter');
  await expect.poll(async () => (await app.snapshot()).contents.some(c => c.url === url), { message: `native view on ${url}` }).toBe(true);
}

/**
 * Starts a mission the way a user does: types `/do <brief>` in the omnibar, presses Run, then confirms the plan preview.
 * Returns once the mission-start IPC has answered (the mission is then running in the main process).
 */
export async function startMission(app: AppHandle, brief: string): Promise<void> {
  const { chromePage } = app;
  await chromePage.locator('#omnibar-input').fill(`/do ${brief}`);
  await chromePage.locator('#swarm-run-btn').click();
  await expect(chromePage.locator('#plan-preview-modal')).not.toHaveClass(/hidden/);
  await expect(chromePage.locator('#plan-goal-text')).toHaveText(brief);
  await chromePage.locator('#execute-plan-btn').click();
  await expect(chromePage.locator('#plan-preview-modal')).toHaveClass(/hidden/);
}

/** Resolves with the first mission status in `states` (also one that already happened), or rejects with recent evidence. */
export async function waitForStatus(
  app: AppHandle,
  states: MissionState | MissionState[],
  timeoutMs = 60_000
): Promise<MissionStatusPayload> {
  const wanted = Array.isArray(states) ? states : [states];
  return app.electronApp.evaluate(
    (_electron, { wanted, timeoutMs }) => (globalThis as any).__AEGIS_E2E__.waitForStatus(wanted, timeoutMs),
    { wanted, timeoutMs }
  ) as Promise<MissionStatusPayload>;
}

/** Tabs as the product reported them to the chrome window. */
export async function tabs(app: AppHandle): Promise<E2ESnapshot['tabs']> {
  return (await app.snapshot()).tabs;
}

/** Resumes a mission that paused. Real approval objects (approve/deny with a screenshot) arrive with #238, see docs/limitations.md. */
export async function resume(app: AppHandle): Promise<void> {
  await app.chromePage.evaluate(() => (window as any).aegis.resumeMission());
}

/** Screenshot of the chrome window into the test's output dir; also attached to the report. */
export async function screenshot(app: AppHandle, testInfo: TestInfo, name: string): Promise<string> {
  const file = path.join(testInfo.outputDir, `${name}.png`);
  fs.mkdirSync(testInfo.outputDir, { recursive: true });
  await app.chromePage.screenshot({ path: file });
  await testInfo.attach(name, { path: file, contentType: 'image/png' });
  return file;
}

/**
 * Asserts on what the fixture server recorded. Retries until the expectation holds because the server learns about an
 * action a moment after the app performs it (a form post in flight), not because the assertion is loose.
 */
export async function assertArenaState(
  app: AppHandle,
  check: (state: ArenaState) => void,
  message = 'arena state'
): Promise<void> {
  await expect.poll(async () => {
    try { check(await app.arena.state()); return 'ok'; } catch (err) { return String((err as Error).message); }
  }, { message, timeout: 10_000 }).toBe('ok');
}
