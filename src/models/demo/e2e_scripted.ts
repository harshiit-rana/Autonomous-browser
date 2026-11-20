import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { IModelProvider, ModelRequest, ModelResponse } from '../types.js';
import { ScriptedModelProvider, ScriptedStepResponse } from './scripted_provider.js';
import { UsageLedger } from '../pricing.js';
import { rootLogger } from '../../infrastructure/logger.js';

const logger = rootLogger.child('e2e-model');

/**
 * Deterministic model modes for the real-app e2e harness (#254). Reached only through
 * `ModelProviderFactory.createProvider` when `AEGIS_E2E_MODEL_MODE` is set, via a dynamic import, so none of this is on a
 * normal mission path.
 *
 *  - `scripted`: `AEGIS_E2E_SCRIPT=<json>` holds `[{ expectTools?, expectPageContains?, respond: {tool,args}|{text} }]`
 *    (the older `{ text?, toolCalls? }` step shape is also accepted). The provider fails the mission, and records a
 *    deviation the test fixture turns into a test failure, when the loop does anything the script did not expect.
 *  - `replay`: `AEGIS_E2E_REPLAY=<json>` holds request-hash -> response pairs recorded earlier. With `AEGIS_E2E_RECORD=1`
 *    a miss is answered by the real provider and appended to the file (needs a real key and the live cost cap).
 *  - `live`: the real provider, with `AEGIS_E2E_MAX_COST_USD` as a hard cap. Never run on PR CI.
 */
export type E2EModelMode = 'scripted' | 'replay' | 'live';

export interface E2EScriptStep {
  /** Tool names that must be offered to the model on this step. */
  expectTools?: string[];
  /** Substrings that must appear in the most recent page observation the loop sent. */
  expectPageContains?: string[];
  respond: { tool: string; args?: Record<string, any>; text?: string } | { text: string };
}

export interface E2EModelState {
  mode: E2EModelMode;
  scriptSteps: number;
  consumed: number;
  requests: number;
  costUSD: number;
  deviations: string[];
}

const STATE_KEY = '__AEGIS_E2E_MODEL__';

/** Read by the main-process e2e hooks; lives on globalThis so the hooks never import the provider classes. */
export function getE2EModelState(): E2EModelState | undefined {
  return (globalThis as any)[STATE_KEY];
}

function initState(mode: E2EModelMode, scriptSteps = 0): E2EModelState {
  const state: E2EModelState = { mode, scriptSteps, consumed: 0, requests: 0, costUSD: 0, deviations: [] };
  (globalThis as any)[STATE_KEY] = state;
  return state;
}

export class E2EDeviationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'E2EDeviationError';
  }
}

// ---------------------------------------------------------------------------------------------------- scripted

interface NormalizedStep {
  expectTools: string[];
  expectPageContains: string[];
  response: ScriptedStepResponse;
}

export function normalizeScript(raw: unknown): NormalizedStep[] {
  if (!Array.isArray(raw)) throw new Error('E2E script must be a JSON array of steps');
  let n = 0;
  return raw.map((s: any, i: number) => {
    if (!s || typeof s !== 'object') throw new Error(`E2E script step ${i + 1} is not an object`);
    const expectTools = Array.isArray(s.expectTools) ? s.expectTools.map(String) : [];
    const expectPageContains = Array.isArray(s.expectPageContains) ? s.expectPageContains.map(String) : [];
    let response: ScriptedStepResponse;
    if (s.respond) {
      const r = s.respond;
      if (typeof r.tool === 'string') {
        n += 1;
        response = { text: typeof r.text === 'string' ? r.text : undefined, toolCalls: [{ id: `e2e_call_${n}`, name: r.tool, arguments: r.args ?? {} }] };
      } else if (typeof r.text === 'string') {
        response = { text: r.text };
      } else {
        throw new Error(`E2E script step ${i + 1}: "respond" needs a "tool" or "text"`);
      }
    } else if (s.text !== undefined || s.toolCalls !== undefined) {
      response = { text: s.text, toolCalls: s.toolCalls };
    } else {
      throw new Error(`E2E script step ${i + 1} has neither "respond" nor "text"/"toolCalls"`);
    }
    return { expectTools, expectPageContains, response };
  });
}

