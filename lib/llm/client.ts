/**
 * The caching wrapper every LLM call goes through.
 *
 * Two modes, and the difference between them is the whole point of this layer:
 *
 *   live    call the provider, record the response
 *   replay  serve from the cache, NEVER touch the network
 *
 * A cache miss in replay mode is a hard error. If it silently fell through to a live
 * call, "replay" would quietly become "live": a reviewer with no key would fail deep
 * inside a run instead of at the first call, and anyone with a key would get an
 * unannounced bill. Failing at the miss also names exactly which prompt was never
 * recorded, which is the information you need.
 */
import type { LlmClient, LlmRequest, LlmResponse } from './types.js';
import { LlmError } from './types.js';
import { promptHash, readCache, writeCache, CACHE_DIR } from './cache.js';
import { OpenAiClient, DEFAULT_MODEL } from './openai.js';

export type LlmMode = 'live' | 'replay';

/**
 * Notified on every completion, hit or miss.
 *
 * `trace.ts` defines an `llm_call` event carrying `prompt_hash`, `cache_hit`, and token
 * usage, and nothing could produce one: the agent makes the calls, but only the
 * orchestrator writes the trace. This is the seam between them. Without it the trace
 * would silently omit every model interaction — the one part of a run a reviewer most
 * wants to inspect — and nothing would report the omission.
 */
export type LlmObserver = (req: LlmRequest, res: LlmResponse) => void;

export class CachingClient implements LlmClient {
  constructor(
    private readonly inner: LlmClient,
    private readonly mode: LlmMode,
    private readonly dir = CACHE_DIR,
    private readonly observe?: LlmObserver,
  ) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const hash = promptHash(req);
    const hit = readCache(req, this.dir);

    if (hit) {
      const res = { ...hit.response, prompt_hash: hash, cache_hit: true };
      this.observe?.(req, res);
      return res;
    }

    if (this.mode === 'replay') {
      throw new LlmError(
        `replay miss for ${req.actor} prompt ${hash.slice(0, 12)} — this exchange was never ` +
          `recorded. Re-run with LLM_MODE=live and an API key to record it, or check that ` +
          `the prompt has not changed since the cache was written (any edit to the system ` +
          `prompt, model, temperature, or history produces a different key).`,
      );
    }

    const res = await this.inner.complete(req);
    const stamped = { ...res, prompt_hash: hash, cache_hit: false };
    writeCache(req, stamped, this.dir);
    this.observe?.(req, stamped);
    return stamped;
  }
}

/**
 * Buffers model calls so the orchestrator can write them into the trace.
 *
 * The agent and caller own the LLM client; only the orchestrator owns the trace. This
 * is the seam between them. Without it a run makes model calls that leave no record —
 * the part of a run a reviewer most wants to inspect, missing, with nothing reporting
 * the omission.
 */
export class LlmRecorder {
  private buf: { req: LlmRequest; res: LlmResponse }[] = [];
  readonly observe: LlmObserver = (req, res) => void this.buf.push({ req, res });
  /** Returns everything recorded since the last drain, in call order. */
  drain(): { req: LlmRequest; res: LlmResponse }[] {
    const out = this.buf;
    this.buf = [];
    return out;
  }
}

/** Client that refuses to do anything — used when replay is expected to cover every call. */
class NoNetworkClient implements LlmClient {
  async complete(): Promise<LlmResponse> {
    throw new LlmError('no live client configured; replay mode expected a cache hit');
  }
}

/**
 * Default: replay. A missing LLM_MODE must never mean "spend money" — the safe default
 * is the one that cannot make a network call.
 */
export function createLlmClient(
  mode: LlmMode = (process.env.LLM_MODE as LlmMode) ?? 'replay',
  observe?: LlmObserver,
): LlmClient {
  return new CachingClient(mode === 'live' ? new OpenAiClient() : new NoNetworkClient(), mode, CACHE_DIR, observe);
}

export { DEFAULT_MODEL };
