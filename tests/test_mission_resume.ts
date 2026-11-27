/**
 * Issue #226 steps 4 and 6 (plain Node, real file system / real child process):
 *  - the main process survives unhandled rejections and uncaught exceptions (and a control run proves node would die);
 *  - the mission checkpoint lives in the app data dir, is written atomically, tolerates corruption, and the resume note
 *    never tells the model to replay a side effect.
 */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  MissionCheckpoint, buildResumeNote, checkpointFile, listInterrupted, readCheckpoint, removeCheckpoint, summarizeAction,
  writeCheckpoint, MAX_RESUME_AGE_MS, SIDE_EFFECT_TOOLS
} from '../src/agent/mission_checkpoint.js';

console.log('--- #226 RUN-04: process error handlers, checkpoint, resume note ---');

const ROOT = process.cwd();
const tsx = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

// ------------------------------------------------------------------ unhandledRejection / uncaughtException
{
  const child = path.join(ROOT, 'tests', 'helpers', 'process_errors_child.ts');
  const ok = spawnSync(process.execPath, [tsx, child], { encoding: 'utf8', timeout: 60000 });
  assert.equal(ok.status, 0, `child must survive both errors; exit=${ok.status}\n${ok.stdout}\n${ok.stderr.slice(-500)}`);
  assert.match(ok.stdout, /LOGGED Unhandled Promise Rejection in main process.*rejected-and-forgotten/);
  assert.match(ok.stdout, /LOGGED Uncaught Exception in main process thrown-from-a-timer/);
  assert.match(ok.stdout, /ALIVE/);
  const control = spawnSync(process.execPath, [tsx, child, 'control'], { encoding: 'utf8', timeout: 60000 });
  assert.notEqual(control.status, 0, 'control: without the unhandledRejection handler node terminates');
  assert.doesNotMatch(control.stdout, /ALIVE/);
  console.log('✓ unhandledRejection and uncaughtException are logged and the process keeps running (control run dies without the handler)');
}

// ------------------------------------------------------------------ checkpoint
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-ckpt-'));
const cwdBefore = fs.readdirSync(ROOT).sort();
const mk = (over: Partial<MissionCheckpoint> = {}): MissionCheckpoint => ({
  version: 1, missionId: 'm_1', prompt: 'Buy the widget at http://127.0.0.1:1/shop', model: 'gpt-x', state: 'running', stepCount: 3,
  url: 'http://127.0.0.1:1/shop', savedAt: Date.now(), notes: ['Looks like the checkout button'],
  actions: [
    { step: 1, tool: 'navigate', summary: 'navigate(url="http://127.0.0.1:1/shop")', sideEffect: false, phase: 'done', ok: true },
    { step: 2, tool: 'click', summary: 'click(target="Place order", ref="e3")', sideEffect: true, phase: 'done', ok: true, url: 'http://127.0.0.1:1/shop' }
  ],
  ...over
});

{
  const file = writeCheckpoint(base, mk());
  assert.equal(file, checkpointFile(base, 'm_1'));
  assert.ok(file.startsWith(base), 'inside the app data dir');
  assert.deepEqual(fs.readdirSync(ROOT).sort(), cwdBefore, 'nothing was written to the working directory');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['checkpoint.json'], 'no temp file is left behind (atomic rename)');
  const back = readCheckpoint(base, 'm_1')!;
  assert.equal(back.prompt, mk().prompt);
  assert.equal(back.actions[1].summary, 'click(target="Place order", ref="e3")');
  // rewriting replaces, never appends or leaves a partial file
  writeCheckpoint(base, mk({ stepCount: 9 }));
  assert.equal(readCheckpoint(base, 'm_1')!.stepCount, 9);
  console.log('✓ checkpoint is written atomically under the app data dir, not the cwd');
}

