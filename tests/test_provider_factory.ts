import assert from 'node:assert';
import * as http from 'node:http';
import * as net from 'node:net';
import { ModelProviderFactory, ModelNotConfiguredError, resolveProviderId } from '../src/models/provider_factory.js';
import { SettingsManager, getSettings } from '../src/infrastructure/settings.js';
import { credentialVault } from '../src/infrastructure/credentials.js';
import { MODEL_NOT_CONFIGURED } from '../src/ipc/contract.js';
import { estimateStepCost } from '../src/models/pricing.js';
import { ollamaOpenAIBaseUrl, ollamaRootUrl } from '../src/models/ollama_url.js';
import { ScriptedModelProvider } from '../src/models/demo/scripted_provider.js';
import { parseTranscript, loadDemoTranscript, ReplayDemoSession, DEMO_BANNER_TEXT, DemoHost, ArenaLike } from '../src/models/demo/replay_player.js';

console.log('--- Testing Issue #224 (RUN-02): no silent mock, typed MODEL_NOT_CONFIGURED, labelled replay demo ---');

const ENV_KEYS = ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'AEGIS_E2E_MODEL_MODE', 'AEGIS_E2E_SCRIPT'];
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

function cleanSlate(): void {
  for (const k of ENV_KEYS) delete process.env[k];
  SettingsManager.getInstance().resetSettings();
}

function restoreEnv(): void {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}

async function rejection(p: Promise<unknown>): Promise<any> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  assert.fail('expected the promise to reject');
}

function listen(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as net.AddressInfo).port }));
  });
}

async function closedPort(): Promise<number> {
  const { server, port } = await listen(() => undefined);
  await new Promise(r => server.close(r));
  return port;
}

const chatCompletion = (content: string) => JSON.stringify({
  id: 'chatcmpl-test', object: 'chat.completion', created: 1, model: 'x',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
});

async function testNoKeysNeverScripted() {
  console.log('No keys: every provider throws MODEL_NOT_CONFIGURED and no scripted provider is ever returned...');
  for (const [provider, model] of [['gemini', 'gemini-2.0-flash'], ['anthropic', 'claude-3-7-sonnet-latest'], ['openai', 'gpt-4o']] as const) {
    cleanSlate();
    SettingsManager.getInstance().updateSettings({ modelProvider: provider });
    const err = await rejection(ModelProviderFactory.createProvider(model));
    assert.ok(err instanceof ModelNotConfiguredError, `${provider}: typed error`);
    assert.strictEqual(err.code, MODEL_NOT_CONFIGURED);
    assert.strictEqual(err.provider, provider);
    assert.ok(err.message.includes('Add an API key to run missions'), err.message);
  }

  // Unknown model name falls back to the saved provider, still no key -> still refused
  cleanSlate();
  SettingsManager.getInstance().updateSettings({ modelProvider: 'openai' });
  const unknown = await rejection(ModelProviderFactory.createProvider('my-finetune'));
  assert.strictEqual(unknown.provider, 'openai');

  // A stale demoMode value (old settings row, old caller) must not revive the mock path
  cleanSlate();
  SettingsManager.getInstance().updateSettings({ modelProvider: 'gemini', demoMode: true } as any);
  assert.ok(!('demoMode' in getSettings()), 'demoMode is not a setting any more');
  const stale = await rejection(ModelProviderFactory.createProvider('gemini-2.0-flash'));
  assert.strictEqual(stale.code, MODEL_NOT_CONFIGURED);

  // Whitespace-only keys are not keys
  cleanSlate();
  process.env.GEMINI_API_KEY = '   ';
  assert.strictEqual(ModelProviderFactory.inspect('gemini-2.0-flash').configured, false);
  console.log('✓ no keys -> typed error, never a scripted provider');
}

