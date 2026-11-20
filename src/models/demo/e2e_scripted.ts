import * as fs from 'node:fs';
import { IModelProvider } from '../types.js';
import { ScriptedModelProvider, ScriptedStepResponse } from './scripted_provider.js';
import { rootLogger } from '../../infrastructure/logger.js';

const logger = rootLogger.child('e2e-scripted');

/**
 * Real-app e2e runs only: `AEGIS_E2E_MODEL_MODE=scripted` (optionally `AEGIS_E2E_SCRIPT=<json file>` holding an array of
 * `{ text?, toolCalls? }` steps). Loaded through a dynamic import from `ModelProviderFactory.createProvider`.
 */
export function createE2EScriptedProvider(): IModelProvider {
  const scriptPath = process.env.AEGIS_E2E_SCRIPT;
  const script: ScriptedStepResponse[] = scriptPath ? JSON.parse(fs.readFileSync(scriptPath, 'utf8')) : [];
  logger.warn('AEGIS_E2E_MODEL_MODE=scripted: model output comes from a script, not a model', { scriptPath, steps: script.length });
  return new ScriptedModelProvider(script);
}

/**
 * The completion verifier's script for real-app e2e runs (`AEGIS_E2E_VERIFIER_SCRIPT`, same format). A separate queue
 * so verifier answers never interleave with the actor's.
 */
export function createE2EScriptedVerifier(): IModelProvider {
  const scriptPath = process.env.AEGIS_E2E_VERIFIER_SCRIPT;
  const script: ScriptedStepResponse[] = scriptPath ? JSON.parse(fs.readFileSync(scriptPath, 'utf8')) : [];
  logger.warn('AEGIS_E2E_MODEL_MODE=scripted: verifier output comes from a script, not a model', { scriptPath, steps: script.length });
  return new ScriptedModelProvider(script);
}
