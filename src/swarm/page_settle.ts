/**
 * Project Aegis - Real page-settle logic for swarm workers.
 *
 * Issue #229 [SWX-03] step 5: replaces the fixed 600 ms sleep in WorkerHost with
 *   1. the page has finished loading (`webContents.isLoading()` is false),
 *   2. network idle: no request of this tab in flight for `networkQuietMs`
 *      (measured with `session.webRequest` on the worker's own session, so nothing else pollutes it),
 *   3. DOM stable: `VisualSettleDetector` (MutationObserver quiet window + no running CSS animations),
 * all under one hard `maxMs` deadline. The result states honestly whether the page settled or the deadline hit.
 */

import type { Session, WebContents } from 'electron';
import { VisualSettleDetector } from '../perception/settle_detector.js';

export interface SettleResult {
  settled: boolean;
  reason: 'quiescent' | 'deadline';
  waitedMs: number;
  inFlightAtEnd: number;
}

export interface SettleOptions {
  maxMs?: number;
  networkQuietMs?: number;
  domQuietMs?: number;
}

/** What the settle logic needs from a tracker (also lets tests drive it without Electron). */
export interface NetworkActivity {
  inFlight(webContentsId: number): number;
  msSinceLastActivity(webContentsId: number): number;
}

/** Request kinds that stay open by design and must not block "network idle". */
const LONG_LIVED = new Set(['webSocket', 'eventSource', 'ping', 'cspReport']);
/** A request older than this is treated as hung and ignored for idleness (the deadline still bounds the wait). */
const STALE_REQUEST_MS = 20000;

export class NetworkActivityTracker implements NetworkActivity {
  private static byProvider = new WeakMap<Session, NetworkActivityTracker>();

  private pending = new Map<number, Map<number, number>>(); // webContentsId -> (requestId -> startedAt)
  private lastActivity = new Map<number, number>();
  private refs = 0;

  private constructor(private readonly sess: Session) {
    const note = (d: { id: number; webContentsId?: number }, start: boolean, resourceType?: string) => {
      const wcId = d.webContentsId;
      if (wcId === undefined || wcId === null) return;
      if (start && resourceType && LONG_LIVED.has(resourceType)) return;
      let m = this.pending.get(wcId);
      if (!m) { m = new Map(); this.pending.set(wcId, m); }
      if (start) m.set(d.id, Date.now()); else m.delete(d.id);
      this.lastActivity.set(wcId, Date.now());
    };
    sess.webRequest.onBeforeRequest((d, cb) => { note(d, true, d.resourceType); cb({}); });
    sess.webRequest.onCompleted(d => note(d, false));
    sess.webRequest.onErrorOccurred(d => note(d, false));
  }

  /** Attach (or reuse) the tracker of a session; pair every acquire with a release. */
  public static acquire(sess: Session): NetworkActivityTracker {
    let t = NetworkActivityTracker.byProvider.get(sess);
    if (!t) { t = new NetworkActivityTracker(sess); NetworkActivityTracker.byProvider.set(sess, t); }
    t.refs++;
    return t;
  }

  public release(): void {
    if (--this.refs > 0) return;
    NetworkActivityTracker.byProvider.delete(this.sess);
    try {
      this.sess.webRequest.onBeforeRequest(null);
      this.sess.webRequest.onCompleted(null);
      this.sess.webRequest.onErrorOccurred(null);
    } catch { /* session already gone */ }
    this.pending.clear();
    this.lastActivity.clear();
  }

  public inFlight(webContentsId: number): number {
    const m = this.pending.get(webContentsId);
    if (!m) return 0;
    const now = Date.now();
    let n = 0;
    for (const startedAt of m.values()) if (now - startedAt < STALE_REQUEST_MS) n++;
    return n;
  }

  public msSinceLastActivity(webContentsId: number): number {
    const last = this.lastActivity.get(webContentsId);
    return last === undefined ? Number.POSITIVE_INFINITY : Date.now() - last;
  }
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export async function settlePage(
  wc: Pick<WebContents, 'isLoading' | 'isDestroyed' | 'executeJavaScript' | 'id'>,
  network: NetworkActivity | null,
  options: SettleOptions = {}
): Promise<SettleResult> {
  const maxMs = options.maxMs ?? 10000;
  const quietMs = options.networkQuietMs ?? 500;
  const domQuietMs = options.domQuietMs ?? 150;
  const startedAt = Date.now();
  const deadline = startedAt + maxMs;
  const result = (settled: boolean): SettleResult => ({
    settled,
    reason: settled ? 'quiescent' : 'deadline',
    waitedMs: Date.now() - startedAt,
    inFlightAtEnd: network && !wc.isDestroyed() ? network.inFlight(wc.id) : 0
  });

  // The DOM script is bounded by the remaining budget, so the whole call cannot exceed maxMs by much.
  for (let round = 0; round < 4; round++) {
    // 1. document loading finished
    while (!wc.isDestroyed() && wc.isLoading()) {
      if (Date.now() >= deadline) return result(false);
      await sleep(25);
    }
    if (wc.isDestroyed()) return result(false);

    // 2. network idle
    while (network && (network.inFlight(wc.id) > 0 || network.msSinceLastActivity(wc.id) < quietMs)) {
      if (Date.now() >= deadline) return result(false);
      if (wc.isDestroyed()) return result(false);
      await sleep(25);
    }

    // 3. DOM stable
    const remaining = deadline - Date.now();
    if (remaining <= 0) return result(false);
    const stable = await VisualSettleDetector.waitForPageSettleDetailed(wc as WebContents, {
      timeoutMs: Math.min(remaining, 3000),
      quietWindowMs: domQuietMs
    });
    if (!stable.settled) {
      // The page kept mutating for the whole in-page window; retry while budget remains, then report the deadline.
      if (Date.now() >= deadline) return result(false);
      continue;
    }

    // A DOM change may have started new requests or a navigation: confirm everything is still quiet.
    const quiet = !wc.isDestroyed() && !wc.isLoading() && (!network || (network.inFlight(wc.id) === 0 && network.msSinceLastActivity(wc.id) >= quietMs));
    if (quiet) return result(true);
  }
  return result(false);
}