/** The newest page observation the loop appended to the conversation ("[Page State ...]"), or '' when there is none. */
function latestObservation(request: ModelRequest): string {
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const m = request.messages[i];
    if (m.role === 'user' && typeof m.content === 'string' && m.content.includes('[Page State')) return m.content;
  }
  return '';
}

export class E2EScriptedProvider implements IModelProvider {
  public readonly providerName = 'scripted';
  public readonly modelName = 'scripted-model';
  private index = 0;
  private failure: E2EDeviationError | null = null;
  private readonly queue = new ScriptedModelProvider();

  constructor(private readonly steps: NormalizedStep[], private readonly state: E2EModelState) {}

  private deviate(message: string): never {
    const full = `E2E script deviation at model call ${this.index + 1}: ${message}`;
    this.failure = new E2EDeviationError(full);
    this.state.deviations.push(full);
    logger.error(full);
    throw this.failure;
  }

  public async generate(request: ModelRequest): Promise<ModelResponse> {
    this.state.requests += 1;
    if (this.failure) throw this.failure; // sticky: a retry after a deviation must not "recover" the script
    const step = this.steps[this.index];
    if (!step) this.deviate(`no more scripted responses (the script has ${this.steps.length} steps) but the loop asked for another model call`);

    const offered = (request.tools ?? []).map(t => t.name);
    for (const tool of step.expectTools) {
      if (!offered.includes(tool)) this.deviate(`expected tool "${tool}" to be offered, got [${offered.join(', ')}]`);
    }
    if (step.expectPageContains.length > 0) {
      const page = latestObservation(request);
      for (const needle of step.expectPageContains) {
        if (!page.includes(needle)) this.deviate(`expected the page observation to contain "${needle}", it was: ${page.slice(0, 400)}`);
      }
    }

    this.index += 1;
    this.state.consumed = this.index;
    this.queue.enqueueResponse(step.response);
    return this.queue.generate(request);
  }
}

// ---------------------------------------------------------------------------------------------------- replay

export interface ReplayEntry {
  hash: string;
  note?: string;
  response: Pick<ModelResponse, 'text' | 'toolCalls' | 'finishReason' | 'usage'>;
}
export interface ReplayFile {
  schema: 'aegis-e2e-replay/1';
  entries: ReplayEntry[];
}

/**
 * Stable hash of what the model was asked: system prompt, tool names and the whole conversation. Ephemeral values that
 * differ per run (loopback port, timestamps, mission ids) are normalised so a recording stays valid across runs.
 */
export function hashRequest(request: ModelRequest): string {
  const norm = (s: string) => s
    .replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:PORT')
    .replace(/localhost:\d+/g, 'localhost:PORT')
    .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, 'TIMESTAMP')
    .replace(/\bmission[-_][A-Za-z0-9-]+/g, 'MISSION_ID');
  const payload = norm(JSON.stringify({
    system: request.systemPrompt ?? '',
    tools: (request.tools ?? []).map(t => t.name),
    messages: request.messages
  }));
  return crypto.createHash('sha256').update(payload).digest('hex');
}

export class E2EReplayProvider implements IModelProvider {
  public readonly providerName = 'replay';
  public readonly modelName = 'replay-model';
  private failure: E2EDeviationError | null = null;

  constructor(
    private readonly file: string,
    private readonly state: E2EModelState,
    private readonly recorder?: IModelProvider
  ) {}

  private load(): ReplayFile {
    if (!fs.existsSync(this.file)) {
      if (this.recorder) return { schema: 'aegis-e2e-replay/1', entries: [] };
      throw new Error(`E2E replay file not found: ${this.file}`);
    }
    const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as ReplayFile;
    if (parsed.schema !== 'aegis-e2e-replay/1' || !Array.isArray(parsed.entries)) throw new Error(`Unsupported E2E replay file: ${this.file}`);
    return parsed;
  }

