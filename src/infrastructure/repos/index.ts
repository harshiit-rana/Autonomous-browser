import { AegisDb, getDb } from '../db.js';
import { SettingsRepo } from './settings_repo.js';
import { MissionsRepo } from './missions_repo.js';
import { EvidenceRepo } from './evidence_repo.js';
import { ThreadsRepo } from './threads_repo.js';
import { PromptsRepo } from './prompts_repo.js';
import { InstructionsRepo, SchedulesRepo, InboxRepo } from './assistant_repo.js';
import { MemoriesRepo, ApprovalsRepo, ActionLedgerRepo } from './safety_repo.js';
import { PagesRepo } from './pages_repo.js';

export interface Repos {
  settings: SettingsRepo;
  missions: MissionsRepo;
  evidence: EvidenceRepo;
  threads: ThreadsRepo;
  prompts: PromptsRepo;
  instructions: InstructionsRepo;
  schedules: SchedulesRepo;
  inbox: InboxRepo;
  memories: MemoriesRepo;
  approvals: ApprovalsRepo;
  actionLedger: ActionLedgerRepo;
  pages: PagesRepo;
}

export function createRepos(db: AegisDb): Repos {
  return {
    settings: new SettingsRepo(db),
    missions: new MissionsRepo(db),
    evidence: new EvidenceRepo(db),
    threads: new ThreadsRepo(db),
    prompts: new PromptsRepo(db),
    instructions: new InstructionsRepo(db),
    schedules: new SchedulesRepo(db),
    inbox: new InboxRepo(db),
    memories: new MemoriesRepo(db),
    approvals: new ApprovalsRepo(db),
    actionLedger: new ActionLedgerRepo(db),
    pages: new PagesRepo(db)
  };
}

/** Repos bound to the process-wide database opened at startup. */
export function getRepos(): Repos {
  return createRepos(getDb());
}

export * from './settings_repo.js';
export * from './missions_repo.js';
export * from './evidence_repo.js';
export * from './threads_repo.js';
export * from './prompts_repo.js';
export * from './assistant_repo.js';
export * from './safety_repo.js';
export * from './pages_repo.js';