async function testWrongProviderSelected() {
  console.log('Key valid for one provider, a different provider selected...');
  cleanSlate();
  SettingsManager.getInstance().updateSettings({ modelProvider: 'openai', apiKeys: { gemini: 'AIza-test-gemini-key' } });
  const err = await rejection(ModelProviderFactory.createProvider('gpt-4o'));
  assert.strictEqual(err.code, MODEL_NOT_CONFIGURED);
  assert.strictEqual(err.provider, 'openai');
  assert.ok(err.message.includes('Google Gemini'), 'message tells the user which provider does have a key');

  // The model picker wins over the saved provider for a known cloud prefix
  cleanSlate();
  SettingsManager.getInstance().updateSettings({ modelProvider: 'gemini', apiKeys: { gemini: 'AIza-test-gemini-key' } });
  const claude = await rejection(ModelProviderFactory.createProvider('claude-3-7-sonnet-latest'));
  assert.strictEqual(claude.provider, 'anthropic');
  const ok = await ModelProviderFactory.createProvider('gemini-2.0-flash');
  assert.strictEqual(ok.providerName, 'gemini');
  assert.strictEqual(resolveProviderId({ modelProvider: 'anthropic' }, 'gemini-2.0-flash'), 'gemini');
  console.log('✓ wrong provider selected -> typed error naming the missing provider');
}

async function testEnvKeys() {
  console.log('Env var keys: accepted when present, and an invalid one fails with the provider error, not a mock...');
  cleanSlate();
  process.env.OPENAI_API_KEY = 'sk-env-key-but-invalid';
  assert.strictEqual(ModelProviderFactory.inspect('gpt-4o').configured, true, 'env key counts as configured');

  // The provider's endpoint says the key is invalid (401), the way OpenAI does
  let sawAuth = '';
  const { server, port } = await listen((req, res) => {
    sawAuth = String(req.headers.authorization);
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } }));
  });
  try {
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1`;
    const provider = await ModelProviderFactory.createProvider('gpt-4o');
    assert.strictEqual(provider.providerName, 'openai');
    const err = await rejection(provider.generate({ messages: [{ role: 'user', content: 'hi' }] }));
    assert.strictEqual(err.status, 401);
    assert.ok(/Incorrect API key/.test(err.message), err.message);
    assert.strictEqual(sawAuth, 'Bearer sk-env-key-but-invalid');

    // CREDENTIALS_TEST (the pre-first-mission validation) reports the same key as invalid
    const verdict = await credentialVault.testCredentials('openai', 'sk-env-key-but-invalid', `http://127.0.0.1:${port}/v1`);
    assert.strictEqual(verdict.valid, false);
    assert.ok(/Incorrect API key/.test(verdict.message), verdict.message);
  } finally {
    server.close();
  }
  console.log('✓ invalid env key surfaces the provider error and fails the credential test');
}