{
  // Corrupt / truncated / foreign-version files are ignored, never thrown.
  fs.mkdirSync(path.join(base, 'missions', 'm_bad1'), { recursive: true });
  fs.writeFileSync(path.join(base, 'missions', 'm_bad1', 'checkpoint.json'), '{"version":1,"missionId":"m_bad1","prompt":"x"'); // truncated
  fs.mkdirSync(path.join(base, 'missions', 'm_bad2'), { recursive: true });
  fs.writeFileSync(path.join(base, 'missions', 'm_bad2', 'checkpoint.json'), JSON.stringify({ ...mk({ missionId: 'm_bad2' }), version: 99 }));
  fs.mkdirSync(path.join(base, 'missions', 'm_bad3'), { recursive: true });
  fs.writeFileSync(path.join(base, 'missions', 'm_bad3', 'checkpoint.json'), 'null');
  fs.mkdirSync(path.join(base, 'missions', 'm_empty'), { recursive: true }); // dir without a file
  assert.equal(readCheckpoint(base, 'm_bad1'), null);
  assert.equal(readCheckpoint(base, 'm_bad2'), null);
  assert.equal(readCheckpoint(base, 'm_bad3'), null);
  assert.equal(readCheckpoint(base, 'm_empty'), null);
  assert.deepEqual(listInterrupted(base).map(c => c.missionId), ['m_1'], 'only the valid unfinished checkpoint is offered');
  assert.throws(() => checkpointFile(base, '../../etc'), /bad mission id/);
  console.log('✓ corrupt, truncated, wrong-version and empty checkpoints are skipped; path traversal is refused');
}

{
  // Which checkpoints are offered.
  const now = Date.now();
  writeCheckpoint(base, mk({ missionId: 'm_done', state: 'completed' }));
  writeCheckpoint(base, mk({ missionId: 'm_cancel', state: 'cancelled' }));
  writeCheckpoint(base, mk({ missionId: 'm_failed', state: 'failed' }));
  writeCheckpoint(base, mk({ missionId: 'm_old', savedAt: now - MAX_RESUME_AGE_MS - 1000 }));
  writeCheckpoint(base, mk({ missionId: 'm_newer', state: 'waiting_user', savedAt: now + 5 }));
  assert.deepEqual(listInterrupted(base, { now }).map(c => c.missionId), ['m_newer', 'm_1'], 'terminal and stale ones are not offered; newest first');
  assert.deepEqual(listInterrupted(base, { now, exclude: 'm_newer' }).map(c => c.missionId), ['m_1'], 'the live mission is excluded');
  removeCheckpoint(base, 'm_newer');
  removeCheckpoint(base, 'does_not_exist'); // must not throw
  assert.deepEqual(listInterrupted(base, { now }).map(c => c.missionId), ['m_1']);
  console.log('✓ only unfinished, fresh checkpoints are offered, newest first; the live mission is excluded');
}

// ------------------------------------------------------------------ summaries and the resume note
{
  assert.equal(summarizeAction('type', { ref: 'e4', text: 'hunter2-secret' }, 'Password'), 'type(target="Password", ref="e4", text=<14 chars>)');
  assert.ok(!summarizeAction('type', { text: 'hunter2-secret' }).includes('hunter2'), 'typed text never reaches the checkpoint');
  assert.ok(SIDE_EFFECT_TOOLS.has('click') && SIDE_EFFECT_TOOLS.has('type') && !SIDE_EFFECT_TOOLS.has('scroll') && !SIDE_EFFECT_TOOLS.has('extract'));

  const note = buildResumeNote(mk());
  assert.match(note, /interrupted/);
  assert.match(note, /Nothing from the earlier run was replayed/);
  assert.match(note, /ALREADY performed \(do NOT repeat them/);
  assert.match(note, /step 2: click\(target="Place order"/);
  assert.match(note, /re-opened on http:\/\/127\.0\.0\.1:1\/shop/);
  assert.doesNotMatch(note, /UNKNOWN OUTCOME/);

  const unknown = buildResumeNote(mk({
    actions: [{ step: 4, tool: 'click', summary: 'click(target="Submit order")', sideEffect: true, phase: 'in_flight', url: 'http://127.0.0.1:1/cart' }]
  }));
  assert.match(unknown, /UNKNOWN OUTCOME: step 4 click\(target="Submit order"\)/);
  assert.match(unknown, /may or may not have taken effect/);
  assert.match(unknown, /only repeat it if the page shows it did not happen/);
  assert.doesNotMatch(unknown, /ALREADY performed/, 'an in-flight action is not claimed as done');

  const harmless = buildResumeNote(mk({ actions: [{ step: 2, tool: 'scroll', summary: 'scroll(direction="down")', sideEffect: false, phase: 'in_flight' }] }));
  assert.doesNotMatch(harmless, /UNKNOWN OUTCOME/);
  assert.match(harmless, /no side effects/);

  const failedClick = buildResumeNote(mk({ actions: [{ step: 2, tool: 'click', summary: 'click(target="x")', sideEffect: true, phase: 'done', ok: false }] }));
  assert.doesNotMatch(failedClick, /ALREADY performed/, 'a click that reported failure is not listed as performed');
  console.log('✓ resume note: lists done side effects as do-not-repeat, flags an in-flight one as unknown, redacts typed text');
}

fs.rmSync(base, { recursive: true, force: true });
