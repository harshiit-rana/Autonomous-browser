/**
 * Project Aegis - Choreography, Motion Engine & Frame Budget Monitor
 * Implements: Issues #213 [ANI-01] & #234 [LIV-03]
 * - Pure event-to-animation-intent mapper with injectable clock
 * - Out-of-order sequence guard, rapid scroll/move coalescing, transform/opacity-only intents
 * - Motion modes ('full' | 'reduced' | 'off') and photosensitivity flash ceiling (< 3 Hz)
 * - FrameBudgetMonitor: samples rAF deltas and auto-degrades to 'reduced' if p95 > 20 ms for 3 s
 */

export type MotionMode = 'full' | 'reduced' | 'off';

export type AnimationIntentType =
  | 'cursor_travel'
  | 'click_ripple'
  | 'typing_stream'
  | 'scroll_glide'
  | 'evidence_fly'
  | 'worker_spawn'
  | 'worker_retire'
  | 'tile_transition'
  | 'approval_beacon'
  | 'error_shake'
  | 'completion_pulse';

export interface AnimationIntent {
  id: string;
  type: AnimationIntentType;
  workerId?: string;
  seq?: number;
  startX?: number;
  startY?: number;
  targetX?: number;
  targetY?: number;
  durationMs: number;
  easing: string;
  usesTransform: boolean;
  /** Minimum ms between flashes if periodic (>= 350 ms enforces < 3 Hz photosensitivity safety). */
  minPeriodMs?: number;
  payload?: any;
}

export interface MotionInputEvent {
  type:
    | 'move'
    | 'click'
    | 'type'
    | 'scroll'
    | 'evidence'
    | 'worker_spawn'
    | 'worker_retire'
    | 'tile_transition'
    | 'approval'
    | 'error'
    | 'complete';
  workerId?: string;
  seq?: number;
  x?: number;
  y?: number;
  text?: string;
  targetId?: string;
  coalescedCount?: number;
}

export interface ChoreographyConfig {
  reducedMotion?: boolean;
  motionMode?: MotionMode;
  maxQueueLagMs?: number;
  scrollCoalesceWindowMs?: number;
  speedMultiplier?: number;
  now?: () => number;
}

export const PHOTOSENSITIVITY_MIN_PERIOD_MS = 350; // < 3 flashes per second (max 2.85 Hz)

export class ChoreographyEngine {
  private queue: AnimationIntent[] = [];
  private reducedMotion: boolean;
  private motionMode: MotionMode;
  private maxQueueLagMs: number;
  private scrollCoalesceWindowMs: number;
  private speedMultiplier: number;
  private nowFn: () => number;
  private lastEventTime: number;
  private lastScrollTimeByWorker = new Map<string, number>();
  private lastSeqByStream = new Map<string, number>();

  constructor(config: ChoreographyConfig = {}) {
    this.reducedMotion = config.reducedMotion ?? false;
    this.motionMode = config.motionMode ?? (this.reducedMotion ? 'off' : 'full');
    this.maxQueueLagMs = config.maxQueueLagMs ?? 250;
    this.scrollCoalesceWindowMs = config.scrollCoalesceWindowMs ?? 120;
    this.speedMultiplier = config.speedMultiplier ?? 1.0;
    this.nowFn = config.now ?? (() => Date.now());
    this.lastEventTime = this.nowFn();
  }

  public setReducedMotion(enabled: boolean): void {
    this.reducedMotion = enabled;
    this.motionMode = enabled ? 'off' : 'full';
  }

  public setMotionMode(mode: MotionMode): void {
    this.motionMode = mode;
    this.reducedMotion = mode === 'off';
  }

  public getMotionMode(): MotionMode {
    return this.motionMode;
  }

  public setSpeedMultiplier(mult: number): void {
    if (Number.isFinite(mult) && mult > 0) this.speedMultiplier = mult;
  }

