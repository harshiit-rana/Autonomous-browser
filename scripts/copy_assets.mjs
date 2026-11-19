#!/usr/bin/env node
/**
 * tsc only emits .ts files. Copy non-TypeScript runtime assets (SQL migrations) next to the compiled JS so
 * `dist/infrastructure/migrations/*.sql` exists for the packaged app (db.ts resolves them relative to __dirname).
 */
import fs from 'node:fs';
import path from 'node:path';

const pairs = [['src/infrastructure/migrations', 'dist/infrastructure/migrations']];
for (const [from, to] of pairs) {
  fs.mkdirSync(to, { recursive: true });
  for (const f of fs.readdirSync(from).filter(n => n.endsWith('.sql'))) {
    fs.copyFileSync(path.join(from, f), path.join(to, f));
  }
  console.log(`copied ${from} -> ${to}`);
}
