/**
 * Main-process observation hooks for the real-app e2e harness (#254). Loaded ONLY by `e2e_entry.ts`, which refuses to
 * run unless `AEGIS_E2E=1`. No production module imports this file (tests/test_e2e_harness_guard.ts enforces that), and
 * the packaged app excludes `dist/main/e2e_*` (package.json build.files).
 *
 * The hooks do not change behaviour and expose no IPC channel: they spy on what the product already sends to the chrome
 * window and publish a read-only snapshot on `globalThis.__AEGIS_E2E__`, which Playwright reads with
 * `electronApp.evaluate()`. The product code under test is the unmodified `dist/main/index.js`.
 */
import { app, Notification, webContents } from 'electron';
import { IPC_CHANNELS } from '../ipc/contract.js';
import type { MissionStatusPayload, MissionQuestionPayload, WorkerEventPayload, TabsSnapshot, TabPatch, TabState } from '../ipc/contract.js';

export interface E2EContentsInfo {
  id: number;
  type: string;
  url: string;
  title: string;
}

export interface E2ESnapshot {
  missionStatus: MissionStatusPayload | null;
  statusHistory: MissionStatusPayload[];
  workers: Record<string, WorkerEventPayload>;
  telemetry: { tokensTotal: number; costTotal: number } | null;
  evidence: string[];
  /** Last presence event the product emitted (none until #233 ships an emitter). */
  presence: unknown | null;
  /** Tab list as the product reported it to the chrome window. */
  tabs: TabState[];
  activeTabId: string | null;
  /** Ground truth from Electron itself: every live WebContents, whatever the product reported. */
  contents: E2EContentsInfo[];
  notifications: Array<{ title: string; body: string }>;
  /** Every question the agent put to the user (ask_user, policy approvals, stuck and hand-off prompts), oldest first. */
  questions: MissionQuestionPayload[];
  /** The subset of `questions` that are policy approvals. */
  approvals: MissionQuestionPayload[];
  model: unknown | null;
  userData: string;
  electronVersion: string;
}

interface Waiter {
  statuses: string[];
  resolve: (p: MissionStatusPayload) => void;
}

const MODEL_STATE_KEY = '__AEGIS_E2E_MODEL__';
const clip = (s: string, n = 300): string => (s.length > n ? `${s.slice(0, n)}...` : s);

export function installE2EHooks(): void {
  const statusHistory: MissionStatusPayload[] = [];
  const workers: Record<string, WorkerEventPayload> = {};
  const evidence: string[] = [];
  const notifications: Array<{ title: string; body: string }> = [];
  const questions: MissionQuestionPayload[] = [];
  let telemetry: E2ESnapshot['telemetry'] = null;
  let presence: unknown | null = null;
  let tabs: TabState[] = [];
  let activeTabId: string | null = null;
  const waiters = new Set<Waiter>();

  const onSend = (channel: string, payload: any): void => {
    switch (channel) {
      case IPC_CHANNELS.EVENT_MISSION_STATUS: {
        const p = payload as MissionStatusPayload;
        statusHistory.push(p);
        for (const w of [...waiters]) {
          if (w.statuses.includes(p.status)) { waiters.delete(w); w.resolve(p); }
        }
        break;
      }
      case IPC_CHANNELS.EVENT_MISSION_QUESTION:
        questions.push(payload as MissionQuestionPayload);
        break;
      case IPC_CHANNELS.EVENT_WORKER: {
        const p = payload as WorkerEventPayload;
        workers[p.id] = p;
        break;
      }
      case IPC_CHANNELS.EVENT_EVIDENCE:
        evidence.push(String(payload?.text ?? ''));
        break;
      case IPC_CHANNELS.EVENT_TELEMETRY:
        telemetry = { tokensTotal: Number(payload?.tokensTotal ?? 0), costTotal: Number(payload?.costTotal ?? 0) };
        break;
      case IPC_CHANNELS.EVENT_PRESENCE:
        presence = payload;
        break;
      case IPC_CHANNELS.EVENT_TABS_SYNC: {
        const snap = payload as TabsSnapshot;
        tabs = snap.tabs.map(t => ({ ...t }));
        activeTabId = snap.activeTabId;
        break;
      }
      case IPC_CHANNELS.EVENT_TAB_PATCH: {
        const patch = payload as TabPatch;
        tabs = tabs.map(t => (t.id === patch.id ? { ...t, ...patch.patch } : t));
        break;
      }
      default:
        break;
    }
  };

  app.on('web-contents-created', (_event, wc) => {
    const original = wc.send.bind(wc);
    wc.send = ((channel: string, ...args: unknown[]) => {
      try { onSend(channel, args[0]); } catch { /* a spy must never break the product */ }
      return (original as (c: string, ...a: unknown[]) => void)(channel, ...args);
    }) as typeof wc.send;
  });

  // Notification spy: record, then let the product's own call go through.
  const originalShow = Notification.prototype.show;
  Notification.prototype.show = function patchedShow(this: Electron.Notification) {
    notifications.push({ title: String(this.title ?? ''), body: String(this.body ?? '') });
    try { return originalShow.call(this); } catch { /* no notification daemon in CI */ }
  };

  const snapshot = (): E2ESnapshot => ({
    missionStatus: statusHistory.length > 0 ? statusHistory[statusHistory.length - 1] : null,
    statusHistory: [...statusHistory],
    workers: { ...workers },
    telemetry,
    evidence: [...evidence],
    presence,
    tabs: tabs.map(t => ({ ...t })),
    activeTabId,
    contents: webContents.getAllWebContents().map(wc => ({
      id: wc.id,
      type: wc.getType(),
      url: wc.isDestroyed() ? '' : wc.getURL(),
      title: wc.isDestroyed() ? '' : wc.getTitle()
    })),
    notifications: [...notifications],
    questions: [...questions],
    approvals: questions.filter(q => q.kind === 'approval'),
    model: (globalThis as any)[MODEL_STATE_KEY] ?? null,
    userData: app.getPath('userData'),
    electronVersion: process.versions.electron
  });

  /** Resolves on the first status in `statuses`, including one that already happened; rejects on timeout. */
  const waitForStatus = (statuses: string[], timeoutMs: number, afterIndex = 0): Promise<MissionStatusPayload> =>
    new Promise((resolve, reject) => {
      const seen = statusHistory.slice(afterIndex).find(s => statuses.includes(s.status));
      if (seen) { resolve(seen); return; }
      const waiter: Waiter = {
        statuses,
        resolve: p => { clearTimeout(timer); resolve(p); }
      };
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        const last = statusHistory[statusHistory.length - 1];
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for mission status ${statuses.join('|')}; last status: ${clip(JSON.stringify(last ?? null))}; recent evidence: ${JSON.stringify(evidence.slice(-6).map(clip))}`));
      }, timeoutMs);
      waiters.add(waiter);
    });

  (globalThis as any).__AEGIS_E2E__ = { snapshot, waitForStatus };
}
