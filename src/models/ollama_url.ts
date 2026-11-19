/**
 * Ollama serves its native API at `<root>/api/*` and an OpenAI-compatible API at `<root>/v1/*`. The Settings field and
 * the stored default are the bare root (`http://localhost:11434`), but the OpenAI client needs the `/v1` base: without it
 * every chat call 404s (baseline defect D6). Users may also paste the `/v1` form, so both are accepted.
 */
export const DEFAULT_OLLAMA_ROOT = 'http://localhost:11434';

export function ollamaRootUrl(configured?: string): string {
  const trimmed = (configured || DEFAULT_OLLAMA_ROOT).trim().replace(/\/+$/, '');
  return trimmed.replace(/\/v1$/i, '') || DEFAULT_OLLAMA_ROOT;
}

export function ollamaOpenAIBaseUrl(configured?: string): string {
  return `${ollamaRootUrl(configured)}/v1`;
}
