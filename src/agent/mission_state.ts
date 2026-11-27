/**
 * Mission state machine (#226, RUN-04). One instance per mission; every state change goes through `transition`.
 *
 *   idle -> planning -> running <-> paused | waiting_user | waiting_approval | takeover
 *                               -> completed | completed_unverified | failed | cancelled
 *
 * Illegal transitions throw in dev (`strict`) and are logged and ignored in production. Re-entering the current state
 * is a no-op (not illegal, not an event) so callers that report "still running" need no guard. A mission that reached a
 * terminal state is done: the runtime itself is "idle" again when it has no live mission (see AgentRuntime.isIdle).
 */

export type MissionState =
  | 'idle'
  | 'planning'
  | 'running'
  | 'paused'
  | 'waiting_user'
  | 'waiting_approval'
  | 'takeover'
  | 'completed'
  | 'completed_unverified'
  | 'failed'
  | 'cancelled';

export const ALL_STATES: readonly MissionState[] = [
  'idle', 'planning', 'running', 'paused', 'waiting_user', 'waiting_approval', 'takeover',
  'completed', 'completed_unverified', 'failed', 'cancelled'
];

export const TERMINAL_STATES: readonly MissionState[] = ['completed', 'completed_unverified', 'failed', 'cancelled'];

export const LEGAL_TRANSITIONS: Readonly<Record<MissionState, readonly MissionState[]>> = {
  idle: ['planning'],
  planning: ['running', 'failed', 'cancelled'],
  running: ['paused', 'waiting_user', 'waiting_approval', 'takeover', 'completed', 'completed_unverified', 'failed', 'cancelled'],
  paused: ['running', 'takeover', 'failed', 'cancelled'],
  waiting_user: ['running', 'failed', 'cancelled'],
  waiting_approval: ['running', 'failed', 'cancelled'],
  takeover: ['running', 'failed', 'cancelled'],
  completed: [],
  completed_unverified: [],
  failed: [],
  cancelled: []
};

export function isTerminal(state: MissionState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function isLegalTransition(from: MissionState, to: MissionState): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

/** One `mission:status` event: exactly one per transition. `seq` starts at 1 per mission and never repeats. */
export interface MissionStatusEvent {
  missionId?: string;
  state: MissionState;
  reason: string;
  ts: number;
  seq: number;
}

export class IllegalTransitionError extends Error {
  constructor(public readonly from: MissionState, public readonly to: MissionState, public readonly reason: string) {
    super(`Illegal mission state transition ${from} -> ${to} (${reason})`);
    this.name = 'IllegalTransitionError';
  }
}

export interface MissionStateMachineOptions {
  missionId?: string;
  /** true (dev/tests): illegal transitions throw. false (production): they are logged and ignored. */
  strict: boolean;
  initial?: MissionState;
  /** Called after the state changed, once per transition. */
  onTransition?: (event: MissionStatusEvent, from: MissionState) => void;
  /** Called for an ignored (production) illegal transition. */
  onIllegal?: (from: MissionState, to: MissionState, reason: string) => void;
  now?: () => number;
}

export class MissionStateMachine {
  private current: MissionState;
  private seq = 0;
  private lastTs = 0;

  constructor(private readonly opts: MissionStateMachineOptions) {
    this.current = opts.initial ?? 'idle';
  }

  public get state(): MissionState {
    return this.current;
  }

  public get terminal(): boolean {
    return isTerminal(this.current);
  }

  /** The number of events emitted so far (= seq of the last event). */
  public get eventCount(): number {
    return this.seq;
  }

  /** Moves to `next`. Returns true when the state changed; false for a same-state call or an ignored illegal one. */
  public transition(next: MissionState, reason: string): boolean {
    const from = this.current;
    if (next === from) return false;
    if (!isLegalTransition(from, next)) {
      if (this.opts.strict) throw new IllegalTransitionError(from, next, reason);
      this.opts.onIllegal?.(from, next, reason);
      return false;
    }
    this.current = next;
    const now = (this.opts.now ?? Date.now)();
    this.lastTs = Math.max(now, this.lastTs); // never goes backwards if the system clock does
    const event: MissionStatusEvent = { missionId: this.opts.missionId, state: next, reason, ts: this.lastTs, seq: ++this.seq };
    this.opts.onTransition?.(event, from);
    return true;
  }
}