async function testOllama() {
  console.log('Ollama: URL normalisation, not running, model missing, and a working server that only speaks /v1...');
  assert.strictEqual(ollamaRootUrl('http://localhost:11434/'), 'http://localhost:11434');
  assert.strictEqual(ollamaRootUrl('http://localhost:11434/v1'), 'http://localhost:11434');
  assert.strictEqual(ollamaOpenAIBaseUrl('http://localhost:11434'), 'http://localhost:11434/v1');
  assert.strictEqual(ollamaOpenAIBaseUrl(undefined), 'http://localhost:11434/v1');

  // Not running: clear error with the base URL, at preflight and at the first model call
  cleanSlate();
  const dead = await closedPort();
  const deadUrl = `http://127.0.0.1:${dead}`;
  SettingsManager.getInstance().updateSettings({ modelProvider: 'ollama', ollamaBaseUrl: deadUrl });
  const check = await ModelProviderFactory.checkConfigured('deepseek-r1:8b');
  assert.strictEqual(check.configured, false);
  assert.ok(check.message?.includes(deadUrl), `preflight message names the base URL: ${check.message}`);
  const status = await ModelProviderFactory.describe('deepseek-r1:8b');
  assert.strictEqual(status.code, MODEL_NOT_CONFIGURED);
  assert.strictEqual(status.baseUrl, deadUrl);
  const provider = await ModelProviderFactory.createProvider('deepseek-r1:8b');
  const callErr = await rejection(provider.generate({ messages: [{ role: 'user', content: 'hi' }] }));
  assert.ok(callErr.message.includes(deadUrl) && callErr.message.includes('Cannot reach Ollama'), callErr.message);

  // Running, but it only serves /v1/chat/completions (the real Ollama layout) and has one model installed
  const paths: string[] = [];
  const { server, port } = await listen((req, res) => {
    paths.push(`${req.method} ${req.url}`);
    if (req.url === '/api/tags') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'deepseek-r1:8b' }] }));
    } else if (req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(chatCompletion('pong from stub ollama'));
    } else {
      res.writeHead(404);
      res.end('404 page not found');
    }
  });
  try {
    for (const url of [`http://127.0.0.1:${port}`, `http://127.0.0.1:${port}/v1/`]) {
      SettingsManager.getInstance().updateSettings({ modelProvider: 'ollama', ollamaBaseUrl: url });
      assert.strictEqual((await ModelProviderFactory.checkConfigured('deepseek-r1:8b')).configured, true);
      const ollama = await ModelProviderFactory.createProvider('deepseek-r1:8b');
      assert.strictEqual(ollama.providerName, 'ollama');
      const res = await ollama.generate({ messages: [{ role: 'user', content: 'hi' }] });
      assert.strictEqual(res.text, 'pong from stub ollama');
    }
    assert.ok(paths.includes('POST /v1/chat/completions'), `chat went to /v1: ${paths.join(', ')}`);
    assert.ok(!paths.includes('POST /chat/completions'), 'no un-prefixed chat request (the 404 from the baseline)');

    // Model the server does not have
    const missing = await ModelProviderFactory.checkConfigured('llama3:8b');
    assert.strictEqual(missing.configured, false);
    assert.ok(missing.message?.includes('ollama pull llama3:8b'), missing.message);

    // Credential probe accepts the bare and the /v1 form of the URL
    assert.strictEqual((await credentialVault.testCredentials('ollama', 'ollama', `http://127.0.0.1:${port}/v1`)).valid, true);
  } finally {
    server.close();
  }
  const probe = await credentialVault.testCredentials('ollama', 'ollama', deadUrl);
  assert.strictEqual(probe.valid, false);
  assert.ok(probe.message.includes(deadUrl), probe.message);
  console.log('✓ Ollama errors name the base URL; /v1 handled');
}