  /**
   * Pure mapper from runtime events to truthful visual animation intents.
   * "Truth over theatre": animations strictly reflect real dispatched runtime events.
   */
  public mapEventToIntent(event: MotionInputEvent): AnimationIntent | null {
    const streamKey = event.workerId ?? '__global__';
    if (typeof event.seq === 'number') {
      const prev = this.lastSeqByStream.get(streamKey);
      if (prev !== undefined && event.seq <= prev) {
        return null; // Drop out-of-order / duplicate sequence numbers
      }
      this.lastSeqByStream.set(streamKey, event.seq);
    }

    const now = this.nowFn();

    // Coalesce high-rate scroll bursts into one glide inside the window
    if (event.type === 'scroll') {
      const prevScroll = this.lastScrollTimeByWorker.get(streamKey) ?? -Infinity;
      if (now - prevScroll < this.scrollCoalesceWindowMs) {
        return null;
      }
      this.lastScrollTimeByWorker.set(streamKey, now);
    }

    const mappedType: AnimationIntentType | null = (() => {
      switch (event.type) {
        case 'move': return 'cursor_travel';
        case 'click': return 'click_ripple';
        case 'type': return 'typing_stream';
        case 'scroll': return 'scroll_glide';
        case 'evidence': return 'evidence_fly';
        case 'worker_spawn': return 'worker_spawn';
        case 'worker_retire': return 'worker_retire';
        case 'tile_transition': return 'tile_transition';
        case 'approval': return 'approval_beacon';
        case 'error': return 'error_shake';
        case 'complete': return 'completion_pulse';
        default: return null;
      }
    })();
    if (!mappedType) return null;

    if (this.reducedMotion || this.motionMode === 'off') {
      return {
        id: `anim_${mappedType}_${Math.round(now)}`,
        type: mappedType,
        workerId: event.workerId,
        seq: event.seq,
        targetX: event.x,
        targetY: event.y,
        durationMs: 0,
        easing: 'linear',
        usesTransform: false,
        payload: event
      };
    }

    if (this.motionMode === 'reduced') {
      // Reduced mode: short opacity-only fades; zero transform motion
      return {
        id: `anim_fade_${mappedType}_${Math.round(now)}`,
        type: mappedType,
        workerId: event.workerId,
        seq: event.seq,
        targetX: event.x,
        targetY: event.y,
        durationMs: 90,
        easing: 'linear',
        usesTransform: false,
        minPeriodMs: mappedType === 'approval_beacon' ? Math.max(800, PHOTOSENSITIVITY_MIN_PERIOD_MS) : undefined,
        payload: event
      };
    }

    const lag = now - this.lastEventTime;
    this.lastEventTime = now;

    // Drop stale intermediate pointer moves if queue falls behind
    if (lag > this.maxQueueLagMs && event.type === 'move') {
      return null;
    }

    const scaled = (baseMs: number, floorMs: number) => Math.max(floorMs, Math.round(baseMs / this.speedMultiplier));

    switch (event.type) {
      case 'move':
        return {
          id: `anim_move_${Math.round(now)}`,
          type: 'cursor_travel',
          workerId: event.workerId,
          seq: event.seq,
          targetX: event.x,
          targetY: event.y,
          durationMs: scaled(120, 20),
          easing: 'cubic-bezier(0.25, 1, 0.5, 1)',
          usesTransform: true
        };
      case 'click':
        return {
          id: `anim_click_${Math.round(now)}`,
          type: 'click_ripple',
          workerId: event.workerId,
          seq: event.seq,
          targetX: event.x,
          targetY: event.y,
          durationMs: scaled(350, 50),
          easing: 'ease-out',
          usesTransform: true
        };
      case 'type':
        return {
          id: `anim_type_${Math.round(now)}`,
          type: 'typing_stream',
          workerId: event.workerId,
          seq: event.seq,
          durationMs: scaled(150, 30),
          easing: 'linear',
          usesTransform: false,
          payload: { text: event.text }
        };
      case 'scroll':
        return {
          id: `anim_scroll_${Math.round(now)}`,
          type: 'scroll_glide',
          workerId: event.workerId,
          seq: event.seq,
          durationMs: scaled(200, 40),
          easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
          usesTransform: true
        };
      case 'evidence':
        return {
          id: `anim_ev_${Math.round(now)}`,
          type: 'evidence_fly',
          workerId: event.workerId,
          seq: event.seq,
          durationMs: scaled(360, 60),
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
          usesTransform: true,
          payload: { text: event.text }
        };
      case 'worker_spawn':
        return {
          id: `anim_spawn_${Math.round(now)}`,
          type: 'worker_spawn',
          workerId: event.workerId,
          seq: event.seq,
          durationMs: scaled(220, 40),
          easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
          usesTransform: true
        };
      case 'worker_retire':
        return {
          id: `anim_retire_${Math.round(now)}`,
          type: 'worker_retire',
          workerId: event.workerId,
          seq: event.seq,
          durationMs: scaled(180, 40),
          easing: 'ease-out',
          usesTransform: true
        };
      case 'tile_transition':
        return {
          id: `anim_tile_${Math.round(now)}`,
          type: 'tile_transition',
          workerId: event.workerId,
          seq: event.seq,
          durationMs: scaled(200, 40),
          easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
          usesTransform: true,
          payload: { targetId: event.targetId }
        };
      case 'approval':
        return {
          id: `anim_approval_${Math.round(now)}`,
          type: 'approval_beacon',
          workerId: event.workerId,
          seq: event.seq,
          durationMs: 900,
          minPeriodMs: 900, // 1.11 Hz, safely below 3 Hz photosensitivity ceiling
          easing: 'ease-in-out',
          usesTransform: false,
          payload: { text: event.text }
        };
      case 'error':
        return {
          id: `anim_err_${Math.round(now)}`,
          type: 'error_shake',
          workerId: event.workerId,
          seq: event.seq,
          durationMs: scaled(280, 80),
          minPeriodMs: PHOTOSENSITIVITY_MIN_PERIOD_MS,
          easing: 'ease-in-out',
          usesTransform: true,
          payload: { text: event.text }
        };
      case 'complete':
        return {
          id: `anim_done_${Math.round(now)}`,
          type: 'completion_pulse',
          workerId: event.workerId,
          seq: event.seq,
          durationMs: scaled(320, 60),
          minPeriodMs: PHOTOSENSITIVITY_MIN_PERIOD_MS,
          easing: 'ease-out',
          usesTransform: false
        };
      default:
        return null;
    }
  }

