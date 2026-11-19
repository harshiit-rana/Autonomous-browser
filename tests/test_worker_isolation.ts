/**
 * Issue #229 [SWX-03] - worker isolation, guards, teardown and settle logic.
 *
 * These tests run the real WorkerHost / SwarmManager / guard / settle code under plain Node with an Electron
 * stand-in (tests/helpers/fake_electron_runtime.ts) that records what the code does. Real Electron behaviour
 * (distinct sessions, cookie isolation, webContents leak count, memory) is proven by
 * scripts/e2e_worker_isolation.mjs against the running app.
 */

import assert from 'node:assert/strict';
import {
  WorkerHost, WorkerRuntimeUnavailableError, WorkerEvent, allocatePartitionName
} from '../src/swarm/worker_host.js';
import { SwarmManager, MAX_CRASH_RECOVERIES } from '../src/swarm/swarm_manager.js';
import { checkAgentUrl, normaliseAgentNavigationTarget } from '../src/swarm/agent_tab_guards.js';
import { settlePage } from '../src/swarm/page_settle.js';
import { workerIdentityFor } from '../src/swarm/worker_identity.js';
import { FakeElectronRuntime, FakeWebContents, FakeWindow } from './helpers/fake_electron_runtime.js';
import { fakeWorkerFactory } from './helpers/fake_worker_host.js';

const wcOf = (w: WorkerHost) => w.view.webContents as unknown as FakeWebContents;
const sessOf = (w: WorkerHost) => (w.view.webContents as unknown as FakeWebContents).session;
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

