/**
 * Real-App E2E (#235 [LIV-04]): during a 3-worker fixture mission, the virtualised timeline
 * (`role="log"`) shows >= 1 step card per worker with distinct worker colours, worker filtering
 * hides the others, and clicking a card opens the Event Inspector drawer.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from './fixtures';
import { waitForStatus } from './helpers.js';
import { SHOPS, PRODUCT, startShop, type ShopHandle } from './shop_fixtures.js';

const EVIDENCE_DIR = path.join(process.cwd(), 'docs', 'audits', 'evidence', '235');

let shops: ShopHandle[] = [];
test.beforeAll(async () => { shops = await Promise.all(SHOPS.map(startShop)); });
test.afterAll(async () => { await Promise.all(shops.map(s => s.stop())); });

test.describe('Structured timeline & inspector (#235)', () => {
  test.use({
    orchestratorScript: {
      build: () => [
        {
          expectTools: ['submit_plan'],
          respond: {
            tool: 'submit_plan',
            args: {
              mode: 'swarm',
              justification: 'Three parallel shops for timeline E2E',
              stages: [
                {
                  name: 'extract',
                  parallelism: 3,
                  tasks: shops.map((shop, i) => ({
                    id: `shop_${i + 1}`,
                    name: `${shop.name} extractor`,
                    role: 'extractor',
                    goal: `Find price and quote for ${PRODUCT} on ${shop.name}.`,
                    startUrl: shop.productUrl,
                    dependsOn: [],
                    effectClass: 'read'
                  }))
                }
              ]
            }
          }
        }
      ]
    },
    script: {
      build: () => shops.flatMap(shop => [
        {
          route: { goalContains: `Start page: ${shop.productUrl}` },
          expectTools: ['report_finding', 'finish_task'],
          respond: {
            tool: 'report_finding',
            args: { entity: `${PRODUCT} at ${shop.name}`, attribute: 'price', value: shop.priceText, quote: shop.offerLine, url: shop.productUrl }
          }
        },
        {
          route: { goalContains: `Start page: ${shop.productUrl}` },
          respond: { tool: 'finish_task', args: { status: 'completed', summary: `${shop.name} lists ${PRODUCT} at ${shop.priceText}.` } }
        }
      ])
    },
    verifierScript: { build: () => [] }
  });

  test('renders distinct worker step cards, filters by worker chip, and opens inspector drawer', async ({ app }) => {
    const feed = app.chromePage.locator('#evidence-feed');
    await expect(feed).toHaveAttribute('role', 'log');

    await app.chromePage.locator('#omnibar-input').fill(`compare ${PRODUCT} across ${shops.map(s => s.productUrl).join(' ')}`);
    await app.chromePage.locator('#swarm-run-btn').click();
    await expect(app.chromePage.locator('#plan-preview-modal')).not.toHaveClass(/hidden/, { timeout: 10_000 });
    await app.chromePage.locator('#execute-plan-btn').click();

    const end = await waitForStatus(app, ['completed', 'failed', 'cancelled'], 60_000);
    expect(end.status, end.message).toBe('completed');

    // Wait for >= 3 distinct worker cards in #evidence-feed
    await expect.poll(async () => {
      return app.chromePage.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('#evidence-feed .tl-card')) as HTMLElement[];
        const workerIds = new Set(cards.map(c => c.dataset.workerId).filter(id => id && id !== 'mission'));
        const colors = new Set(cards.map(c => c.style.borderLeftColor).filter(Boolean));
        return { cardCount: cards.length, workerCount: workerIds.size, colorCount: colors.size };
      });
    }, { timeout: 25_000 }).toMatchObject({
      workerCount: 3
    });

    const stats = await app.chromePage.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('#evidence-feed .tl-card')) as HTMLElement[];
      const workerColors = new Map<string, string>();
      for (const c of cards) {
        const wid = c.dataset.workerId;
        if (wid && wid !== 'mission' && !workerColors.has(wid)) {
          workerColors.set(wid, c.style.borderLeftColor);
        }
      }
      return {
        distinctWorkers: workerColors.size,
        distinctColors: new Set(workerColors.values()).size
      };
    });
    expect(stats.distinctWorkers).toBe(3);
    expect(stats.distinctColors).toBe(3);

    // Filter to one worker chip -> only that worker's cards remain visible
    const workerChips = app.chromePage.locator('#timeline-worker-filters .filter-chip[data-worker-filter]:not([data-worker-filter="all"])');
    await expect(workerChips).toHaveCount(3);
    const chosenId = await workerChips.first().getAttribute('data-worker-filter');
    await workerChips.first().click();

    await expect.poll(async () => {
      return app.chromePage.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('#evidence-feed .tl-card')) as HTMLElement[];
        return Array.from(new Set(cards.map(c => c.dataset.workerId)));
      });
    }, { timeout: 5_000 }).toEqual([chosenId]);

    // Click card -> Inspector drawer opens with raw JSON
    await app.chromePage.locator('#evidence-feed .tl-card').first().click();
    await expect(app.chromePage.locator('#timeline-inspector')).not.toHaveClass(/hidden/);
    await expect(app.chromePage.locator('#timeline-inspector-body pre')).toBeVisible();

    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    await app.chromePage.screenshot({ path: path.join(EVIDENCE_DIR, 'timeline_worker_filter.png') });
  });
});
