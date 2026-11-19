/**
 * Dev entry: `npx tsx tests/agent_loop/run_suite.ts <suite> [outFile]` runs one Electron suite and prints/saves its JSON.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runElectronSuite } from './launch.js';

async function main() {
  const [suite, outFile] = process.argv.slice(2);
  const result = await runElectronSuite(suite);
  const json = JSON.stringify(result, null, 2);
  if (outFile) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, json + '\n');
  }
  console.log(json);
}

main().catch(err => { console.error(err); process.exit(1); });
