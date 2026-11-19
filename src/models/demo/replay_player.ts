/**
 * "Replay demo" (issue #224, RUN-02): plays a recorded transcript from `fixtures/demo/*.json` back into the UI.
 *
 * What it is: a labelled slideshow. It opens the bundled local test shop in a tab and shows the transcript's steps in
 * the activity feed, every event tagged `source: "demo"` so the renderer shows the DEMO banner.
 * What it is not: an agent. No model runs, no recorded action is executed in the page, and nothing is persisted:
 * it never touches MissionRecorder (SQLite), the deliverables folder or the memory store, so demo output cannot be mistaken
 * for, or saved as, a user's result.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ScriptedModelProvider, ScriptedStepResponse } from './scripted_provider.js';
import type { EvidenceEventPayload, MissionStatusPayload, WorkerEventPayload } from '../../ipc/contract.js';

export const DEMO_BANNER_TEXT = 'DEMO - recorded session, no AI model is running';
const DEMO_WORKER_ID = 'worker-demo-replay';

export interface DemoTranscript {
  schema: 'aegis-demo-transcript/1';
  fixture: true;
  label: string;
  goal: string;
  startPath: string;
  steps: ScriptedStepResponse[];
}

/** Validates a parsed transcript. Throws with the reason, so a malformed fixture fails loudly instead of replaying garbage. */
export function parseTranscript(raw: unknown): DemoTranscript {
  const t = raw as Partial<DemoTranscript> | null;
  if (!t || typeof t !== 'object') throw new Error('Demo transcript is not an object');
  if (t.schema !== 'aegis-demo-transcript/1') throw new Error(`Unsupported demo transcript schema: ${String(t.schema)}`);
  if (t.fixture !== true) throw new Error('Demo transcript must be marked "fixture": true');
  if (typeof t.label !== 'string' || !t.label.trim()) throw new Error('Demo transcript needs a "label" saying where it came from');
  if (typeof t.goal !== 'string' || !t.goal.trim()) throw new Error('Demo transcript needs a "goal"');
  if (typeof t.startPath !== 'string' || !t.startPath.startsWith('/')) throw new Error('Demo transcript "startPath" must be a path starting with "/"');
  if (!Array.isArray(t.steps) || t.steps.length === 0) throw new Error('Demo transcript needs at least one step');
  for (const [i, step] of t.steps.entries()) {
    for (const tc of step.toolCalls ?? []) {
      if (!tc || typeof tc.id !== 'string' || typeof tc.name !== 'string' || typeof tc.arguments !== 'object' || tc.arguments === null) {
        throw new Error(`Demo transcript step ${i + 1} has a malformed tool call`);
      }
    }
  }
  const last = t.steps[t.steps.length - 1];
  if (!(last.toolCalls ?? []).some(tc => tc.name === 'done')) throw new Error('Demo transcript must end with a "done" tool call');
  return t as DemoTranscript;
}

/** Directories searched for `fixtures/demo`: next to compiled output (packaged build) and the repo root (dev, tests). */
function candidateFixtureDirs(): string[] {
  return [
    path.resolve(__dirname, '../../fixtures/demo'),
    path.resolve(__dirname, '../../../fixtures/demo')
  ];
}

export function loadDemoTranscript(dir?: string): DemoTranscript {
  const dirs = dir ? [dir] : candidateFixtureDirs();
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    const files = fs.readdirSync(d).filter(f => f.endsWith('.json')).sort();
    if (files.length === 0) continue;
    return parseTranscript(JSON.parse(fs.readFileSync(path.join(d, files[0]), 'utf8')));
  }
  throw new Error(`No demo transcript found (looked in ${dirs.join(', ')})`);
}

/** What the player needs from the app; Electron-free so the player is testable. */
export interface DemoHost {
  openTab(url: string): void;
  closeTab(): void;
  emitStatus(payload: MissionStatusPayload): void;
  emitEvidence(payload: EvidenceEventPayload): void;
  emitWorker(payload: WorkerEventPayload): void;
}

export interface ArenaLike {
  start(port?: number): Promise<number>;
  stop(): Promise<void>;
  getBaseUrl(): string;
}

export interface ReplayOptions {
  transcriptDir?: string;
  stepDelayMs?: number;
  createArena?: () => Promise<ArenaLike>;
}

async function defaultArena(): Promise<ArenaLike> {
  const { WebArenaServer } = await import('../../testing/arena_server.js');
  return new WebArenaServer();
}

