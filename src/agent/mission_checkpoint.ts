/**
 * Persisted mission checkpoint (#226 step 6).
 *
 * One small JSON file per mission in the app data directory (`<userData>/missions/<id>/checkpoint.json`, never the
 * repository or the process cwd), rewritten atomically (temp file + rename) before and after every tool call. After a
 * kill or crash it is what lets the next launch OFFER to resume: it holds the goal, the last URL and the list of
 * actions already performed, not a replayable script. Resuming never re-runs a recorded action; it re-opens the URL,
 * takes a fresh observation and asks the model, which is told what already happened.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isTerminal, MissionState } from './mission_state.js';

export const CHECKPOINT_VERSION = 1;
/** Checkpoints older than this are not offered (the page the mission was on has long moved on). */
export const MAX_RESUME_AGE_MS = 7 * 24 * 3600 * 1000;
const MAX_ACTIONS = 60;

/** Tools that can change state on the server or in the account (so repeating them is not harmless). */
export const SIDE_EFFECT_TOOLS: ReadonlySet<string> = new Set(['click', 'type', 'press_key', 'select_option', 'drag', 'upload_file']);

export interface CheckpointAction {
  step: number;
  tool: string;
  /** Human-readable, with typed text reduced to its length (it may be a secret). */
  summary: string;
  sideEffect: boolean;
  /** `in_flight`: the app stopped before the tool reported back, so its effect is unknown. */
  phase: 'in_flight' | 'done';
  ok?: boolean;
  /** Page the action was taken on. */
  url?: string;
}

export interface MissionCheckpoint {
  version: number;
  missionId: string;
  prompt: string;
  model: string;
  state: MissionState;
  stepCount: number;
  url?: string;
  title?: string;
  savedAt: number;
  actions: CheckpointAction[];
  /** The last few things the agent said, truncated: the compacted history. */
  notes: string[];
  brief?: unknown;
  /** Set on a mission that was started from a checkpoint. */
  resumedFrom?: string;
}

export function summarizeAction(tool: string, args: Record<string, any>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args || {})) {
    if (tool === 'type' && k === 'text') parts.push(`text=<${String(v).length} chars>`);
    else if (typeof v === 'string') parts.push(`${k}=${JSON.stringify(v.length > 80 ? v.slice(0, 80) + '...' : v)}`);
    else if (typeof v === 'number' || typeof v === 'boolean') parts.push(`${k}=${v}`);
  }
  return `${tool}(${parts.join(', ')})`;
}

export function checkpointFile(userData: string, missionId: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(missionId)) throw new Error(`bad mission id: ${missionId}`);
  return path.join(userData, 'missions', missionId, 'checkpoint.json');
}

/** Atomic write: a reader (or a crash) sees either the previous complete file or the new one. */
export function writeCheckpoint(userData: string, cp: MissionCheckpoint): string {
  const file = checkpointFile(userData, cp.missionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body: MissionCheckpoint = { ...cp, version: CHECKPOINT_VERSION, actions: cp.actions.slice(-MAX_ACTIONS) };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(body));
  fs.renameSync(tmp, file);
  return file;
}

function validate(raw: any): MissionCheckpoint | null {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.version !== CHECKPOINT_VERSION) return null;
  if (typeof raw.missionId !== 'string' || typeof raw.prompt !== 'string' || typeof raw.model !== 'string') return null;
  if (typeof raw.savedAt !== 'number' || !Array.isArray(raw.actions) || !Array.isArray(raw.notes)) return null;
  return raw as MissionCheckpoint;
}

/** Null when absent, unreadable, truncated or of another version (a corrupt checkpoint must never block startup). */
export function readCheckpoint(userData: string, missionId: string): MissionCheckpoint | null {
  try {
    return validate(JSON.parse(fs.readFileSync(checkpointFile(userData, missionId), 'utf8')));
  } catch {
    return null;
  }
}

export function removeCheckpoint(userData: string, missionId: string): void {
  try { fs.rmSync(checkpointFile(userData, missionId), { force: true }); } catch { /* best effort */ }
}

/** Checkpoints of missions that never reached a terminal state, newest first. */
export function listInterrupted(userData: string, opts: { now?: number; exclude?: string } = {}): MissionCheckpoint[] {
  const now = opts.now ?? Date.now();
  const root = path.join(userData, 'missions');
  let ids: string[] = [];
  try { ids = fs.readdirSync(root); } catch { return []; }
  const out: MissionCheckpoint[] = [];
  for (const id of ids) {
    if (id === opts.exclude) continue;
    const cp = readCheckpoint(userData, id);
    if (!cp || isTerminal(cp.state) || cp.state === 'idle') continue;
    if (now - cp.savedAt > MAX_RESUME_AGE_MS) continue;
    out.push(cp);
  }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}

/** The text given to the model when a mission resumes. It states facts only; it replays nothing. */
export function buildResumeNote(cp: MissionCheckpoint): string {
  const done = cp.actions.filter(a => a.phase === 'done' && a.ok !== false);
  const inFlight = cp.actions.filter(a => a.phase === 'in_flight');
  const lines: string[] = [
    `[Resumed mission] This mission was interrupted (the app exited) after ${cp.stepCount} step(s) and is being continued. ` +
    `The browser was re-opened on ${cp.url || 'the last page'} and the page state below is current. Nothing from the earlier run was replayed.`
  ];
  const sideEffects = done.filter(a => a.sideEffect);
  if (sideEffects.length) {
    lines.push('Actions with side effects that were ALREADY performed (do NOT repeat them; check the page for their result):');
    for (const a of sideEffects) lines.push(`- step ${a.step}: ${a.summary}${a.url ? ` on ${a.url}` : ''}`);
  }
  const reads = done.filter(a => !a.sideEffect);
  if (reads.length) lines.push(`Earlier read-only/navigation steps: ${reads.slice(-8).map(a => a.summary).join('; ')}`);
  for (const a of inFlight) {
    lines.push(a.sideEffect
      ? `UNKNOWN OUTCOME: step ${a.step} ${a.summary}${a.url ? ` on ${a.url}` : ''} was running when the app exited. It may or may not have taken effect. Look at the page first; only repeat it if the page shows it did not happen.`
      : `Step ${a.step} ${a.summary} was running when the app exited (it has no side effects).`);
  }
  if (cp.notes.length) lines.push(`What the agent had said last: ${cp.notes.slice(-3).map(n => JSON.stringify(n)).join(' | ')}`);
  return lines.join('\n');
}
