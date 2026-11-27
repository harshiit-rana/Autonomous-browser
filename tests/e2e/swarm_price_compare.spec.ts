import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from './fixtures.js';
import { startMission, waitForStatus, screenshot } from './helpers.js';
import { SHOPS, PRODUCT, startShop, pageHtml, type ShopHandle } from './shop_fixtures.js';

/**
 * #227 acceptance, in the real app: "compare the price of product X across the shops" starts three model-driven workers.
 * Only the model's answers are scripted (one routed step list per worker); everything else is the product: the planner
 * splits the mission by source, the scheduler hands one source to each worker, every worker runs the real AgentLoop on its
 * own view, reads its real page, and `report_finding` posts to the blackboard only when the quote is on that page.
 */
let shops: ShopHandle[] = [];
test.beforeAll(async () => { shops = await Promise.all(SHOPS.map(startShop)); });
test.afterAll(async () => { await Promise.all(shops.map(s => s.stop())); });

test.describe('swarm price-compare', () => {
  test.use({
    orchestratorScript: {
      build: () => [{
        expectTools: ['submit_plan'],
        respond: {
          tool: 'submit_plan',
          args: {
            mode: 'swarm',
            justification: 'Three distinct shop URLs benefit from parallel extraction across isolated worker views.',
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
      }]
    },
    script: {
      // Each worker has its own two steps, tied to the page it starts on (the "Start page:" line of its goal).
      build: () => shops.flatMap(shop => [
        {
          route: { goalContains: `Start page: ${shop.productUrl}` },
          expectTools: ['report_finding', 'finish_task'],
          expectPageContains: [shop.offerLine, shop.name],
          respond: {
            tool: 'report_finding',
            args: { entity: `${PRODUCT} at ${shop.name}`, attribute: 'price', value: shop.priceText, quote: shop.offerLine, url: shop.productUrl }
          }
        },
        {
          route: { goalContains: `Start page: ${shop.productUrl}` },
          expectPageContains: [shop.offerLine],
          respond: { tool: 'finish_task', args: { status: 'completed', summary: `${shop.name} lists ${PRODUCT} at ${shop.priceText}.` } }
        }
      ])
    },
    // No verifier script: with no conflicting findings the verifier stage must not call a model at all.
    verifierScript: { build: () => [] }
  });

  test('three workers read three shops at the same time and the report lists the three prices with their quotes', async ({ app }, testInfo) => {
    const before = await app.snapshot();
    const userTabUrls = before.tabs.map(t => t.url);

    await startMission(app, `compare the price of ${PRODUCT} across ${shops.map(s => s.productUrl).join(' ')}`);
    // ---- while the swarm runs: real workers on their own views (three web contents, three sessions, none of them the user's tab)
    const urls = shops.map(s => s.productUrl);
    const readViews = () => app.electronApp.evaluate(({ webContents, session }, urls) => {
      const all = webContents.getAllWebContents();
      const sessions = [...new Set(all.map(w => w.session))];
      return urls.map(u => {
        const wc = all.find(w => w.getURL() === u);
        return { url: u, found: Boolean(wc), sessionIndex: wc ? sessions.indexOf(wc.session) : -1, isDefaultSession: wc ? wc.session === session.defaultSession : null };
      });
    }, urls);
    let views = await readViews();
    const deadline = Date.now() + 40_000;
    while (!views.every(v => v.found) && Date.now() < deadline) { await new Promise(r => setTimeout(r, 100)); views = await readViews(); }
    expect(views.every(v => v.found), JSON.stringify(views)).toBe(true);
    expect(new Set(views.map(v => v.sessionIndex)).size, 'three separate session partitions').toBe(3);
    expect(views.every(v => v.isDefaultSession === false)).toBe(true);
    const mid = await app.snapshot();
    const evidenceDir = process.env.AEGIS_E2E_EVIDENCE_DIR; // set by hand to keep a copy of this run (docs/audits/evidence/227)
    if (evidenceDir) {
      fs.mkdirSync(evidenceDir, { recursive: true });
      await app.chromePage.screenshot({ path: path.join(evidenceDir, 'swarm-workers-running.png') });
      await app.chromePage.locator('button', { hasText: /^Grid$/ }).first().click({ timeout: 2000 }).catch(() => undefined);
      await app.chromePage.waitForTimeout(400);
      await app.chromePage.screenshot({ path: path.join(evidenceDir, 'swarm-grid-running.png') });
    }
    expect(mid.tabs.map(t => t.url), "the user's tabs were not touched while the workers ran").toEqual(userTabUrls);
    expect(mid.activeTabId).toBe(before.activeTabId);

    const end = await waitForStatus(app, ['completed', 'failed', 'cancelled'], 80_000);
    expect(end.status, end.message).toBe('completed');
    const hitsDuringMission = shops.map(s => s.hits().length); // before this test fetches the pages itself

    // ---- the report: three correct prices, each with a quote that is really on that shop's page
    const dir = path.join(app.userDataDir, 'deliverables');
    const reports = fs.readdirSync(dir).filter(f => f.endsWith('_report.md'));
    expect(reports).toHaveLength(1);
    const report = fs.readFileSync(path.join(dir, reports[0]), 'utf8');
    for (const shop of shops) {
      const row = report.split('\n').find(l => l.startsWith('|') && l.includes(`${PRODUCT} at ${shop.name}`));
      expect(row, `report row for ${shop.name}`).toBeTruthy();
      expect(row).toContain(shop.priceText);
      expect(row).toContain(shop.productUrl);
      // The quote in the report occurs in the HTML the shop really serves (fetched here, independently of the app).
      const quote = (row!.match(/"([^"]+)"/) || [])[1];
      expect(quote, `quote in the row of ${shop.name}`).toBe(shop.offerLine);
      const served = await (await fetch(shop.productUrl)).text();
      expect(served).toContain(quote);
      expect(served).toBe(pageHtml(shop)); // the shop is the fixture, not something the test made up for the app
    }
    // No other shop's price leaks into a row: three distinct prices, three rows.
    expect(new Set(shops.map(s => s.priceText)).size).toBe(3);

    // ---- concurrency, measured from the shops' side: each page kept beating while open, and the three spans overlap
    const spans = shops.map(s => { const b = s.beats(); return { shop: s.key, start: Math.min(...b), end: Math.max(...b), n: b.length }; });
    for (const s of spans) expect(s.n, `${s.shop} page stayed open and beating`).toBeGreaterThan(1);
    const latestStart = Math.max(...spans.map(s => s.start));
    const earliestEnd = Math.min(...spans.map(s => s.end));
    expect(latestStart, `all three pages were open at once: ${JSON.stringify(spans)}`).toBeLessThan(earliestEnd);
    shops.forEach((s, i) => expect(hitsDuringMission[i], `${s.key} was requested once, by its own worker`).toBe(1));

    // ---- the product's own per-worker events: three workers, with a step and a last action
    const after = await app.snapshot();
    const workers = Object.values(after.workers).filter(w => w.workerId);
    expect(workers).toHaveLength(3);
    for (const w of workers) {
      expect(w.step, JSON.stringify(w)).toBeGreaterThanOrEqual(2);
      expect(w.lastAction).toMatch(/^finish_task/);
      expect(w.status).toBe('done');
    }
    expect(new Set(workers.map(w => w.name)).size).toBe(3);

    await screenshot(app, testInfo, 'swarm-price-compare-done');
    if (evidenceDir) {
      await app.chromePage.screenshot({ path: path.join(evidenceDir, 'swarm-done.png') });
      fs.writeFileSync(path.join(evidenceDir, 'report.md'), report);
      fs.writeFileSync(path.join(evidenceDir, 'run.json'), JSON.stringify({ views, beatSpans: spans, hitsDuringMission, workers, statusHistory: after.statusHistory.map(s => s.status), model: after.model, evidenceLines: after.evidence.filter(e => /Blackboard|Action|Observing|Swarm/.test(e)).slice(0, 60) }, null, 2));
    }
  });
});
