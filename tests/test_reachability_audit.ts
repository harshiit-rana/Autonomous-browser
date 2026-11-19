/**
 * Reachability Audit Harness Unit Test (Issue #221 - [TRU-03])
 *
 * Verifies that the reachability audit algorithm accurately detects:
 * - Static imports and exports
 * - Wildcard re-exports (export * from)
 * - Dynamic import() calls
 * - Cyclic dependency graphs (a -> b -> a) without infinite looping
 * - Type-only imports (import type { ... } from '...'), ensuring they DO NOT count as reachable
 * - Truly orphaned modules
 */

import * as assert from 'node:assert';
import * as path from 'node:path';
import { auditReachability, getImports } from '../scripts/audit_reachability.mjs';

console.log('--- Testing Reachability Audit Engine & Fixtures (#221 - [TRU-03]) ---\n');

function testReachabilityFixture() {
  console.log('[#221 TRU-03] Testing reachability fixture graph analysis...');
  const fixtureDir = path.resolve(process.cwd(), 'tests/fixtures/reach');
  const entryPoint = path.join(fixtureDir, 'entry.ts');

  // Verify getImports on entry.ts
  const entryImports = getImports(entryPoint);
  const importBasenames = entryImports.map((p) => path.basename(p));

  // Must include static_mod, dynamic_mod, and cycle_a
  assert.ok(importBasenames.includes('static_mod.ts'), 'Must include static_mod.ts');
  assert.ok(importBasenames.includes('dynamic_mod.ts'), 'Must include dynamic_mod.ts');
  assert.ok(importBasenames.includes('cycle_a.ts'), 'Must include cycle_a.ts');

  // MUST NOT include type_only_mod.ts
  assert.strictEqual(
    importBasenames.includes('type_only_mod.ts'),
    false,
    'Type-only import must NOT be treated as a runtime dependency'
  );
  console.log('✓ getImports ignores type-only imports and captures dynamic imports');

  // Run full audit on fixture directory
  const { allSrc, reachableCount, report } = auditReachability(fixtureDir, [entryPoint]);

  assert.strictEqual(allSrc.length, 8, 'Fixture should have exactly 8 modules');

  const reportMap = new Map<string, boolean>();
  for (const item of report) {
    reportMap.set(item.path, item.isReachable);
  }

  // Reachable assertions
  assert.strictEqual(reportMap.get('entry.ts'), true, 'entry.ts must be reachable');
  assert.strictEqual(reportMap.get('static_mod.ts'), true, 'static_mod.ts must be reachable');
  assert.strictEqual(reportMap.get('reexport_mod.ts'), true, 'reexport_mod.ts must be reachable (export *)');
  assert.strictEqual(reportMap.get('dynamic_mod.ts'), true, 'dynamic_mod.ts must be reachable (dynamic import)');
  assert.strictEqual(reportMap.get('cycle_a.ts'), true, 'cycle_a.ts must be reachable');
  assert.strictEqual(reportMap.get('cycle_b.ts'), true, 'cycle_b.ts must be reachable (cycle resolution)');

  // Orphaned assertions
  assert.strictEqual(
    reportMap.get('type_only_mod.ts'),
    false,
    'type_only_mod.ts must be orphaned (only imported as type)'
  );
  assert.strictEqual(reportMap.get('dead_orphan.ts'), false, 'dead_orphan.ts must be orphaned');

  assert.strictEqual(reachableCount, 6, 'Exactly 6 of 8 fixture modules must be reachable');
  console.log('✓ Fixture graph reachability: 6 reachable, 2 orphaned (type-only & dead code verified)');
}

testReachabilityFixture();

console.log('======================================================');
console.log('ALL REACHABILITY AUDIT ENGINE TESTS PASSED (100%)');
console.log('======================================================');
