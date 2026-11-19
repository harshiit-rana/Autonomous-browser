import fs from 'node:fs';
import path from 'node:path';

function getImports(filePath) {
  const code = fs.readFileSync(filePath, 'utf8');
  const matches = [...code.matchAll(/from\s+['"](\.[^'"]+)['"]/g)];
  return matches.map(m => {
    let target = m[1];
    if (target.endsWith('.js')) target = target.slice(0, -3);
    const dir = path.dirname(filePath);
    const resolved = path.resolve(dir, target);
    if (fs.existsSync(resolved + '.ts')) return resolved + '.ts';
    if (fs.existsSync(resolved + '.js')) return resolved + '.js';
    if (fs.existsSync(path.join(resolved, 'index.ts'))) return path.join(resolved, 'index.ts');
    return resolved;
  });
}

const reachable = new Set();
const entryPoints = [
  path.resolve('src/main/index.ts'),
  path.resolve('src/main/preload.ts'),
  path.resolve('src/renderer/app.ts')
];

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
  for (const file of fs.readdirSync(dir)) {
    const full = path.join(dir, file);
    if (fs.statSync(full).isDirectory()) results.push(...getAllFiles(full));
    else if (full.endsWith('.ts')) results.push(full);
  }
  return results;
}

const allSrc = getAllFiles(path.resolve('src')).sort((a, b) => a.localeCompare(b));
const reachableCount = [...reachable].filter(f => f.startsWith(path.resolve('src'))).length;
console.log(`Total modules: ${allSrc.length}`);
console.log(`Reachable modules: ${reachableCount}`);
console.log(`Orphaned modules: ${allSrc.length - reachableCount}`);

const report = allSrc.map(f => {
  const isReachable = reachable.has(f);
  const rel = path.relative('src', f).replace(/\\/g, '/');
  return { path: rel, isReachable };
}).sort((a, b) => a.path.localeCompare(b.path));

fs.writeFileSync('docs/reachability_audit.json', JSON.stringify(report, null, 2), 'utf8');
console.log('Saved audit report to docs/reachability_audit.json');
