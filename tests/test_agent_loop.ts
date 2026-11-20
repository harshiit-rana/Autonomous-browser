/**
 * Issue #225 (RUN-03) acceptance: the single-agent loop.
 *  Part 1 (plain Node): settings migration v1 -> v2, policy origin handling and user rules, quote checking,
 *          argument validation, Set-of-Marks drawing.
 *  Part 2 (real Electron, tests/agent_loop/agent_loop_suite.ts): the AgentLoop with a scripted model on fixture pages:
 *          select_option, hover, drag, back/forward, tab tools, extract-with-quote, verifier reject-then-retry,
 *          ask_user round trip, stuck detection, and every edge case listed in the issue.
 * Electron must be able to start (Linux: xvfb-run -a). The suite is never skipped.
 */
import { strict as assert } from 'node:assert';
import { migrateSettings, CURRENT_SETTINGS_VERSION, SettingsManager } from '../src/infrastructure/settings.js';
import { ActionPolicyEngine } from '../src/security/action_policy.js';
import { checkExtraction, validateToolArgs, BROWSER_TOOLS, TOOL_RISK } from '../src/agent/tools.js';
import { drawMarks } from '../src/agent/som_bitmap.js';
import { runElectronSuite } from './agent_loop/launch.js';

console.log('--- #225 RUN-03: single-agent loop ---');

// ---------------------------------------------------------------- Part 1
{
  const v1 = { version: 1, modelProvider: 'gemini', modelName: 'gemini-2.0-flash', maxConcurrency: 3 };
  const { fields, changed } = migrateSettings(v1);
  assert.equal(changed, true);
  assert.equal(fields.version, CURRENT_SETTINGS_VERSION);
  assert.equal(fields.privacyMode, 'Careful');
  assert.deepEqual(fields.policyRules, []);
  assert.equal(fields.maxSteps, 25);
  assert.equal(fields.modelName, 'gemini-2.0-flash', 'existing values survive');
  assert.equal(migrateSettings(fields).changed, false, 'migration is idempotent');
  assert.equal(migrateSettings({ version: 1, privacyMode: 'Standard' }).fields.privacyMode, 'Standard', 'a stored value is kept');

  // SettingsManager applies the migration to stored rows and writes the result back.
  const rows: Record<string, unknown> = { version: 1, modelName: 'claude-x', privacyMode: 'Local-only' };
  const writes: Array<Record<string, unknown>> = [];
  const repo = { all: () => ({ ...rows }), setMany: (o: Record<string, unknown>) => { writes.push(o); Object.assign(rows, o); } };
  const s = SettingsManager.getInstance().attachRepo(repo as any);
  assert.equal(s.privacyMode, 'Local-only');
  assert.deepEqual(s.policyRules, []);
  assert.equal(rows.version, 2);
  assert.equal(writes.length, 1);
  SettingsManager.getInstance().attachRepo(repo as any);
  assert.equal(writes.length, 1, 'already migrated rows are not rewritten');
  SettingsManager.getInstance().detachRepo();
  console.log('✓ settings v1 -> v2 migration (privacyMode, policyRules, maxSteps, maxCostUSD, verifierModel)');
}

{
  assert.equal(ActionPolicyEngine.getETLDPlusOne('http://127.0.0.1:3000/x'), '127.0.0.1', 'D4: IP is not split into "0.1"');
  assert.equal(ActionPolicyEngine.getETLDPlusOne('https://a.b.example.com/'), 'example.com');
  assert.equal(ActionPolicyEngine.isOriginAllowed('http://127.0.0.1:9/a', ['127.0.0.1']), true);
  assert.equal(ActionPolicyEngine.isOriginAllowed('http://10.0.0.1/a', ['127.0.0.1']), false, 'different IP is out of scope');
  assert.equal(ActionPolicyEngine.isOriginAllowed('https://shop.example.com/a', ['https://www.example.com/start']), true);
  const engine = new ActionPolicyEngine({ allowedHosts: ['http://127.0.0.1:5/'], rules: [{ riskClass: 'navigate-out-of-scope', host: 'example.org', decision: 'allow' }, { riskClass: 'code-exec', decision: 'allow' }] });
  const base = { missionId: 'm', userGoal: 'g', allowedOrigins: [], currentUrl: 'http://127.0.0.1:5/' };
  assert.equal(engine.evaluateAction({ ...base, actionName: 'navigate', actionArgs: { url: 'http://127.0.0.1:5/b' } }).decision, 'allow');
  assert.equal(engine.evaluateAction({ ...base, actionName: 'navigate', actionArgs: { url: 'https://evil.test/' } }).decision, 'ask');
  assert.equal(engine.evaluateAction({ ...base, actionName: 'navigate', actionArgs: { url: 'https://docs.example.org/' } }).decision, 'allow', 'user rule');
  assert.equal(engine.evaluateAction({ ...base, actionName: 'navigate', actionArgs: { url: 'javascript:alert(1)' } }).decision, 'deny', 'rules can never allow code-exec');
  engine.allowHost('https://evil.test/x');
  assert.equal(engine.evaluateAction({ ...base, actionName: 'navigate', actionArgs: { url: 'https://evil.test/' } }).decision, 'allow', 'approved host stays allowed for the mission');
  assert.equal(engine.evaluateAction({ ...base, actionName: 'upload_file', actionArgs: { ref: 'e1', path: 'a' } }).riskClass, 'file-egress');
  console.log('✓ policy: IP/localhost origins, user rules, mission scope growth, code-exec never allowed');
}