  public async generate(request: ModelRequest): Promise<ModelResponse> {
    this.state.requests += 1;
    if (this.failure) throw this.failure;
    const hash = hashRequest(request);
    const file = this.load();
    const hit = file.entries.find(e => e.hash === hash);
    if (hit) {
      this.state.consumed += 1;
      return { ...hit.response, usage: hit.response.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
    }
    if (!this.recorder) {
      const last = [...request.messages].reverse().find(m => m.role === 'user');
      const msg = `E2E replay: no recorded response for request ${hash.slice(0, 12)} (last user message: ${String(typeof last?.content === 'string' ? last.content : '').slice(0, 200)})`;
      this.failure = new E2EDeviationError(msg);
      this.state.deviations.push(msg);
      throw this.failure;
    }
    const live = await this.recorder.generate(request);
    file.entries.push({ hash, note: `recorded ${new Date().toISOString()} from ${this.recorder.providerName}/${this.recorder.modelName}`, response: { text: live.text, toolCalls: live.toolCalls, finishReason: live.finishReason, usage: live.usage } });
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(file, null, 2), 'utf8');
    this.state.consumed += 1;
    return live;
  }
}

// ---------------------------------------------------------------------------------------------------- live

/** Wraps a real provider with a hard USD cap: the call that crosses the cap fails, and so does every call after it. */
export class CostCappedProvider implements IModelProvider {
  public readonly providerName: string;
  public readonly modelName: string;
  private readonly ledger = new UsageLedger();

  constructor(private readonly inner: IModelProvider, private readonly maxCostUSD: number, private readonly state: E2EModelState) {
    this.providerName = inner.providerName;
    this.modelName = inner.modelName;
  }

  private check(): void {
    if (this.state.costUSD >= this.maxCostUSD) {
      const msg = `E2E live cost cap reached: $${this.state.costUSD.toFixed(4)} >= AEGIS_E2E_MAX_COST_USD=$${this.maxCostUSD}`;
      this.state.deviations.push(msg);
      throw new E2EDeviationError(msg);
    }
  }

  public async generate(request: ModelRequest): Promise<ModelResponse> {
    this.check();
    this.state.requests += 1;
    const response = await this.inner.generate(request);
    if (response.usage) {
      this.ledger.recordUsage(this.inner.modelName, response.usage.promptTokens, response.usage.completionTokens, response.usage.cacheReadTokens ?? 0);
      this.state.costUSD = this.ledger.getSummary().costTotal;
    }
    this.state.consumed += 1;
    return response;
  }
}

export function parseMaxCost(raw: string | undefined): number {
  const n = Number(raw);
  if (!raw || !Number.isFinite(n) || n <= 0) {
    throw new Error('AEGIS_E2E_MODEL_MODE=live (and replay recording) require AEGIS_E2E_MAX_COST_USD to be a positive number');
  }
  return n;
}

// ---------------------------------------------------------------------------------------------------- factory

export async function createE2EProvider(mode: string, makeLive: () => Promise<IModelProvider>): Promise<IModelProvider> {
  if (mode === 'scripted') {
    const scriptPath = process.env.AEGIS_E2E_SCRIPT;
    const steps = scriptPath ? normalizeScript(JSON.parse(fs.readFileSync(scriptPath, 'utf8'))) : [];
    logger.warn('AEGIS_E2E_MODEL_MODE=scripted: model output comes from a script, not a model', { scriptPath, steps: steps.length });
    return new E2EScriptedProvider(steps, initState('scripted', steps.length));
  }
  if (mode === 'replay') {
    const file = process.env.AEGIS_E2E_REPLAY;
    if (!file) throw new Error('AEGIS_E2E_MODEL_MODE=replay requires AEGIS_E2E_REPLAY=<recording json>');
    const state = initState('replay');
    if (process.env.AEGIS_E2E_RECORD === '1') {
      const cap = parseMaxCost(process.env.AEGIS_E2E_MAX_COST_USD);
      logger.warn('AEGIS_E2E_MODEL_MODE=replay with AEGIS_E2E_RECORD=1: misses call the real model', { file, capUSD: cap });
      return new E2EReplayProvider(file, state, new CostCappedProvider(await makeLive(), cap, state));
    }
    logger.warn('AEGIS_E2E_MODEL_MODE=replay: model output comes from a recording, not a model', { file });
    return new E2EReplayProvider(file, state);
  }
  if (mode === 'live') {
    const cap = parseMaxCost(process.env.AEGIS_E2E_MAX_COST_USD);
    logger.warn('AEGIS_E2E_MODEL_MODE=live: real model with a hard cost cap', { capUSD: cap });
    return new CostCappedProvider(await makeLive(), cap, initState('live'));
  }
  throw new Error(`Unsupported AEGIS_E2E_MODEL_MODE "${mode}" (expected scripted, replay or live)`);
}
