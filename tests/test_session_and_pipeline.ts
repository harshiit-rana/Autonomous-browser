import { SessionManager } from '../src/session/session_manager.js';
import { TrajectoryRecorder, TrajectoryReplayer, TrajectoryStep } from '../src/automation/flight_recorder.js';
import { DownloadPipeline } from '../src/session/download_pipeline.js';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

function testSessionProfiles() {
  console.log('--- Testing SessionManager Profiles ---');
  const tempDir = path.join(process.cwd(), '.temp_sessions_test');
  const mgr = new SessionManager(tempDir);

  const workProfile = mgr.getOrCreateProfile('work', 'Work Account', false);
  const incognito = mgr.getOrCreateProfile('guest', 'Guest Anonymous', true);

  assert.strictEqual(workProfile.partitionName, 'persist:profile_work');
  assert.strictEqual(incognito.partitionName, 'profile_incognito_guest');
  assert.strictEqual(mgr.listProfiles().length >= 3, true);

  if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('✓ SessionManager profile isolation verified!\n');
}

async function testTrajectoryReplay() {
  console.log('--- Testing TrajectoryRecorder & Replay ---');
  const recorder = new TrajectoryRecorder();
  recorder.startSession('sess_1', 'Research quantum computing');

  recorder.recordStep({
    action: 'navigate',
    url: 'https://en.wikipedia.org/wiki/Quantum_computing'
  });

  recorder.recordStep({
    action: 'scroll',
    deltaY: 500
  });

  recorder.recordStep({
    action: 'click',
    targetAgentId: 'agent_btn_intro'
  });

  const session = recorder.endSession();
  assert.strictEqual(session !== null, true);
  assert.strictEqual(session!.steps.length, 3);
  assert.strictEqual(session!.steps[0].action, 'navigate');

  // Test deterministic replayer
  const executed: string[] = [];
  const count = await TrajectoryReplayer.replay(
    session!,
    async (step: TrajectoryStep) => {
      executed.push(step.action);
    },
    0 // No delay in unit test
  );

  assert.strictEqual(count, 3);
  assert.deepStrictEqual(executed, ['navigate', 'scroll', 'click']);
  console.log('✓ TrajectoryRecorder & Replayer verified!\n');
}

function testDownloadPipeline() {
  console.log('--- Testing DownloadPipeline ---');
  const tempDir = path.join(process.cwd(), '.temp_downloads_test');
  const pipeline = new DownloadPipeline(tempDir);

  // Safe file
  const safeBuffer = Buffer.from('PDF sample text document', 'utf8');
  const safeItem = pipeline.stageDownloadedBuffer('report.pdf', safeBuffer, 'application/pdf');
  assert.strictEqual(safeItem.isQuarantined, false);
  assert.strictEqual(fs.existsSync(safeItem.filePath), true);

  // Dangerous executable file -> must be quarantined
  const dangerousBuffer = Buffer.from('MZ executable dummy', 'utf8');
  const dangerousItem = pipeline.stageDownloadedBuffer('malicious_payload.exe', dangerousBuffer);
  assert.strictEqual(dangerousItem.isQuarantined, true, 'Executable must be quarantined');
  assert.strictEqual(Boolean(dangerousItem.quarantineReason), true);

  if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('✓ DownloadPipeline quarantine & staging verified!\n');
}

async function main() {
  testSessionProfiles();
  await testTrajectoryReplay();
  testDownloadPipeline();
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