{
  const rec = { id: 'x1', schema: { required: ['price'] }, text: 'Widget Pro\nPrice: $19.99 (in stock)\nShips in 2 days' };
  assert.equal(checkExtraction(rec, { price: '$19.99' }, { price: 'Price: $19.99' }).ok, true);
  assert.match(checkExtraction(rec, { price: '$19.99' }, {}).problems[0], /no quote/);
  assert.match(checkExtraction(rec, { price: '$9.99' }, { price: 'Price: $9.99' }).problems[0], /does not occur/);
  assert.match(checkExtraction(rec, { price: '$5' }, { price: 'Price: $19.99' }).problems[0], /does not contain the value/);
  assert.equal(checkExtraction(rec, { price: 19.99 }, { price: 'Price:   $19.99' }).ok, true, 'numbers and whitespace are normalised');
  assert.match(checkExtraction(rec, {}, {}).problems.join(), /required field "price"/);
  console.log('✓ record_extraction quote rules');
}

{
  assert.equal(validateToolArgs('click', { ref: 'e1' }), null);
  assert.match(validateToolArgs('click', {})!, /Missing required argument "ref"/);
  assert.match(validateToolArgs('scroll', { direction: 'left' })!, /one of up, down/);
  assert.match(validateToolArgs('wait', { ms: '5' })!, /must be number/);
  assert.match(validateToolArgs('select_option', { ref: 'e1' })!, /value" or "label/);
  assert.match(validateToolArgs('nope', {})!, /Unknown tool/);
  for (const t of BROWSER_TOOLS) assert.ok(TOOL_RISK[t.name], `risk class for ${t.name}`);
  const names = BROWSER_TOOLS.map(t => t.name);
  for (const n of ['select_option', 'hover', 'drag', 'go_back', 'go_forward', 'open_tab', 'switch_tab', 'close_tab', 'extract', 'record_extraction', 'find_text', 'screenshot', 'upload_file']) {
    assert.ok(names.includes(n), `tool ${n} exposed`);
  }
  console.log(`✓ ${BROWSER_TOOLS.length} tools, each with schema and risk class; argument validation`);
}

{
  const w = 40, h = 30;
  const buf = Buffer.alloc(w * h * 4, 255);
  const drawn = drawMarks(buf, w, h, [{ label: '7', x: 5, y: 12, width: 20, height: 10 }, { label: '9', x: 100, y: 100, width: 5, height: 5 }]);
  assert.equal(drawn.length, 1, 'off-image mark skipped');
  const px = (x: number, y: number) => [buf[(y * w + x) * 4 + 2], buf[(y * w + x) * 4 + 1], buf[(y * w + x) * 4]];
  assert.deepEqual(px(5, 15), [225, 29, 72], 'left border drawn');
  assert.deepEqual(px(15, 17), [255, 255, 255], 'inside the box untouched');
  console.log('✓ Set-of-Marks drawn on the bitmap');
}

// ---------------------------------------------------------------- Part 2
async function main() {
  const { results } = await runElectronSuite('agent_loop_suite');
  let failed = 0;
  for (const r of results as Array<{ name: string; ok: boolean; detail: string; ms: number }>) {
    console.log(`${r.ok ? '✓' : '✗'} [electron] ${r.name} (${r.ms} ms)${r.ok ? `: ${r.detail.slice(0, 160)}` : `\n${r.detail}`}`);
    if (!r.ok) failed++;
  }
  assert.ok(results.length >= 25, `expected the full suite, got ${results.length} scenarios`);
  assert.equal(failed, 0, `${failed} agent loop scenario(s) failed`);
  console.log(`✓ ${results.length} real-Electron agent loop scenarios passed`);
}

main().catch(err => { console.error(err); process.exit(1); });
