/**
 * Issue #226 step 3: cancelling must abort the model HTTP request. For every provider a local HTTP server accepts the
 * request and never answers; the mission's AbortSignal must end the call within a second, the connection must close, and
 * nothing may be sent again (no SDK retry, no governor retry). The governor cases check queue and back-off waits.
 */
import { strict as assert } from 'node:assert';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { AnthropicModelProvider } from '../src/models/anthropic_provider.js';
import { OpenAIModelProvider } from '../src/models/openai_provider.js';
import { GeminiModelProvider } from '../src/models/gemini_provider.js';
import { OllamaModelProvider } from '../src/models/ollama_provider.js';
import { ConcurrencyGovernor } from '../src/models/governor.js';
import type { IModelProvider, ModelRequest } from '../src/models/types.js';

console.log('--- #226 RUN-04: cancel aborts the model request (per provider) ---');

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const req = (signal: AbortSignal): ModelRequest => ({ messages: [{ role: 'user', content: 'hello' }], abortSignal: signal });

interface Hang { url: string; requests: () => number; closed: () => number; stop: () => Promise<void> }
async function startHangingServer(): Promise<Hang> {
  let count = 0, closed = 0;
  const server = http.createServer((r, _res) => {
    count++;
    r.on('close', () => { closed++; });
    r.resume(); // read the body, never answer
  });
  await new Promise<void>(res => server.listen(0, '127.0.0.1', res));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, requests: () => count, closed: () => closed, stop: () => new Promise(res => { server.closeAllConnections(); server.close(() => res()); }) };
}

async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

const providers: Array<[string, (url: string) => IModelProvider]> = [
  ['anthropic', url => new AnthropicModelProvider({ apiKey: 'k', baseURL: url, modelName: 'claude-test', enableThinking: false })],
  ['openai', url => new OpenAIModelProvider({ apiKey: 'k', baseURL: `${url}/v1`, modelName: 'gpt-test' })],
  ['gemini', url => new GeminiModelProvider({ apiKey: 'k', baseUrl: url, modelName: 'gemini-test' })],
  ['ollama', url => new OllamaModelProvider({ baseUrl: url, modelName: 'llama-test' })]
];

async function main() {
  for (const [name, make] of providers) {
    // Direct: provider.generate with the mission signal.
    {
      const hang = await startHangingServer();
      const ac = new AbortController();
      const p = make(hang.url).generate(req(ac.signal));
      const outcome = p.then(() => 'resolved', e => e as Error);
      await until(() => hang.requests() >= 1, 5000, `${name}: the request to reach the server`);
      const t0 = Date.now();
      ac.abort();
      const r = await Promise.race([outcome, sleep(1500).then(() => 'still pending')]);
      const took = Date.now() - t0;
      assert.notEqual(r, 'still pending', `${name}: generate() must settle after abort`);
      assert.notEqual(r, 'resolved', `${name}: generate() must reject after abort`);
      assert.ok(took < 1000, `${name}: settled ${took} ms after abort`);
      await until(() => hang.closed() >= 1, 1000, `${name}: the HTTP connection to close`);
      await sleep(1800); // longer than the SDKs' first retry back-off
      assert.equal(hang.requests(), 1, `${name}: nothing was sent again after the abort`);
      await hang.stop();
      console.log(`✓ ${name}: abort ends the in-flight request in ${took} ms, the socket closes, no resend`);
    }
    // Through the governor exactly as the runtime wires it (executeSafe): the abort must not be retried.
    {
      const hang = await startHangingServer();
      const gov = new ConcurrencyGovernor({ baseBackoffMs: 50, maxRetries: 3 });
      const ac = new AbortController();
      const outcome = gov.executeSafe(make(hang.url), req(ac.signal)).then(() => 'resolved', e => e as Error);
      await until(() => hang.requests() >= 1, 5000, `${name}: governed request to reach the server`);
      const t0 = Date.now();
      ac.abort();
      const r = await Promise.race([outcome, sleep(1500).then(() => 'still pending')]);
      assert.notEqual(r, 'still pending', `${name}: governed call must settle after abort`);
      assert.notEqual(r, 'resolved');
      assert.ok(Date.now() - t0 < 1000);
      await sleep(2500); // the governor's default retry delay for an unclassified error is ~1-1.5 s
      assert.equal(hang.requests(), 1, `${name}: the governor did not retry the cancelled call`);
      assert.equal(gov.getCircuitBreaker(make(hang.url).providerName).getStatus(), 'closed', `${name}: a cancel is not a provider failure`);
      await hang.stop();
      console.log(`✓ ${name}: governed call is not retried after cancel and does not trip the circuit breaker`);
    }
  }

  // Governor: a call waiting for a slot is dropped when its mission is cancelled, and never starts afterwards.
  {
    const gov = new ConcurrencyGovernor({ maxConcurrencyPerProvider: 1 });
    let release!: () => void;
    const blocker = gov.schedule('p', () => new Promise<string>(res => { release = () => res('blocker done'); }));
    const ac = new AbortController();
    let started = false;
    const queued = gov.schedule('p', async () => { started = true; return 'queued ran'; }, 10, ac.signal).then(() => 'ran', e => e as Error);
    await sleep(50);
    ac.abort();
    const r = await Promise.race([queued, sleep(500).then(() => 'still waiting')]);
    assert.ok(r instanceof Error && r.name === 'AbortError', `queued call rejects with AbortError, got ${String(r)}`);
    release();
    assert.equal(await blocker, 'blocker done');
    await sleep(50);
    assert.equal(started, false, 'the cancelled queued call never started');
    assert.equal(await gov.schedule('p', async () => 'next call fine'), 'next call fine', 'the slot was not leaked');
    console.log('✓ governor: a queued call is dropped on cancel and the slot is not leaked');
  }

  // Governor: cancel during the retry back-off ends the wait at once and does not call the provider again.
  {
    const gov = new ConcurrencyGovernor({ baseBackoffMs: 5000, maxBackoffMs: 5000 });
    const ac = new AbortController();
    let calls = 0;
    const out = gov.schedule('q', async () => { calls++; throw Object.assign(new Error('upstream 503'), { status: 503 }); }, 10, ac.signal).then(() => 'resolved', e => e as Error);
    await until(() => calls >= 1, 1000, 'first attempt');
    await sleep(100); // now inside the ~1.5 s back-off
    const t0 = Date.now();
    ac.abort();
    const r = await Promise.race([out, sleep(1000).then(() => 'still waiting')]);
    assert.ok(r instanceof Error && r.name === 'AbortError', `back-off wait ends with AbortError, got ${String(r)}`);
    assert.ok(Date.now() - t0 < 300, 'the back-off wait was cut short');
    await sleep(1800);
    assert.equal(calls, 1, 'no second attempt after cancel');
    assert.equal(await gov.schedule('q', async () => 'ok'), 'ok');
    console.log('✓ governor: cancel during back-off stops the wait and the retry');
  }

  // A genuine failure is still retried (the abort handling did not disable retries).
  {
    const gov = new ConcurrencyGovernor({ baseBackoffMs: 10, maxBackoffMs: 20 });
    let calls = 0;
    const v = await gov.schedule('r', async () => { calls++; if (calls < 3) throw Object.assign(new Error('upstream 503'), { status: 503, headers: { 'retry-after': '0.01' } }); return 'recovered'; });
    assert.equal(v, 'recovered');
    assert.equal(calls, 3);
    console.log('✓ governor: real errors are still retried');
  }
}

main().then(() => process.exit(0), err => { console.error(err); process.exit(1); });