  public enqueue(event: MotionInputEvent): AnimationIntent | null {
    const intent = this.mapEventToIntent(event);
    if (intent) {
      this.queue.push(intent);
      if (this.queue.length > 256) {
        this.queue.shift();
      }
    }
    return intent;
  }

  public drain(): AnimationIntent[] {
    const items = [...this.queue];
    this.queue = [];
    return items;
  }
}

export interface FrameBudgetSample {
  p95Ms: number;
  sampleCount: number;
  degraded: boolean;
}

/**
 * Tracks rAF frame deltas and degrades motion to `'reduced'` if p95 exceeds `budgetMs` (default 20 ms)
 * continuously for `sustainMs` (default 3000 ms).
 */
export class FrameBudgetMonitor {
  private readonly budgetMs: number;
  private readonly sustainMs: number;
  private readonly windowSize: number;
  private deltas: number[] = [];
  private overBudgetSince: number | null = null;
  private degraded = false;

  constructor(opts: { budgetMs?: number; sustainMs?: number; windowSize?: number } = {}) {
    this.budgetMs = opts.budgetMs ?? 20;
    this.sustainMs = opts.sustainMs ?? 3000;
    this.windowSize = opts.windowSize ?? 120;
  }

  public recordFrame(deltaMs: number, atMs: number): FrameBudgetSample {
    if (!Number.isFinite(deltaMs) || deltaMs < 0) return this.snapshot();
    this.deltas.push(deltaMs);
    if (this.deltas.length > this.windowSize) this.deltas.shift();

    const p95Ms = this.computeP95();
    if (this.deltas.length >= 10 && p95Ms > this.budgetMs) {
      if (this.overBudgetSince === null) this.overBudgetSince = atMs;
      if (atMs - this.overBudgetSince >= this.sustainMs) {
        this.degraded = true;
      }
    } else if (p95Ms <= this.budgetMs) {
      this.overBudgetSince = null;
    }
    return { p95Ms, sampleCount: this.deltas.length, degraded: this.degraded };
  }

  private computeP95(): number {
    if (this.deltas.length === 0) return 0;
    const sorted = [...this.deltas].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
    return Number(sorted[idx].toFixed(2));
  }

  public snapshot(): FrameBudgetSample {
    return {
      p95Ms: this.computeP95(),
      sampleCount: this.deltas.length,
      degraded: this.degraded
    };
  }

  public reset(): void {
    this.deltas = [];
    this.overBudgetSince = null;
    this.degraded = false;
  }
}
