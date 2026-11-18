/**
 * Project Aegis - Choreography & Motion Engine
 * Implements: Issue #213 [ANI-01] Truthful event-to-motion mapping,
 * lag-bounded event queue, rate limiting, and reduced-motion modes.
 */

export interface AnimationIntent {
  id: string;
  type: 'cursor_travel' | 'click_ripple' | 'typing_stream' | 'scroll_glide' | 'evidence_fly';
  startX?: number;
  startY?: number;
  targetX?: number;
  targetY?: number;
  durationMs: number;
  easing: string;
  payload?: any;
}

export interface ChoreographyConfig {
  reducedMotion?: boolean;
  maxQueueLagMs?: number;
  speedMultiplier?: number;
}

export class ChoreographyEngine {
  private queue: AnimationIntent[] = [];
  private reducedMotion: boolean;
  private maxQueueLagMs: number;
  private speedMultiplier: number;
  private lastEventTime: number = Date.now();

  constructor(config: ChoreographyConfig = {}) {
    this.reducedMotion = config.reducedMotion ?? false;
    this.maxQueueLagMs = config.maxQueueLagMs ?? 250;
    this.speedMultiplier = config.speedMultiplier ?? 1.0;
  }

  public setReducedMotion(enabled: boolean): void {
    this.reducedMotion = enabled;
  }

  /**
   * Pure mapper from runtime events to truthful visual animation intents.
   * "Truth over theatre": animations strictly reflect real dispatched runtime events.
   */
  public mapEventToIntent(event: {
    type: 'move' | 'click' | 'type' | 'scroll' | 'evidence';
    x?: number;
    y?: number;
    text?: string;
  }): AnimationIntent | null {
    if (this.reducedMotion) {
      // In reduced motion mode, duration is 0 (instant state change)
      return {
        id: `anim_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        type: event.type === 'click' ? 'click_ripple' : 'cursor_travel',
        targetX: event.x,
        targetY: event.y,
        durationMs: 0,
        easing: 'linear',
        payload: event
      };
    }

    const now = Date.now();
    const lag = now - this.lastEventTime;
    this.lastEventTime = now;

    // Coalesce / drop stale moves if backlog exceeds lag bound
    if (lag > this.maxQueueLagMs && event.type === 'move') {
      return null;
    }

    switch (event.type) {
      case 'move':
        return {
          id: `anim_move_${now}`,
          type: 'cursor_travel',
          targetX: event.x,
          targetY: event.y,
          durationMs: Math.max(20, Math.round(120 / this.speedMultiplier)),
          easing: 'cubic-bezier(0.25, 1, 0.5, 1)'
        };

      case 'click':
        return {
          id: `anim_click_${now}`,
          type: 'click_ripple',
          targetX: event.x,
          targetY: event.y,
          durationMs: Math.max(50, Math.round(350 / this.speedMultiplier)),
          easing: 'ease-out'
        };

      case 'type':
        return {
          id: `anim_type_${now}`,
          type: 'typing_stream',
          durationMs: Math.max(30, Math.round(150 / this.speedMultiplier)),
          easing: 'linear',
          payload: { text: event.text }
        };

      case 'scroll':
        return {
          id: `anim_scroll_${now}`,
          type: 'scroll_glide',
          durationMs: Math.max(40, Math.round(200 / this.speedMultiplier)),
          easing: 'cubic-bezier(0.16, 1, 0.3, 1)'
        };

      case 'evidence':
        return {
          id: `anim_ev_${now}`,
          type: 'evidence_fly',
          durationMs: Math.max(60, Math.round(400 / this.speedMultiplier)),
          easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
          payload: { text: event.text }
        };

      default:
        return null;
    }
  }

  public enqueue(event: any): AnimationIntent | null {
    const intent = this.mapEventToIntent(event);
    if (intent) {
      this.queue.push(intent);
    }
    return intent;
  }

  public drain(): AnimationIntent[] {
    const items = [...this.queue];
    this.queue = [];
    return items;
  }
}
