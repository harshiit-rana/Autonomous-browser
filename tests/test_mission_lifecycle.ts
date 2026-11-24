/**
 * Issue #226 (RUN-04) acceptance: mission lifecycle in the REAL runtime inside real Electron
 * (tests/agent_loop/mission_lifecycle_suite.ts): states and events, single-mission rule, cancel < 1 s with no further
 * network calls, pause/takeover semantics, errors becoming `failed`, tab crash pause + reload/skip, and
 * checkpoint -> relaunch -> resume without repeating the submit. Electron must be able to start (Linux: xvfb-run -a).
 */
import { strict as assert } from 'node:assert';
import { runElectronSuite } from './agent_loop/launch.js';

console.log('--- #226 RUN-04: mission lifecycle (real Electron) ---');

async function main() {
  const { results } = await runElectronSuite('mission_lifecycle_suite', 420_000);
  let failed = 0;
  for (const r of results as Array<{ name: string; ok: boolean; detail: string; ms: number }>) {
    console.log(`${r.ok ? '✓' : '✗'} [electron] ${r.name} (${r.ms} ms)${r.ok ? `: ${r.detail.slice(0, 200)}` : `\n${r.detail}`}`);
    if (!r.ok) failed++;
  }
  assert.ok(results.length >= 11, `expected the full suite, got ${results.length} scenarios`);
  assert.equal(failed, 0, `${failed} mission lifecycle scenario(s) failed`);
  console.log(`✓ ${results.length} real-Electron mission lifecycle scenarios passed`);
}

main().catch(err => { console.error(err); process.exit(1); });
