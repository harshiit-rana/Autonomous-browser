/**
 * Durable mission record: mission row + append-only event log in SQLite (Issue #239).
 *
 * The runtime calls these from its emit/finish paths. Persistence problems must never crash the agent or the
 * main process, so every method catches, logs and reports through `lastError` instead of throwing. When the
 * database has not been opened (unit tests that construct the runtime pieces directly) calls are no-ops.
 */

import { hasDb } from './db.js';
import { getRepos } from './repos/index.js';
import type { PersistedMissionState } from './repos/missions_repo.js';
import { rootLogger } from './logger.js';

const logger = rootLogger.child('mission-recorder');

export interface RecordableMission {
  id: string;
  prompt: string;
  model: string;
  state: PersistedMissionState;
  stepCount: number;
  tabId?: string;
  result?: string;
  error?: string;
  evidenceCollected: string[];
}

export class MissionRecorder {
  public static lastError: string | null = null;

  private static fail(op: string, err: any): void {
    MissionRecorder.lastError = `${op}: ${err?.message ?? err}`;
    logger.warn('Mission persistence failed', { op, error: err?.message ?? String(err), code: err?.code });
  }

  /** Upserts the mission row (call right after the mission object exists, and on every state change). */
  public static checkpoint(mission: RecordableMission): void {
    if (!hasDb()) return;
    try {
      getRepos().missions.upsertMission({
        id: mission.id,
        prompt: mission.prompt,
        model: mission.model,
        state: mission.state,
        stepCount: mission.stepCount,
        tabId: mission.tabId,
        result: mission.result,
        error: mission.error,
        evidenceCount: mission.evidenceCollected.length
      });
    } catch (err) {
      MissionRecorder.fail('checkpoint', err);
    }
  }

  /** Appends one event to the mission's log; `seq` is assigned by the database. Returns the seq or null. */
  public static event(missionId: string | undefined, kind: string, data: unknown): number | null {
    if (!missionId || !hasDb()) return null;
    try {
      return getRepos().missions.appendEvent(missionId, kind, data);
    } catch (err) {
      MissionRecorder.fail(`event:${kind}`, err);
      return null;
    }
  }

  /** On startup: missions left in a live state by a crash/kill are marked failed with an explanatory event. */
  public static recoverInterrupted(): number {
    if (!hasDb()) return 0;
    try {
      const repos = getRepos();
      const stale = repos.missions.listInterrupted();
      for (const m of stale) {
        repos.missions.upsertMission({ ...m, state: 'failed', error: m.error ?? 'Interrupted: the app exited before this mission finished.' });
        repos.missions.appendEvent(m.id, 'mission.interrupted', { previousState: m.state });
      }
      return stale.length;
    } catch (err) {
      MissionRecorder.fail('recoverInterrupted', err);
      return 0;
    }
  }
}
