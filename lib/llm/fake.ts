/**
 * Deterministic stand-in for a provider, used in tests. Lets the cache layer be tested
 * completely without a network, a key, or a bill.
 */
import type { LlmClient, LlmRequest, LlmResponse } from './types.js';
import { promptHash } from './cache.js';

export class FakeClient implements LlmClient {
  calls = 0;
  constructor(private readonly reply: (req: LlmRequest) => Partial<LlmResponse> = () => ({})) {}
  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.calls++;
    const r = this.reply(req);
    return {
      text: r.text ?? `reply#${this.calls}`,
      provider: 'fake',
      tool_calls: r.tool_calls ?? [],
      model: req.model,
      usage: r.usage ?? { input_tokens: 10, output_tokens: 5 },
      prompt_hash: promptHash(req),
      cache_hit: false,
    };
  }
}
