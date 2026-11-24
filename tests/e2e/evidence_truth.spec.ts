import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from './fixtures.js';
import { startMission, waitForStatus, screenshot } from './helpers.js';
import { SHOPS, PRODUCT, startShop, type ShopHandle } from './shop_fixtures.js';

/**
 * #230 acceptance, in the real app. Two shops quote different prices for the SAME entity (so the blackboard sees a conflict).
 * Only the model's answers are scripted. Shop Alpha's worker first "reads" a price that is not on its page: the real
 * `report_finding` must reject it and record nothing. Then both workers quote their real lines, the verifier stage is asked to
 * compare the two quotes, and (scripted) says the quotes do not settle it. The report must then
 *  - list both findings with their evidence ids, verified quotes and a computed strength (no constant, no 0.95),
 *  - list the conflict as not settled and needing the user, instead of picking a winner by confidence,
 *  - cite only URLs the workers visited, and the page text each quote was verified against must be stored with the mission.
 */
let shops: ShopHandle[] = [];
const two = () => shops.slice(0, 2);
test.beforeAll(async () => { shops = await Promise.all(SHOPS.slice(0, 2).map(startShop)); });
test.afterAll(async () => { await Promise.all(shops.map(s => s.stop())); });

test.describe('truthful evidence', () => {
  test.use({
    script: {
      build: () => {
        const [alpha, beta] = two();
        const finding = (shop: ShopHandle) => ({
          route: { goalContains: `Start page: ${shop.productUrl}` },
          expectTools: ['report_finding', 'finish_task'],
          expectPageContains: [shop.offerLine],
          respond: { tool: 'report_finding', args: { entity: PRODUCT, attribute: 'price', value: shop.priceText, quote: shop.offerLine, url: shop.productUrl } }
        });
        const finish = (shop: ShopHandle, prompt: string[] = []) => ({
          route: { goalContains: `Start page: ${shop.productUrl}` },
          expectPromptContains: prompt,
          respond: { tool: 'finish_task', args: { status: 'completed', summary: `${shop.name} lists ${PRODUCT} at ${shop.priceText}.` } }
        });
        return [
          // Alpha first invents a cheaper price (the quote is not on the page) ...
          {
            route: { goalContains: `Start page: ${alpha.productUrl}` },
            expectTools: ['report_finding', 'finish_task'],
            expectPageContains: [alpha.offerLine],
            respond: { tool: 'report_finding', args: { entity: PRODUCT, attribute: 'price', value: '$99.00', quote: `${PRODUCT}: $99.00 including tax`, url: alpha.productUrl } }
          },
          // ... then quotes the real line (the rejected attempt left no snapshot and no row: checked below)
          finding(alpha),
          finish(alpha),
          finding(beta),
          finish(beta),
          // the verifier stage reads both quotes and the page titles, and cannot settle it
          {
            route: { goalContains: 'Conflict about' },
            expectTools: ['resolve_conflict'],
            expectPromptContains: [alpha.offerLine, beta.offerLine, `${alpha.name} - ${PRODUCT}`, `${beta.name} - ${PRODUCT}`],
            respond: { tool: 'resolve_conflict', args: { verdict: 'needs_human', reason: 'two shops quote different prices and nothing says which one applies to you' } }
          }
        ];
      }
    },
    verifierScript: { build: () => [] }
  });

  test('a fabricated quote is rejected; the report shows computed strength, an open conflict and only visited sources', async ({ app }, testInfo) => {
    await startMission(app, `compare the price of ${PRODUCT} across ${two().map(s => s.productUrl).join(' ')}`);
    const end = await waitForStatus(app, ['completed', 'failed', 'cancelled'], 80_000);
    expect(end.status, end.message).toBe('completed');

    const dir = path.join(app.userDataDir, 'deliverables');
    const reports = fs.readdirSync(dir).filter(f => f.endsWith('_report.md'));
    expect(reports).toHaveLength(1);
    const report = fs.readFileSync(path.join(dir, reports[0]), 'utf8');
    const missionId = reports[0].replace(/_report\.md$/, '');

    // both real findings, each with an evidence id, the verified quote and a computed strength: 0.85 x 0.65 / (1 + 1 disagreeing)
    const rows = two().map(shop => report.split('\n').find(l => l.startsWith('|') && l.includes(shop.productUrl)));
    two().forEach((shop, i) => {
      expect(rows[i], `row of ${shop.name}`).toBeTruthy();
      expect(rows[i]).toMatch(/^\| ev_\w+ \|/);
      expect(rows[i]).toContain(`"${shop.offerLine}"`);
      expect(rows[i]).toContain(shop.priceText);
      expect(rows[i]).toContain('0.28 (primary; 1 independent source; 1 disagreeing)');
    });
    expect(report).not.toContain('$99.00'); // the rejected invention is nowhere
    expect(report).not.toMatch(/0\.95|0\.85\b|Confidence/);
    // the conflict is reported as open, with both claims and the verifier's reason: no winner was picked by confidence
    expect(report).toContain('## Conflicting Findings (not settled)');
    expect(report).toMatch(/needs your decision: two shops quote different prices/);
    expect(report).toContain('$129.00');
    expect(report).toContain('$119.50');
    expect(report).toContain('not a probability');
    expect(report).not.toContain('Report refused');

    // the page text each quote was verified against is stored with the mission, and so is the visited-URL log
    const evDir = path.join(app.userDataDir, 'missions', missionId, 'evidence');
    const snaps = fs.readdirSync(evDir).filter(f => f.endsWith('.txt'));
    expect(snaps).toHaveLength(2);
    const texts = snaps.map(f => fs.readFileSync(path.join(evDir, f), 'utf8'));
    for (const shop of two()) expect(texts.some(t => t.includes(shop.offerLine)), `snapshot of ${shop.name}`).toBe(true);
    const visited = fs.readFileSync(path.join(evDir, 'visited.jsonl'), 'utf8');
    for (const shop of two()) expect(visited).toContain(shop.productUrl);

    await screenshot(app, testInfo, 'evidence-truth-done');
    const evidenceDir = process.env.AEGIS_E2E_EVIDENCE_DIR; // set by hand to keep a copy of this run (docs/audits/evidence/230)
    if (evidenceDir) {
      fs.mkdirSync(evidenceDir, { recursive: true });
      await app.chromePage.screenshot({ path: path.join(evidenceDir, 'evidence-truth-done.png') });
      fs.writeFileSync(path.join(evidenceDir, 'report.md'), report);
      fs.writeFileSync(path.join(evidenceDir, 'snapshots.json'), JSON.stringify({ snapshots: snaps, visited: visited.trim().split('\n').map(l => JSON.parse(l).url) }, null, 2));
    }
  });
});