export class ReplayDemoSession {
  private active = false;
  private cancelled = false;
  private arena: ArenaLike | null = null;
  private timer: NodeJS.Timeout | null = null;
  private wake: (() => void) | null = null;

  constructor(private readonly host: DemoHost, private readonly options: ReplayOptions = {}) {}

  public isActive(): boolean {
    return this.active;
  }

  /** Loads the transcript, opens the local shop and starts playing in the background. Rejects on a malformed fixture. */
  public async start(): Promise<{ goal: string }> {
    if (this.active) throw new Error('A replay demo is already playing');
    await this.cleanup(); // release the shop and tab of a finished earlier replay
    const transcript = loadDemoTranscript(this.options.transcriptDir);
    this.active = true;
    this.cancelled = false;
    try {
      this.arena = await (this.options.createArena ?? defaultArena)();
      await this.arena.start(0);
      this.host.openTab(`${this.arena.getBaseUrl()}${transcript.startPath}`);
    } catch (err) {
      await this.cleanup();
      throw err;
    }
    void this.play(transcript).catch(err => {
      this.host.emitStatus({ status: 'failed', message: `${DEMO_BANNER_TEXT}: replay failed: ${err?.message || err}`, source: 'demo' });
      return this.cleanup();
    });
    return { goal: transcript.goal };
  }

  /** Stops a playing replay, or releases the shop and tab a finished one left open for the user to look at. */
  public async stop(): Promise<void> {
    if (this.active) {
      this.cancelled = true;
      this.wake?.();
      this.host.emitStatus({ status: 'cancelled', message: `${DEMO_BANNER_TEXT}: replay stopped`, source: 'demo' });
    }
    await this.cleanup();
  }

  private ev(text: string): void {
    this.host.emitEvidence({ text: `[DEMO] ${text}`, timestamp: new Date().toTimeString().slice(0, 8), source: 'demo' });
  }

  private pause(ms: number): Promise<void> {
    return new Promise(resolve => {
      this.wake = resolve;
      this.timer = setTimeout(resolve, ms);
    });
  }

  private async play(transcript: DemoTranscript): Promise<void> {
    const delay = this.options.stepDelayMs ?? 1200;
    const provider = new ScriptedModelProvider(transcript.steps);
    const worker = (progress: number, status: WorkerEventPayload['status'], task: string) =>
      this.host.emitWorker({ id: DEMO_WORKER_ID, name: 'Replay [DEMO]', task, progress, status });

    this.host.emitStatus({ status: 'running', message: `${DEMO_BANNER_TEXT}. Goal: "${transcript.goal}"`, source: 'demo' });
    this.ev(DEMO_BANNER_TEXT);
    this.ev(transcript.label);
    this.ev(`Goal: ${transcript.goal}`);
    worker(5, 'running', 'Replaying recorded transcript');

    let finalResult: string | undefined;
    let n = 0;
    while (provider.remaining > 0 && !this.cancelled) {
      await this.pause(delay);
      if (this.cancelled) return;
      const step = await provider.generate({ messages: [] });
      n += 1;
      if (step.text) this.ev(`Step ${n}: ${step.text}`);
      for (const tc of step.toolCalls) {
        if (tc.name === 'done') {
          finalResult = String(tc.arguments.result ?? '');
          const evidence: unknown[] = Array.isArray(tc.arguments.evidence) ? tc.arguments.evidence : [];
          for (const e of evidence) this.ev(`Recorded evidence: ${String(e)}`);
        } else {
          this.ev(`Recorded action (not executed): ${tc.name} ${JSON.stringify(tc.arguments)}`);
        }
      }
      worker(Math.min(95, Math.round((n / transcript.steps.length) * 100)), 'running', `Replaying step ${n}/${transcript.steps.length}`);
    }
    if (this.cancelled) return;

    const message = `${DEMO_BANNER_TEXT}. Recorded result: ${finalResult ?? '(none)'}`;
    this.host.emitStatus({ status: 'completed', message, source: 'demo' });
    this.ev(`Replay finished. ${message}`);
    worker(100, 'done', 'Replay finished');
    this.active = false; // the shop tab stays open to look at until stop() or the next start()
  }

  private async cleanup(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.wake = null;
    const arena = this.arena;
    this.arena = null;
    this.active = false;
    try { this.host.closeTab(); } catch { /* tab already gone */ }
    try { await arena?.stop(); } catch { /* already stopped */ }
  }
}
