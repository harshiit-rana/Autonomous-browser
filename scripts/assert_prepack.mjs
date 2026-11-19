#!/usr/bin/env node
/**
 * Pre-pack assertions (#258): fail early, with a clear message, when the inputs to
 * electron-builder are incomplete. Runs as `npm run prepack:check` before every dist:* script.
 *
 * Checks:
 *  - package.json `main` exists in dist/ and the preload script exists next to it and is self-contained
 *    (a sandboxed preload cannot require relative modules)
 *  - dist/infrastructure/migrations contains the SQL migrations (db.ts resolves them next to the compiled JS)
 *  - dist/renderer/index.html exists (i.e. `vite build` ran) and every relative asset it
 *    references exists
 *  - build icons exist
 *  - on Windows, no packaged path would exceed MAX_PATH (long paths edge case)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Conservative budget: installers extract under <install dir>\resources\app.asar.unpacked\... */
export const WINDOWS_PATH_BUDGET = 240;

function walkLongest(dir, rel = '') {
  let longest = { length: rel.length, path: rel };
  if (!fs.existsSync(dir)) return longest;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const childRel = rel ? `${rel}\\${entry.name}` : entry.name;
    if (childRel.length > longest.length) longest = { length: childRel.length, path: childRel };
    if (entry.isDirectory()) {
      const sub = walkLongest(path.join(dir, entry.name), childRel);
      if (sub.length > longest.length) longest = sub;
    }
  }
  return longest;
}

/** Longest relative path (Windows separators) found under any of the given dirs of root. */
export function longestRelativePath(root, dirs) {
  let longest = { length: 0, path: '' };
  for (const d of dirs) {
    const r = walkLongest(path.join(root, d), d);
    if (r.length > longest.length) longest = r;
  }
  return longest;
}

export function collectProblems(root, { platform = process.platform, pathBudget = WINDOWS_PATH_BUDGET, installDirReserve = 80 } = {}) {
  const problems = [];
  const pkgPath = path.join(root, 'package.json');
  if (!fs.existsSync(pkgPath)) return [`package.json not found in ${root}`];
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

  // main + preload
  const main = pkg.main ? path.join(root, pkg.main) : null;
  if (!main || !fs.existsSync(main)) {
    problems.push(`package.json "main" (${pkg.main ?? 'unset'}) does not exist. Run \`npm run build:ts\` (tsc -b) first.`);
  } else {
    const preload = path.join(path.dirname(main), 'preload.js');
    if (!fs.existsSync(preload)) {
      problems.push(`Missing ${path.relative(root, preload)}: the sandboxed chrome window cannot start without its preload.`);
    } else if (/require\(\s*["']\.{1,2}\//.test(fs.readFileSync(preload, 'utf8'))) {
      problems.push(`${path.relative(root, preload)} still requires relative modules; a sandboxed preload cannot load them (window.aegis would be undefined). Run "npm run build" (scripts/bundle_preload.mjs).`);
    }
  }

  // SQL migrations copied by scripts/copy_assets.mjs
  const migrations = path.join(root, 'dist', 'infrastructure', 'migrations');
  const hasSqlSources = fs.existsSync(path.join(root, 'src', 'infrastructure', 'migrations'));
  if (hasSqlSources && !(fs.existsSync(migrations) && fs.readdirSync(migrations).some((f) => f.endsWith('.sql')))) {
    problems.push('dist/infrastructure/migrations has no .sql files: run `npm run build` (scripts/copy_assets.mjs).');
  }

  // renderer bundle
  const rendererIndex = path.join(root, 'dist', 'renderer', 'index.html');
  if (!fs.existsSync(rendererIndex)) {
    problems.push('dist/renderer/index.html is missing: the renderer bundle was not built. Run `npm run build` (tsc -b && vite build), not just `build:ts`.');
  } else {
    const html = fs.readFileSync(rendererIndex, 'utf8');
    const refs = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"'#?]+)["']/g)].map((m) => m[1]);
    for (const ref of refs) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//')) continue;
      if (!fs.existsSync(path.resolve(path.dirname(rendererIndex), ref))) {
        problems.push(`dist/renderer/index.html references ${ref} which does not exist.`);
      }
    }
    if (refs.some((r) => r.endsWith('.ts'))) {
      problems.push('dist/renderer/index.html still references a .ts file: it is the unbundled source, not the vite output.');
    }
  }

  // icons
  const iconDir = path.join(root, 'build');
  for (const icon of ['icon.ico', 'icon.icns', 'icon.png']) {
    if (!fs.existsSync(path.join(iconDir, icon))) problems.push(`build/${icon} is missing (regenerate with \`npm run icons\`).`);
  }

  // Windows long paths
  if (platform === 'win32') {
    const longest = longestRelativePath(root, ['dist', 'node_modules']);
    if (longest.length + installDirReserve > pathBudget) {
      problems.push(
        `Longest packaged path is ${longest.length} chars (+${installDirReserve} for the install dir) which exceeds the ${pathBudget}-char Windows budget: ${longest.path}. ` +
          'Enable Windows long paths (LongPathsEnabled=1) or build from a shorter directory.'
      );
    }
  }
  return problems;
}

export function assertPrepack(root, options) {
  const problems = collectProblems(root, options);
  if (problems.length) {
    throw new Error(`Pre-pack check failed:\n  - ${problems.join('\n  - ')}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  try {
    assertPrepack(root);
    console.log('Pre-pack check passed: dist/main, dist/renderer and build icons are present.');
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
