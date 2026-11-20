import { defineConfig } from '@playwright/test';

/**
 * Real-app e2e (#254): launches the built Electron app with `_electron.launch`. See docs/dev/E2E.md.
 *
 * `trace` and `video` here are read by tests/e2e/fixtures.ts (Electron has no `page`/`context` fixture, so Playwright's
 * own artifact handling does not apply to it): the fixture records a trace and, when enabled, a video for every test and
 * keeps them only when the test fails. Everything lands in `test-results/`.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  workers: 1, // one Electron app at a time: a real window, GPU and the single-instance lock
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  outputDir: 'test-results',
  preserveOutput: process.env.CI ? 'always' : 'failures-only',
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : [['list']],
  globalSetup: './tests/e2e/global_setup.ts',
  use: {
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure'
  }
});
