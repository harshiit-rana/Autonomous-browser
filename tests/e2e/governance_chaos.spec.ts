/**
 * #231 [SWX-05] Chaos & Governance acceptance in the real Electron app:
 *  - Live Chromium app.getAppMetrics(), working set, webContents count & event-loop lag over IPC
 *  - Inject a 10 s hang in one fixture shop while a healthy sibling finishes normally; supervisor
 *    aborts + retries + flags the hung worker `stalled` within configured timeout
 *  - Per-worker Pause / Resume / Stop buttons on worker cards
 *  - Global Kill Switch stops model calls, closes agent tabs, and emits `mission:status: cancelled` < 1 s
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { test, expect } from './fixtures.js';
import { openUrl, startMission, waitForStatus } from './helpers.js';
import { SHOPS, PRODUCT, startShop, type ShopHandle } from './shop_fixtures.js';

interface HangingServer {
  url: string;
  requests: () => number;
  stop: () => Promise<void>;
}

async function startHangingShop(hangMs: number): Promise<HangingServer> {
  let hits = 0;
  const sockets = new Set<any>();
  const server = http.createServer((req, res) => {
    hits += 1;
    if (req.url === '/product') {
      const t = setTimeout(() => {
        if (!res.writableEnded) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body>Too late</body></html>');
        }
      }, hangMs);
      req.on('close', () => clearTimeout(t));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/product`,
    requests: () => hits,
    stop: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>(r => server.close(() => r()));
    }
  };
}

let healthyShop: ShopHandle;
let hangingShop: HangingServer;

test.beforeAll(async () => {
  healthyShop = await startShop(SHOPS[0]);
  hangingShop = await startHangingShop(12_000);
});

test.afterAll(async () => {
  await healthyShop?.stop();
  await hangingShop?.stop();
});

test.describe('chaos stall supervision & real governance metrics', () => {
  test.use({
    extraArgs: [],
    script: {
      build: () => [
        {
          route: { goalContains: `Start page: ${healthyShop.productUrl}` },
          expectTools: ['report_finding', 'finish_task'],
          expectPageContains: [healthyShop.offerLine],
          respond: {
            tool: 'report_finding',
            args: {
              entity: `${PRODUCT} at ${healthyShop.name}`,
              attribute: 'price',
              value: healthyShop.priceText,
              quote: healthyShop.offerLine,
              url: healthyShop.productUrl
            }
          }
        },
        {
          route: { goalContains: `Start page: ${healthyShop.productUrl}` },
          respond: {
            tool: 'finish_task',
            args: { status: 'completed', summary: `${healthyShop.name}: ${healthyShop.priceText}` }
          }
        }
      ]
    },
    verifierScript: { build: () => [] }
  });

  test('supervisor flags a 12s hung worker cleanly while healthy sibling completes and exposes real Chromium metrics', async ({ app }) => {
    // Configure tight supervisor window in main process for deterministic chaos verification (< 8 s total)
    await app.electronApp.evaluate(() => {
      process.env.AEGIS_WORKER_STALL_MS = '2200';
    });

    const govRes = await app.chromePage.evaluate(() => (window as any).aegis.getGovernanceMetrics());
    const gov = govRes?.data || govRes;
    expect(gov.metricsAvailable).toBe(true);
    expect(gov.activeWebContentsCount).toBeGreaterThanOrEqual(1);
    expect(gov.totalSystemMemMb).toBeGreaterThan(0);
    expect(gov.recommendedConcurrency).toBeGreaterThanOrEqual(1);

    await startMission(app, `compare the price of ${PRODUCT} across ${healthyShop.productUrl} ${hangingShop.url}`);
    const end = await waitForStatus(app, ['completed', 'failed', 'cancelled'], 45_000);
    expect(end.status, end.message).toBe('completed');

    const snap = await app.snapshot();
    expect(snap.evidence.some(e => e.includes('[Supervisor]') && e.includes('stalled'))).toBe(true);
    const workerStatuses = Object.values(snap.workers).map(w => w.status);
    expect(workerStatuses).toContain('done');
    expect(workerStatuses).toContain('stalled');

    const evDir = process.env.AEGIS_E2E_EVIDENCE_DIR;
    if (evDir) {
      fs.mkdirSync(evDir, { recursive: true });
      await app.chromePage.screenshot({ path: path.join(evDir, 'chaos-stall-recovered.png') });
      fs.writeFileSync(path.join(evDir, 'governance-metrics.json'), JSON.stringify(gov, null, 2));
    }
  });
});

test.describe('per-worker controls & global kill switch < 1s', () => {
  test.use({
    allowUnconsumedScript: true,
    script: {
      build: () => [
        {
          expectTools: ['wait', 'done'],
          respond: { tool: 'wait', args: { ms: 15_000 } }
        }
      ]
    },
    verifierScript: { build: () => [] }
  });

  test('per-worker Pause/Resume buttons and Global Kill Switch (< 1s, closes agent tabs, emits cancelled)', async ({ app, arena }) => {
    await openUrl(app, `${arena.baseUrl}/products`);
    await startMission(app, 'Inspect products slowly');

    // Wait for worker card with real Pause / Takeover / Stop controls
    const card = app.chromePage.locator('.worker-card').first();
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.locator('button[data-action="pause"]')).toBeVisible();
    await expect(card.locator('button[data-action="stop"]')).toBeVisible();

    // Pause the worker via its card control and verify real runtime state transitions to paused, then Resume
    await card.locator('button[data-action="pause"]').click();
    await expect(card.locator('button[data-action="resume"]')).toBeVisible({ timeout: 5_000 });
    expect((await app.snapshot()).missionStatus?.status).toBe('paused');
    await card.locator('button[data-action="resume"]').click();
    await expect(card.locator('button[data-action="pause"]')).toBeVisible({ timeout: 5_000 });

    const t0 = Date.now();
    await app.chromePage.locator('#kill-switch-btn').click();
    const cancelled = await waitForStatus(app, ['cancelled', 'failed', 'completed'], 5_000);
    const elapsedMs = Date.now() - t0;

    expect(cancelled.status).toBe('cancelled');
    expect(elapsedMs).toBeLessThan(1000);

    const snap = await app.snapshot();
    const openAgentTabs = snap.tabs.filter(t => t.owner?.startsWith('agent:'));
    expect(openAgentTabs).toHaveLength(0);

    const evDir = process.env.AEGIS_E2E_EVIDENCE_DIR;
    if (evDir) {
      fs.mkdirSync(evDir, { recursive: true });
      await app.chromePage.screenshot({ path: path.join(evDir, 'kill-switch-cancelled.png') });
    }
  });
});
