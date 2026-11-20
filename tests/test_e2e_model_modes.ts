/**
 * Unit tests for the real-app e2e model modes (#254): scripted deviations, replay by request hash with recording, and the
 * live cost cap. The Electron-level behaviour is covered by tests/e2e/*.spec.ts; this pins the provider logic itself.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createE2EProvider, createE2EScriptedVerifier, getE2EModelState, hashRequest, normalizeScript, E2EDeviationError } from '../src/models/demo/e2e_scripted.js';
import type { IModelProvider, ModelRequest, ModelResponse } from '../src/models/types.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-e2e-modes-'));
const write = (name: string, data: unknown) => { const f = path.join(tmp, name); fs.writeFileSync(f, JSON.stringify(data)); return f; };
const TOOLS = [
  { name: 'click', description: '', parameters: { type: 'object' as const, properties: {} } },
  { name: 'done', description: '', parameters: { type: 'object' as const, properties: {} } }
];
const req = (page: string, tools = TOOLS): ModelRequest => ({ messages: [{ role: 'user', content: `[Page State - Isolated Data Channel]\n${page}` }], tools });
const ENV_KEYS = ['AEGIS_E2E_SCRIPT', 'AEGIS_E2E_REPLAY', 'AEGIS_E2E_RECORD', 'AEGIS_E2E_MAX_COST_USD', 'AEGIS_E2E_VERIFIER_SCRIPT'];
const reset = () => { for (const k of ENV_KEYS) delete process.env[k]; delete (globalThis as any).__AEGIS_E2E_MODEL__; };
const noLive = async (): Promise<IModelProvider> => { throw new Error('the live provider must not be built'); };

async function scripted() {
  reset();
  assert.throws(() => normalizeScript({}), /array/);
  assert.throws(() => normalizeScript([{ nothing: true }]), /neither/);

  process.env.AEGIS_E2E_SCRIPT = write('s.json', [
    { expectTools: ['click'], expectPageContains: ['Hello'], respond: { tool: 'click', args: { ref: 'e1' } } },
    { respond: { tool: 'done', args: { result: 'ok' } } }
  ]);
  const p = await createE2EProvider('scripted', noLive);
  const r1 = await p.generate(req('Hello world'));
  assert.equal(r1.toolCalls[0].name, 'click');
  assert.deepEqual(r1.toolCalls[0].arguments, { ref: 'e1' });
  assert.equal(r1.usage?.totalTokens, 0, 'a script uses no tokens');
  const r2 = await p.generate(req('anything'));
  assert.equal(r2.toolCalls[0].name, 'done');
  assert.deepEqual(getE2EModelState()?.roles.actor, { scriptSteps: 2, consumed: 2 });
  await assert.rejects(() => p.generate(req('x')), /no more scripted responses/);
  await assert.rejects(() => p.generate(req('x')), (e: Error) => e instanceof E2EDeviationError);
  assert.equal(getE2EModelState()?.deviations.length, 1, 'a sticky failure is recorded once');
  console.log('ok scripted: plays, counts, deviates when exhausted');

  reset();
  process.env.AEGIS_E2E_SCRIPT = write('s2.json', [{ expectPageContains: ['NEEDLE'], respond: { tool: 'done', args: {} } }]);
  const q = await createE2EProvider('scripted', noLive);
  await assert.rejects(() => q.generate(req('haystack')), /expected the page observation to contain "NEEDLE"/);
  assert.equal(getE2EModelState()?.roles.actor.consumed, 0, 'a deviating step is not consumed');
  await assert.rejects(() => q.generate(req('NEEDLE')), E2EDeviationError); // no recovery after a deviation
  console.log('ok scripted: wrong page observation is a sticky deviation');

  reset();
  process.env.AEGIS_E2E_SCRIPT = write('s3.json', [{ expectTools: ['scroll'], respond: { tool: 'done', args: {} } }]);
  const t = await createE2EProvider('scripted', noLive);
  await assert.rejects(() => t.generate(req('p')), /expected tool "scroll" to be offered/);
  console.log('ok scripted: a missing tool is a deviation');

  reset();
  process.env.AEGIS_E2E_SCRIPT = write('s4.json', [{ respond: { tool: 'done', args: {} } }]);
  process.env.AEGIS_E2E_VERIFIER_SCRIPT = write('v.json', [
    { expectPromptContains: ['Proposed answer: 42'], respond: { tool: 'report_verdict', args: { pass: true, reasons: [] } } }
  ]);
  const actor = await createE2EProvider('scripted', noLive);
  const verifier = createE2EScriptedVerifier();
  await actor.generate(req('p'));
  await assert.rejects(() => verifier.generate({ messages: [{ role: 'user', content: 'Proposed answer: 41' }] }), /expected the prompt to contain/);
  const roles = getE2EModelState()!.roles;
  assert.deepEqual([roles.actor.consumed, roles.verifier.consumed], [1, 0], 'actor and verifier are tracked separately');
  console.log('ok scripted: separate verifier queue with prompt expectations');
}

async function replay() {
  reset();
  const file = path.join(tmp, 'rec.json');
  process.env.AEGIS_E2E_REPLAY = file;
  const calls: ModelRequest[] = [];
  const live: IModelProvider = {
    providerName: 'live-fake',
    modelName: 'gpt-4o',
    async generate(r): Promise<ModelResponse> {
      calls.push(r);
      return { text: 'seen', toolCalls: [{ id: 'c1', name: 'done', arguments: { result: 'recorded' } }], finishReason: 'tool_calls', usage: { promptTokens: 1000, completionTokens: 100, totalTokens: 1100 } };
    }
  };

  // The hash ignores per-run noise (port, timestamp) but not content or tools.
  assert.equal(hashRequest(req('URL http://127.0.0.1:1111/a at 2026-01-01T00:00:00.000Z')), hashRequest(req('URL http://127.0.0.1:2222/a at 2027-05-05T10:10:10.000Z')));
  assert.notEqual(hashRequest(req('page A')), hashRequest(req('page B')));
  assert.notEqual(hashRequest(req('page A')), hashRequest(req('page A', [TOOLS[0]])));

  // Replay without a recording fails; it never answers silently.
  fs.rmSync(file, { force: true });
  const missing = await createE2EProvider('replay', async () => live);
  await assert.rejects(() => missing.generate(req('page A')), /replay file not found/);

  // Record needs a cost cap; misses go to the live provider and are written.
  reset();
  process.env.AEGIS_E2E_REPLAY = file;
  process.env.AEGIS_E2E_RECORD = '1';
  await assert.rejects(() => createE2EProvider('replay', async () => live), /AEGIS_E2E_MAX_COST_USD/);
  process.env.AEGIS_E2E_MAX_COST_USD = '1';
  const rec = await createE2EProvider('replay', async () => live);
  const first = await rec.generate(req('page A'));
  assert.equal(first.toolCalls[0].arguments.result, 'recorded');
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).entries.length, 1);

  // Replay: the same request is served from the file without a live call; a new request is a deviation.
  reset();
  process.env.AEGIS_E2E_REPLAY = file;
  const player = await createE2EProvider('replay', noLive);
  const again = await player.generate(req('page A'));
  assert.equal(again.toolCalls[0].arguments.result, 'recorded');
  assert.equal(calls.length, 1, 'replay did not call the live provider');
  await assert.rejects(() => player.generate(req('page B')), /no recorded response for request/);
  assert.equal(getE2EModelState()?.deviations.length, 1);
  console.log('ok replay: hash, record, play back, a miss is a deviation');
}

async function live() {
  reset();
  const fake: IModelProvider = {
    providerName: 'live-fake',
    modelName: 'gpt-4o',
    async generate(): Promise<ModelResponse> {
      return { text: '', toolCalls: [], finishReason: 'stop', usage: { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 } };
    }
  };
  await assert.rejects(() => createE2EProvider('live', async () => fake), /AEGIS_E2E_MAX_COST_USD/);
  process.env.AEGIS_E2E_MAX_COST_USD = '1';
  const p = await createE2EProvider('live', async () => fake);
  await p.generate(req('p')); // one 1M-token call costs more than $1 at gpt-4o prices
  assert.ok(getE2EModelState()!.costUSD > 1, `cost ${getE2EModelState()!.costUSD}`);
  await assert.rejects(() => p.generate(req('p')), /cost cap reached/);
  const second = await createE2EProvider('live', async () => fake); // e.g. the verifier: same ledger, same cap
  await assert.rejects(() => second.generate(req('p')), /cost cap reached/);
  await assert.rejects(() => createE2EProvider('bogus', async () => fake), /Unsupported AEGIS_E2E_MODEL_MODE/);
  console.log('ok live: hard cost cap shared across providers');
}

(async () => {
  await scripted();
  await replay();
  await live();
  reset();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('E2E MODEL MODES TESTS PASSED');
})().catch(err => { console.error('FAILED', err); process.exit(1); });