async function testScriptedOnlyBehindEnvGuard() {
  console.log('Scripted provider only behind AEGIS_E2E_MODEL_MODE...');
  cleanSlate();
  assert.strictEqual((await rejection(ModelProviderFactory.createProvider('gemini-2.0-flash'))).code, MODEL_NOT_CONFIGURED);

  process.env.AEGIS_E2E_MODEL_MODE = 'scripted';
  const p = await ModelProviderFactory.createProvider('gemini-2.0-flash');
  assert.strictEqual(p.providerName, 'scripted');
  // No script configured: it must fail, not invent a "Task complete"
  const err = await rejection(p.generate({ messages: [] }));
  assert.ok(/no more scripted responses/.test(err.message), err.message);
  delete process.env.AEGIS_E2E_MODEL_MODE;

  assert.strictEqual((await rejection(new ScriptedModelProvider().generate({ messages: [] }))).message.includes('recorded replay'), true);
  const usage = (await new ScriptedModelProvider([{ text: 'x' }]).generate({ messages: [] })).usage;
  assert.deepStrictEqual(usage, { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, 'a replay reports no token usage');
  console.log('✓ scripted provider unreachable without the explicit guard');
}

function testCostEstimate() {
  console.log('Per-step cost estimate...');
  const known = estimateStepCost('gpt-4o');
  assert.ok(known.costUSD !== null);
  assert.ok(Math.abs((known.costUSD as number) - (known.promptTokens * 2.5 + known.completionTokens * 10) / 1_000_000) < 1e-12);
  assert.strictEqual(estimateStepCost('some-unpriced-model').costUSD, null, 'no pricing data is reported, not guessed');
  assert.strictEqual(estimateStepCost('deepseek-r1:8b').costUSD, 0);
  console.log('✓ estimate uses the pricing table and refuses to guess');
}

async function testReplayDemo() {
  console.log('Replay demo: fixture validation and labelled, non-persistent playback...');
  const fixture = loadDemoTranscript();
  assert.strictEqual(fixture.fixture, true);
  assert.ok(/not recorded from a live model/i.test(fixture.label), 'the shipped transcript is labelled as a hand-written fixture');

  assert.throws(() => parseTranscript({ ...fixture, fixture: false }), /fixture/);
  assert.throws(() => parseTranscript({ ...fixture, label: '' }), /label/);
  assert.throws(() => parseTranscript({ ...fixture, steps: [{ text: 'no done call' }] }), /done/);
  assert.throws(() => parseTranscript({ ...fixture, steps: [{ toolCalls: [{ id: 1, name: 'done', arguments: {} }] }] }), /malformed/);

  const statuses: any[] = [];
  const evidence: any[] = [];
  const workers: any[] = [];
  const opened: string[] = [];
  let tabsClosed = 0;
  let arenaStopped = 0;
  const host: DemoHost = {
    openTab: u => { opened.push(u); },
    closeTab: () => { tabsClosed += 1; },
    emitStatus: p => { statuses.push(p); },
    emitEvidence: p => { evidence.push(p); },
    emitWorker: p => { workers.push(p); }
  };
  const arena: ArenaLike = { start: async () => 1234, stop: async () => { arenaStopped += 1; }, getBaseUrl: () => 'http://127.0.0.1:1234' };
  const session = new ReplayDemoSession(host, { stepDelayMs: 1, createArena: async () => arena });

  await session.start();
  assert.deepStrictEqual(opened, ['http://127.0.0.1:1234/shop']);
  await rejection(session.start()); // second start while playing
  for (let i = 0; i < 200 && session.isActive(); i++) await new Promise(r => setTimeout(r, 10));
  assert.strictEqual(session.isActive(), false);

  assert.ok(statuses.length >= 2 && statuses.every(s => s.source === 'demo'), 'every status event is tagged demo');
  const last = statuses[statuses.length - 1];
  assert.strictEqual(last.status, 'completed');
  assert.ok(last.message.startsWith(DEMO_BANNER_TEXT), 'the final result carries the banner text');
  assert.ok(last.message.includes('AMD Radeon RX 7900 XTX'));
  assert.ok(evidence.length > 3 && evidence.every(e => e.source === 'demo' && e.text.startsWith('[DEMO]')));
  assert.ok(evidence.some(e => /not executed/.test(e.text)), 'recorded actions are shown as not executed');
  assert.ok(workers.every(w => /DEMO/.test(w.name)));
  assert.strictEqual(arenaStopped, 0, 'the shop stays up so the user can look at the page');

  await session.stop();
  assert.strictEqual(arenaStopped, 1, 'stop releases the shop');
  assert.strictEqual(tabsClosed >= 1, true);

  // Stopping mid-playback reports cancelled and never completes
  statuses.length = 0;
  const slow = new ReplayDemoSession(host, { stepDelayMs: 5000, createArena: async () => arena });
  await slow.start();
  await slow.stop();
  assert.strictEqual(slow.isActive(), false);
  assert.ok(statuses.some(s => s.status === 'cancelled' && s.source === 'demo'));
  assert.ok(!statuses.some(s => s.status === 'completed'));
  console.log('✓ replay demo is labelled, tagged source:demo, and stoppable');
}

async function main() {
  try {
    await testNoKeysNeverScripted();
    await testWrongProviderSelected();
    await testEnvKeys();
    await testOllama();
    await testScriptedOnlyBehindEnvGuard();
    testCostEstimate();
    await testReplayDemo();
    console.log('\n✓ All provider factory / demo tests passed');
  } finally {
    restoreEnv();
    cleanSlate();
    restoreEnv();
  }
}

main().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
