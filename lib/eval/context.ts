/**
 * The evaluator context used by every entry point.
 *
 * Judged metrics need a model. Building the client in one place means the server, the
 * runner, the demo and the calibration all judge the same way — and all replay from the
 * same cache, so a reviewer with no key still sees the judged verdicts that were
 * recorded rather than a row of blanks.
 */
import { CachingClient, type LlmMode } from '../llm/client.js';
import { OpenAiClient } from '../llm/openai.js';
import type { EvaluatorContext } from './types.js';

export function evaluatorContext(mode: LlmMode = (process.env.LLM_MODE as LlmMode) ?? 'replay'): EvaluatorContext {
  const provider =
    mode === 'live'
      ? new OpenAiClient()
      : { async complete() { throw new Error('replay mode: judged metric not recorded'); } };
  return { llmClient: new CachingClient(provider as never, mode) };
}
