#!/usr/bin/env node
/**
 * tsc only emits .ts files. Copy non-TypeScript runtime assets (SQL migrations) next to the compiled JS so
 * `dist/infrastructure/migrations/*.sql` exists for the packaged app (db.ts resolves them relative to __dirname).
 */
import fs from 'node:fs';
import path from 'node:path';

const pairs = [['src/infrastructure/migrations', 'dist/infrastructure/migrations']];

// Replay-demo transcripts (#224): fixtures/demo/*.json -> dist/fixtures/demo (resolved from dist/models/demo/ via __dirname)
fs.mkdirSync('dist/fixtures/demo', { recursive: true });
for (const f of fs.readdirSync('fixtures/demo').filter(n => n.endsWith('.json'))) {
  fs.copyFileSync(path.join('fixtures/demo', f), path.join('dist/fixtures/demo', f));
}
console.log('copied fixtures/demo -> dist/fixtures/demo');
for (const [from, to] of pairs) {
  fs.mkdirSync(to, { recursive: true });
  for (const f of fs.readdirSync(from).filter(n => n.endsWith('.sql'))) {
    fs.copyFileSync(path.join(from, f), path.join(to, f));
  }
  console.log(`copied ${from} -> ${to}`);
}
