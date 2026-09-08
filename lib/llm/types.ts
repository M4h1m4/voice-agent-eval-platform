/**
 * Provider-agnostic LLM interface.
 *
 * Nothing above this file knows which vendor answered. Swapping providers is one
 * adapter; the cache, orchestrator, agent, caller, and evaluators are unaffected.
 * The friction in practice is tool-call shape — providers disagree on where tool calls
 * live in a response — so normalising that is this layer's real job.
 */

export type Actor = 'agent' | 'caller' | 'judge';

export type LlmToolDef = {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
};

export type LlmMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: LlmToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export type LlmToolCall = { id: string; name: string; args: Record<string, unknown> };

export type LlmRequest = {
  /** Keeps caller/agent/judge caches disjoint, so a prompt can never resolve across roles. */
  actor: Actor;
  model: string;
  temperature: number;
  system: string;
  messages: LlmMessage[];
  tools?: LlmToolDef[];
  max_tokens?: number;
  /**
   * Best-effort determinism hint, passed to the provider.
   *
   * It was previously threaded into run ids and traces and never reached a request, so
   * multiple seeds produced identical results while implying a variance control that
   * did not exist. Present-but-inert is worse than absent.
   *
   * Note what this does and does not buy: providers describe `seed` as best effort, not
   * a guarantee. Varying it gives us DIFFERENT samples, which is what a variance
   * estimate needs; it does not make any single sample reproducible. Reproducibility
   * still comes from the replay cache (D19).
   */
  seed?: number;
};

export type LlmResponse = {
  text: string;
  /** Fills OTel's `gen_ai.system` on the trace. Set by the adapter, not guessed above it. */
  provider: string;
  tool_calls: LlmToolCall[];
  model: string;
  usage: { input_tokens: number; output_tokens: number };
  /** Identifies the cache entry; recorded on the trace's llm_call event. */
  prompt_hash: string;
  cache_hit: boolean;
};

export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export class LlmError extends Error {}
