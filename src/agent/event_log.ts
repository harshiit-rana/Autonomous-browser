/**
 * Project Aegis - Structured Mission EventLog (#235 [LIV-04])
 *
 * Single source of truth for mission & worker runtime events:
 * - Assigns monotonically increasing `seq` per mission
 * - Redacts secrets (SecretVault tokens, password inputs, sensitive keys, PII) and strips
 *   binary payloads BEFORE persistence or IPC forwarding
 * - Supports `since(seq)` resync after renderer reload
 */
import { MissionEvent, MissionEventKind, MISSION_EVENT_KINDS } from '../ipc/contract.js';
import { SecretVault } from '../security/secret_vault.js';
import type { PrivacyMode } from '../security/privacy_governor.js';

const VALID_KINDS = new Set<string>(MISSION_EVENT_KINDS);
const SENSITIVE_KEY_RE = /^(?:password|passwd|secret|token|apikey|api_key|authorization|cookie|privatekey|pin|otp|cvv)$/i;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const CARD_RE = /\b(?:\d[ -]*?){13,19}\b/g;

export interface EventLogOptions {
  privacyMode?: PrivacyMode;
  initialSeq?: number;
  maxBuffered?: number;
  persist?: (event: MissionEvent) => void;
  forward?: (event: MissionEvent) => void;
  now?: () => number;
}

/**
 * Recursively sanitizes event payload objects before persistence or IPC dispatch.
 * Never mutates the caller's object; strips binary buffers and masks secrets.
 */
export function sanitizeEventData(
  value: unknown,
  opts: { privacyMode?: PrivacyMode; parentKey?: string; toolName?: string; targetLabel?: string; depth?: number } = {}
): unknown {
  const depth = opts.depth ?? 0;
  if (depth > 8) return '[TRUNCATED_DEPTH]';
  if (value === null || value === undefined) return value;

  // Binary payload guard: never store raw binary buffers or large base64 images inside events
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
    return { binaryOmitted: true, byteLength: value.byteLength };
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return { binaryOmitted: true, byteLength: value.byteLength };
  }

  if (typeof value === 'string') {
    if (value.startsWith('data:image/') && value.length > 2048) {
      return { binaryOmitted: true, mimePrefix: value.slice(0, 32), charLength: value.length };
    }
    if (opts.parentKey && SENSITIVE_KEY_RE.test(opts.parentKey)) {
      return '[REDACTED]';
    }
    if (
      opts.parentKey === 'text' &&
      opts.toolName === 'type' &&
      opts.targetLabel &&
      /password|passcode|pin|secret|token|otp|cvv/i.test(opts.targetLabel)
    ) {
      return '[REDACTED_INPUT]';
    }
    if (value.includes('{{secret:')) {
      return value.replace(/\{\{secret:[^}]+\}\}/g, '[REDACTED_SECRET_REF]');
    }
    let out = SecretVault.maskHighEntropyTokens(value);
    if (opts.privacyMode && opts.privacyMode !== 'Standard') {
      out = out.replace(EMAIL_RE, '[REDACTED_EMAIL]').replace(CARD_RE, '[REDACTED_CARD]');
    }
    return out;
  }

  if (typeof value === 'number' || typeof value === 'boolean') return value;

  if (Array.isArray(value)) {
    return value.slice(0, 100).map(item => sanitizeEventData(item, { ...opts, depth: depth + 1 }));
  }

  if (typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    const toolName = typeof rec.tool === 'string' ? rec.tool : opts.toolName;
    const targetLabel = typeof rec.targetLabel === 'string' ? rec.targetLabel : opts.targetLabel;
    const isSecret = rec.isSecret === true;
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) {
      if (isSecret && k === 'text') {
        result[k] = '[REDACTED_INPUT]';
        continue;
      }
      result[k] = sanitizeEventData(v, {
        privacyMode: opts.privacyMode,
        parentKey: k,
        toolName,
        targetLabel,
        depth: depth + 1
      });
    }
    return result;
  }

  return String(value);
}

export class EventLog {
  private seq: number;
  private privacyMode: PrivacyMode;
  private readonly maxBuffered: number;
  private readonly persistFn?: (event: MissionEvent) => void;
  private readonly forwardFn?: (event: MissionEvent) => void;
  private readonly nowFn: () => number;
  private buffer: MissionEvent[] = [];

  constructor(private readonly missionId: string, opts: EventLogOptions = {}) {
    this.seq = Math.max(0, opts.initialSeq ?? 0);
    this.privacyMode = opts.privacyMode ?? 'Careful';
    this.maxBuffered = opts.maxBuffered ?? 20_000;
    this.persistFn = opts.persist;
    this.forwardFn = opts.forward;
    this.nowFn = opts.now ?? (() => Date.now());
  }

  public setPrivacyMode(mode: PrivacyMode): void {
    this.privacyMode = mode;
  }

  public currentSeq(): number {
    return this.seq;
  }

  public emit(
    kind: MissionEventKind | string,
    data: Record<string, unknown> = {},
    meta: { workerId?: string; stepId?: string; ts?: number } = {}
  ): MissionEvent {
    const normalizedKind: MissionEventKind = VALID_KINDS.has(kind) ? (kind as MissionEventKind) : 'status';
    this.seq += 1;
    const sanitized = sanitizeEventData(data, { privacyMode: this.privacyMode }) as Record<string, any>;
    const ev: MissionEvent = {
      seq: this.seq,
      ts: meta.ts ?? this.nowFn(),
      missionId: this.missionId,
      ...(meta.workerId ? { workerId: meta.workerId } : {}),
      kind: normalizedKind,
      ...(meta.stepId ? { stepId: meta.stepId } : {}),
      data: sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized) ? sanitized : { value: sanitized }
    };

    this.buffer.push(ev);
    if (this.buffer.length > this.maxBuffered) {
      this.buffer.shift();
    }

    try {
      this.persistFn?.(ev);
    } catch {
      // Persistence errors must never crash the agent runtime
    }
    try {
      this.forwardFn?.(ev);
    } catch {
      // Renderer forward errors must never crash the agent runtime
    }
    return ev;
  }

  public since(afterSeq: number): MissionEvent[] {
    return this.buffer.filter(e => e.seq > afterSeq);
  }

  public all(): MissionEvent[] {
    return [...this.buffer];
  }
}