async function main() {
  // ---------------------------------------------------------------- no hidden fallback
  console.log('[229] No mock view: constructing a worker without Electron fails loudly');
  assert.throws(() => new WorkerHost({ id: 'w_nofallback' }), (e: unknown) => e instanceof WorkerRuntimeUnavailableError);

  // ---------------------------------------------------------------- URL policy
  console.log('[229] URL policy for agent tabs');
  const blocked = [
    'file:///C:/Windows/win.ini', 'chrome://settings', 'devtools://devtools/bundled/inspector.html', 'view-source:https://a.com',
    'javascript:alert(1)', 'data:text/html,<script>1</script>', 'myapp://open?x=1', 'ftp://example.com/x', 'blob:https://a.com/uuid',
    'chrome-extension://abc/page.html', 'about:config', ''
  ];
  for (const u of blocked) {
    assert.equal(normaliseAgentNavigationTarget(u).allowed, false, `must block ${JSON.stringify(u)}`);
  }
  const expected: Record<string, string> = {
    'https://example.com/a?b=1': 'https://example.com/a?b=1',
    'http://127.0.0.1:8080/x': 'http://127.0.0.1:8080/x',
    'example.com': 'https://example.com/',
    'localhost:8080/p': 'https://localhost:8080/p',
    '  HTTPS://Example.com  ': 'https://example.com/'
  };
  for (const [input, want] of Object.entries(expected)) {
    const r = normaliseAgentNavigationTarget(input);
    assert.ok(r.allowed, `${input} should be allowed: ${r.reason}`);
    assert.equal(r.url, want);
  }
  assert.equal(checkAgentUrl('about:blank').allowed, true);
  assert.equal(checkAgentUrl('not a url').allowed, false);

  // ---------------------------------------------------------------- partitions and identity
  console.log('[229] Partition naming and identity');
  const a = allocatePartitionName('mission-1', 'w1');
  const b = allocatePartitionName('mission-1', 'w2');
  const c = allocatePartitionName('mission-2', 'w1');
  const d = allocatePartitionName('mission-1', 'w1'); // same mission+worker claimed again (e.g. id reuse)
  assert.equal(new Set([a, b, c, d]).size, 4, 'names are never handed out twice');
  assert.ok([a, b, c, d].every(n => n.startsWith('agent-') && !n.startsWith('persist:')), 'ephemeral partitions are in-memory');
  assert.ok(allocatePartitionName('we ird/../mission', 'w:1').match(/^agent-[A-Za-z0-9_.-]+$/), 'unsafe characters are sanitised');

  const identities = Array.from({ length: 12 }, (_, i) => workerIdentityFor(i + 1));
  assert.equal(new Set(identities.map(i => i.name)).size, 12);
  assert.equal(new Set(identities.map(i => i.color)).size, 12);
  assert.equal(new Set(identities.map(i => i.glyph)).size, 12);
  assert.deepEqual(workerIdentityFor(5), workerIdentityFor(5), 'identity is stable');
  assert.notEqual(workerIdentityFor(13).name, workerIdentityFor(1).name, 'ordinals beyond the palette stay distinguishable');

  // ---------------------------------------------------------------- WorkerHost on the Electron stand-in
  console.log('[229] WorkerHost isolation, guards and teardown');
  const env = new FakeElectronRuntime();
  const win = new FakeWindow();
  const w1 = new WorkerHost({ id: 'w1', missionId: 'mA', ordinal: 1, runtime: env.runtime, parentWindow: win as never, attachToWindow: true });
  const w2 = new WorkerHost({ id: 'w2', missionId: 'mA', ordinal: 2, runtime: env.runtime, parentWindow: win as never });
  const w3 = new WorkerHost({ id: 'w3', missionId: 'mB', ordinal: 3, runtime: env.runtime });

  assert.equal(new Set([w1, w2, w3].map(w => w.partitionName)).size, 3, 'three workers, three partitions');
  assert.equal(new Set([w1, w2, w3].map(w => sessOf(w))).size, 3, 'three workers, three sessions');
  assert.ok(w1.partitionName.includes('mA') && w3.partitionName.includes('mB'), 'partition carries the mission id');
  assert.equal(win.children.length, 1, 'only the worker that asked to be attached is in the window');

  // permissions: denied on the request path and on the synchronous check path
  const answers: boolean[] = [];
  for (const perm of ['media', 'geolocation', 'notifications', 'clipboard-read']) {
    sessOf(w1).permissionRequestHandler!(null, perm, allow => answers.push(allow));
  }
  assert.deepEqual(answers, [false, false, false, false]);
  assert.equal(sessOf(w1).permissionCheckHandler!(), false);

  // page-initiated navigation: blocked schemes are prevented, web pages are not
  const events: WorkerEvent[] = [];
  w1.on('event', e => events.push(e));
  for (const evName of ['will-navigate', 'will-redirect', 'will-frame-navigate']) {
    let prevented = 0;
    wcOf(w1).emit(evName, { url: 'file:///etc/passwd', preventDefault: () => { prevented++; } });
    wcOf(w1).emit(evName, { url: 'chrome://gpu', preventDefault: () => { prevented++; } });
    wcOf(w1).emit(evName, { url: 'https://example.com/ok', preventDefault: () => { prevented += 100; } });
    assert.equal(prevented, 2, `${evName}: file: and chrome: prevented, https: allowed`);
  }
  assert.equal(events.filter(e => e.type === 'navigation-blocked').length, 6);
  assert.ok(events.every(e => e.identity.name === w1.identity.name && e.workerId === 'w1'), 'every event carries the worker identity');

  // popups and downloads
  assert.deepEqual(wcOf(w1).windowOpenHandler!({ url: 'https://popup.example/' }), { action: 'deny' });
  let cancelled = 0, prevented = 0;
  sessOf(w1).emit('will-download', { preventDefault: () => { prevented++; } }, { getFilename: () => 'x.exe', cancel: () => { cancelled++; } });
  assert.equal(cancelled, 1);
  assert.equal(prevented, 1);
  assert.ok(events.some(e => e.type === 'popup-denied') && events.some(e => e.type === 'download-cancelled'));

  // programmatic navigation never reaches loadURL for blocked targets
  for (const u of ['file:///etc/passwd', 'chrome://settings', 'javascript:alert(1)']) {
    await assert.rejects(() => w1.navigate(u), /Navigation blocked/);
  }
  assert.equal(wcOf(w1).loadedUrls.length, 0, 'loadURL was not called for any blocked URL');

  // crash handling
  wcOf(w1).emit('did-navigate', {}, 'https://example.com/last');
  wcOf(w1).emit('render-process-gone', {}, { reason: 'crashed', exitCode: 9 });
  assert.equal(w1.status, 'crashed');
  assert.equal(w1.crashes, 1);
  assert.ok(events.some(e => e.type === 'render-process-gone'));
  assert.equal(await w1.recover(), true);
  assert.equal(w1.status, 'idle');
  assert.equal(wcOf(w1).getURL(), 'https://example.com/last', 'recovery reloads the last URL');

  // teardown
  const sessionOfW1 = sessOf(w1);
  await Promise.all([w1.teardown(), w1.teardown()]); // concurrent + idempotent
  assert.equal(wcOf(w1).closeCalls, 1, 'close() called exactly once');
  assert.equal(w1.destroyedConfirmed, true, 'teardown waited for the destroyed event');
  assert.equal(wcOf(w1).isDestroyed(), true);
  assert.equal(win.children.length, 0, 'view removed from the window');
  assert.ok(sessionOfW1.clearedStorage >= 1 && sessionOfW1.clearedCache >= 1, 'ephemeral storage cleared');
  for (const evName of ['will-navigate', 'will-redirect', 'will-frame-navigate', 'render-process-gone', 'did-navigate']) {
    assert.equal(wcOf(w1).listenerCount(evName), 0, `listener ${evName} removed`);
  }
  assert.equal(sessionOfW1.webRequestHandlers.before, null, 'network tracker released');
  await assert.rejects(() => w1.navigate('https://example.com'), /torn down/);
  assert.equal((await w1.getSnapshot()).status, 'terminated');

  // the other workers are unaffected
  assert.equal(wcOf(w2).isDestroyed(), false);
  await w2.teardown();
  await w3.teardown();

  // persistent / user profiles are never wiped, and the user's default session is never re-guarded
  const agentProfile = new WorkerHost({ id: 'p1', missionId: 'mP', isolationLevel: 'agent-profile', profileId: 'work', runtime: env.runtime });
  assert.equal(agentProfile.partitionName, 'persist:agent-profile-work');
  await agentProfile.teardown();
  assert.equal(sessOf(agentProfile).clearedStorage, 0, 'agent-profile storage is not cleared on teardown');
  const userProfile = new WorkerHost({ id: 'u1', missionId: 'mP', isolationLevel: 'user-profile', runtime: env.runtime });
  assert.equal(env.defaultSessionObj.permissionRequestHandler, null, 'default session handlers untouched');
  assert.equal(env.defaultSessionObj.webRequestHandlers.before, undefined, 'no network tracker on the default session');
  assert.equal(userProfile.partitionName, '');
  await userProfile.teardown();
  assert.equal(env.defaultSessionObj.clearedStorage, 0, 'user-profile storage is never cleared');

  // ---------------------------------------------------------------- SwarmManager lifecycle on real WorkerHost objects
  console.log('[229] SwarmManager spawn/retire/shutdown, crash recovery, window close');
  const env2 = new FakeElectronRuntime();
  const win2 = new FakeWindow();
  const mgr = new SwarmManager({
    maxWorkers: 4, missionId: 'mission-x', parentWindow: win2 as never, attachToWindow: true,
    workerFactory: o => new WorkerHost({ ...o, runtime: env2.runtime })
  });
  const spawned = await mgr.spawnSwarm(3, 'researcher');
  assert.equal(new Set(spawned.map(w => w.partitionName)).size, 3);
  assert.ok(spawned.every(w => w.partitionName.includes('mission-x')));
  assert.equal(new Set(spawned.map(w => w.identity.name)).size, 3);
  assert.equal(win2.children.length, 3);
  await mgr.spawnWorker('verifier');
  await assert.rejects(() => mgr.spawnWorker('one-too-many'), /pool limit/);

  // crash recovery is bounded
  const victim = spawned[0] as WorkerHost;
  wcOf(victim).emit('did-navigate', {}, 'https://example.com/v');
  for (let i = 0; i < MAX_CRASH_RECOVERIES + 2; i++) {
    wcOf(victim).emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    await tick(5);
  }
  assert.equal(wcOf(victim).loadedUrls.length, MAX_CRASH_RECOVERIES, 'recovered at most MAX_CRASH_RECOVERIES times');
  assert.equal(victim.status, 'crashed', 'after the limit the worker stays failed instead of looping');

  // retire into the pool, then shut everything down: pooled workers must be torn down too
  await mgr.retireWorker(spawned[1].id, true);
  assert.equal(mgr.getIdleCount(), 1);
  const allViews = env2.views.slice();
  await mgr.shutdown();
  assert.ok(allViews.every(v => v.webContents.isDestroyed()), 'every worker WebContents is destroyed after shutdown');
  assert.equal(win2.children.length, 0, 'no worker view left in the window');
  assert.equal(mgr.getActiveCount(), 0);
  assert.equal(mgr.getIdleCount(), 0);
  await assert.rejects(() => mgr.spawnWorker(), /shut down/);

  // closing the window while workers run tears the swarm down
  const env3 = new FakeElectronRuntime();
  const win3 = new FakeWindow();
  const mgr3 = new SwarmManager({
    missionId: 'mission-y', parentWindow: win3 as never, attachToWindow: true,
    workerFactory: o => new WorkerHost({ ...o, runtime: env3.runtime })
  });
  await mgr3.spawnSwarm(2);
  win3.close();
  await tick(20);
  assert.ok(env3.views.every(v => v.webContents.isDestroyed()), 'window close destroyed every worker view');
  assert.equal(mgr3.getActiveCount(), 0);

  // manager + fake hosts: crash events are routed to recover()
  const fakes = fakeWorkerFactory();
  const mgr4 = new SwarmManager({ missionId: 'mission-z', workerFactory: fakes.factory });
  const [f1] = await mgr4.spawnSwarm(1);
  (fakes.built[0]).simulateCrash();
  await tick(5);
  assert.equal(fakes.built[0].recoveries, 1);
  assert.equal(f1.id, fakes.built[0].id);
  await mgr4.shutdown();

  // ---------------------------------------------------------------- settle logic
  console.log('[229] Page settle: load finished + network idle + DOM stable, under a deadline');
  const s1 = new FakeWebContents(env.runtime.sessionFor('settle-test') as never);
  s1.loading = true;
  setTimeout(() => { s1.loading = false; }, 150);
  let inFlight = 2;
  let lastActivity = Date.now();
  setTimeout(() => { inFlight = 1; lastActivity = Date.now(); }, 200);
  setTimeout(() => { inFlight = 0; lastActivity = Date.now(); }, 300);
  const net = { inFlight: () => inFlight, msSinceLastActivity: () => Date.now() - lastActivity };
  const t0 = Date.now();
  const ok = await settlePage(s1 as never, net, { maxMs: 5000, networkQuietMs: 200 });
  const took = Date.now() - t0;
  assert.equal(ok.settled, true);
  assert.ok(took >= 300 + 200 - 30, `must wait for the last request and the quiet window (took ${took} ms)`);
  assert.ok(took < 2000, `but not for the deadline (took ${took} ms)`);

  const s2 = new FakeWebContents(env.runtime.sessionFor('settle-test-2') as never);
  const t1 = Date.now();
  const stuck = await settlePage(s2 as never, { inFlight: () => 1, msSinceLastActivity: () => 0 }, { maxMs: 400 });
  assert.equal(stuck.settled, false);
  assert.equal(stuck.reason, 'deadline');
  assert.equal(stuck.inFlightAtEnd, 1);
  assert.ok(Date.now() - t1 < 1200, 'deadline is honoured');

  const s3 = new FakeWebContents(env.runtime.sessionFor('settle-test-3') as never);
  s3.executeJavaScript = async () => ({ settled: true, reason: 'timeout_reached' }); // DOM never goes quiet
  const never = await settlePage(s3 as never, null, { maxMs: 400 });
  assert.equal(never.settled, false, 'an endlessly mutating DOM is reported as not settled, not as success');

  const s4 = new FakeWebContents(env.runtime.sessionFor('settle-test-4') as never);
  s4.destroyed = true;
  assert.equal((await settlePage(s4 as never, null)).settled, false, 'a destroyed page never reports settled');

  console.log('\nALL WORKER ISOLATION TESTS PASSED');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
