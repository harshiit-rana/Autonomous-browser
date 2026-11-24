import * as fs from 'node:fs';
import { IModelProvider, ModelRequest, ModelResponse } from '../types.js';
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
  return withRefPlaceholders(new ScriptedModelProvider(script));
}

/**
 * A script cannot know element refs (`e1`...), which are assigned per observation. A string argument `{{ref:Place order}}`
 * is replaced by the ref of the element whose accessible name contains that text in the LAST observation the loop sent;
 * with no such element the placeholder stays and the tool call fails like any bad ref. Test tooling only.
 */
function withRefPlaceholders(inner: IModelProvider): IModelProvider {
  const lastObservation = (req: ModelRequest): string => {
    for (let i = req.messages.length - 1; i >= 0; i--) {
      const m = req.messages[i];
      if (m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[Page State - Isolated')) return m.content;
    }
    return '';
  };
  const resolve = (v: any, obs: string): any => {
    if (typeof v === 'string') {
      return v.replace(/\{\{ref:([^}]+)\}\}/g, (whole, name: string) => {
        for (const line of obs.split('\n')) {
          const m = line.match(/^\[(e\d+)\] .*"([^"]*)"/);
          if (m && m[2].includes(name.trim())) return m[1];
        }
        return whole;
      });
    }
    if (Array.isArray(v)) return v.map(x => resolve(x, obs));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x, obs)]));
    return v;
  };
  return {
    providerName: inner.providerName,
    modelName: inner.modelName,
    async generate(req: ModelRequest): Promise<ModelResponse> {
      const res = await inner.generate(req);
      const obs = lastObservation(req);
      return { ...res, toolCalls: res.toolCalls.map(c => ({ ...c, arguments: resolve(c.arguments, obs) })) };
    }
  };
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
