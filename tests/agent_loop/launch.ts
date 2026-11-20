/**
 * Runs a suite inside a real Electron main process (see electron_main.cjs) and returns its JSON result.
 * Fails loudly when Electron cannot start: these suites are never skipped. On Linux CI run under `xvfb-run -a`.
 */
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = process.cwd();
const HERE = path.join(ROOT, 'tests', 'agent_loop');
const req = createRequire(path.join(ROOT, 'package.json'));

export async function runElectronSuite(suite: string, timeoutMs = 300_000): Promise<any> {
  const electronExe: string = req('electron');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const k of ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AEGIS_E2E_MODEL_MODE', 'AEGIS_E2E_SCRIPT']) delete env[k];
  const args = [path.join(HERE, 'electron_main.cjs'), `--suite=${suite}`];
  if (process.platform === 'linux') args.push('--no-sandbox');
  const child = spawn(electronExe, args, { env, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', d => { out += d.toString(); });
  child.stderr.on('data', d => { err += d.toString(); });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  const exit: number | null = await new Promise(resolve => child.on('close', c => resolve(c)));
  clearTimeout(timer);
  const line = out.split('\n').find(l => l.startsWith('__RESULT__'));
  if (!line) {
    throw new Error(`Electron suite "${suite}" produced no result (exit ${exit}). Electron must be able to start ` +
      `(Linux: xvfb-run -a). stderr tail:\n${err.slice(-3000)}\nstdout tail:\n${out.slice(-2000)}`);
  }
  const result = JSON.parse(line.slice('__RESULT__'.length));
  if (result.fatal) throw new Error(`Electron suite "${suite}" crashed: ${result.fatal}\nstderr tail:\n${err.slice(-2000)}`);
  return result;
}
