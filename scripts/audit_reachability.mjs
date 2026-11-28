import fs from 'node:fs';
import path from 'node:path';

export function getImports(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const rawCode = fs.readFileSync(filePath, 'utf8');

  // Strip type-only imports and exports:
  // e.g. import type { Foo } from './foo.js' or export type { Bar } from './bar.js'
  const code = rawCode.replace(/(?:import|export)\s+type\s+[\s\S]*?from\s+['"][^'"]+['"];?/g, '');

  const targets = [];

  // 1. Static imports and re-exports with from: import ... from '...' or export ... from '...'
  const fromMatches = [...code.matchAll(/(?:import|export)\s+[\s\S]*?from\s+['"](\.[^'"]+)['"]/g)];
  for (const m of fromMatches) {
    targets.push(m[1]);
  }

  // 2. Bare side-effect imports: import './side-effect.js'
  const bareMatches = [...code.matchAll(/(?:^|\n)\s*import\s+['"](\.[^'"]+)['"]/g)];
  for (const m of bareMatches) {
    targets.push(m[1]);
  }

  // 3. Dynamic imports: import('./dynamic.js')
  const dynamicMatches = [...code.matchAll(/import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g)];
  for (const m of dynamicMatches) {
    targets.push(m[1]);
  }

  const resolved = [];
  const dir = path.dirname(filePath);

  for (let target of targets) {
    if (target.endsWith('.js')) target = target.slice(0, -3);
    const resolvedPath = path.resolve(dir, target);

    if (fs.existsSync(resolvedPath + '.ts')) {
      resolved.push(resolvedPath + '.ts');
    } else if (fs.existsSync(resolvedPath + '.js')) {
      resolved.push(resolvedPath + '.js');
    } else if (fs.existsSync(path.join(resolvedPath, 'index.ts'))) {
      resolved.push(path.join(resolvedPath, 'index.ts'));
    } else if (fs.existsSync(path.join(resolvedPath, 'index.js'))) {
      resolved.push(path.join(resolvedPath, 'index.js'));
    } else {
      resolved.push(resolvedPath);
    }
  }

  return [...new Set(resolved)];
}

export function auditReachability(srcDir = path.resolve('src'), entryPoints = [
  path.resolve('src/main/index.ts'),
  path.resolve('src/main/preload.ts'),
  path.resolve('src/renderer/app.ts'),
  path.resolve('src/main/presence_preload.ts'),
  path.resolve('src/renderer/presence.ts'),
  path.resolve('src/renderer/lab.ts')
]) {
  const reachable = new Set();
  const queue = [...entryPoints];

  while (queue.length > 0) {
    const current = queue.shift();
    if (reachable.has(current)) continue;
    reachable.add(current);

    if (fs.existsSync(current)) {
      for (const imp of getImports(current)) {
        if (!reachable.has(imp)) queue.push(imp);
      }
    }
  }

  function getAllFiles(dir) {
    let results = [];
    if (!fs.existsSync(dir)) return results;
    for (const file of fs.readdirSync(dir)) {
      const full = path.join(dir, file);
      if (fs.statSync(full).isDirectory()) {
        results.push(...getAllFiles(full));
      } else if (full.endsWith('.ts') || full.endsWith('.js')) {
        results.push(full);
      }
    }
    return results;
  }

  const allSrc = getAllFiles(srcDir).sort((a, b) => a.localeCompare(b));
  const reachableCount = [...reachable].filter((f) => f.startsWith(srcDir)).length;

  const report = allSrc
    .map((f) => {
      const isReachable = reachable.has(f);
      const rel = path.relative(srcDir, f).replace(/\\/g, '/');
      return { path: rel, isReachable };
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  return { allSrc, reachableCount, report };
}

// CLI runner
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve('scripts/audit_reachability.mjs')) {
  const { allSrc, reachableCount, report } = auditReachability();

  console.log(`Total modules: ${allSrc.length}`);
  console.log(`Reachable modules: ${reachableCount}`);
  console.log(`Orphaned modules: ${allSrc.length - reachableCount}`);

  fs.writeFileSync('docs/reachability_audit.json', JSON.stringify(report, null, 2), 'utf8');
  console.log('Saved audit report to docs/reachability_audit.json');

  if (process.argv.includes('--check')) {
    const allowlistPath = path.resolve('scripts/reachability_allowlist.json');
    let allowlist = { testOnly: [], attic: [], pending: {} };
    if (fs.existsSync(allowlistPath)) {
      allowlist = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));
    }

    const allowedSet = new Set([
      ...(allowlist.testOnly || []),
      ...(allowlist.attic || []),
      ...Object.keys(allowlist.pending || {})
    ]);

    const orphanedModules = report.filter((m) => !m.isReachable).map((m) => m.path);
    const unallowlisted = orphanedModules.filter((p) => !allowedSet.has(p));

    if (unallowlisted.length > 0) {
      console.error(`ERROR: ${unallowlisted.length} unallowlisted orphaned modules:`);
      for (const u of unallowlisted) {
        console.error(`  - ${u}`);
      }
      process.exit(1);
    }

    console.log('✓ All orphaned modules are strictly accounted for in allowlist.');
    process.exit(0);
  }
}
