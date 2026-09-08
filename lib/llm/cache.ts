/**
 * Prompt cache. This is the determinism mechanism, not a cost optimisation.
 *
 * Every component below this layer is deterministic, which is why the suite can assert
 * byte-identical traces. An LLM breaks that. Recording responses and replaying them is
 * what restores it — and it is what lets a reviewer run every LLM-backed result with no
 * API key and no bill.
 *
 * Note the honest limit: temperature 0 is NOT a determinism guarantee. Providers do not
 * promise identical outputs for identical inputs. Reproducibility here is a claim about
 * OUR RECORDED RUNS, never about the model.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { LlmRequest, LlmResponse } from './types.js';
import { LlmError } from './types.js';

export const CACHE_DIR = join('cache', 'llm');

/**
 * Stable JSON: keys sorted at every depth.
 *
 * Tool arguments and message objects arrive with arbitrary key order. Hashing
 * `JSON.stringify` directly would produce a different key for the same request
 * depending on how the object happened to be built — every replay would miss, and the
 * cache would silently degrade into a live client.
 */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

/**
 * Everything that can change the response goes into the key: model, temperature,
 * system prompt, the full message history, and the tool definitions.
 *
 * Hashing only the latest message would let two different conversations collide, and
 * replay would then return a fluent, plausible response from the wrong context — worse
 * than a crash, because nothing about it looks wrong.
 */
export function promptHash(req: LlmRequest): string {
  return createHash('sha256')
    .update(
      canonical({
        actor: req.actor,
        model: req.model,
        temperature: req.temperature,
        system: req.system,
        messages: req.messages,
        tools: req.tools ?? null,
        max_tokens: req.max_tokens ?? null,
        // In the key: two seeds are two different requests, and must not share an entry.
        seed: req.seed ?? null,
      }),
    )
    .digest('hex');
}

export type CacheEntry = {
  prompt_hash: string;
  actor: string;
  model: string;
  temperature: number;
  recorded_at: string;
  /** Kept for human inspection: a cache of opaque hashes is not reviewable. */
  request: { system: string; messages: unknown[]; tools?: string[] };
  response: Omit<LlmResponse, 'cache_hit'>;
};

const pathFor = (hash: string, actor: string, dir: string) => join(dir, actor, `${hash}.json`);

export function readCache(req: LlmRequest, dir = CACHE_DIR): CacheEntry | null {
  const hash = promptHash(req);
  const path = pathFor(hash, req.actor, dir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CacheEntry;
  } catch (e) {
    throw new LlmError(`cache entry ${hash.slice(0, 12)} is corrupt: ${(e as Error).message}`);
  }
}

export function writeCache(req: LlmRequest, res: LlmResponse, dir = CACHE_DIR): void {
  const hash = promptHash(req);
  const folder = join(dir, req.actor);
  if (!existsSync(folder)) mkdirSync(folder, { recursive: true });
  const entry: CacheEntry = {
    prompt_hash: hash,
    actor: req.actor,
    model: req.model,
    temperature: req.temperature,
    recorded_at: new Date().toISOString(),
    request: {
      system: req.system,
      messages: req.messages,
      ...(req.tools ? { tools: req.tools.map((t) => t.name) } : {}),
    },
    // `cache_hit` describes how a response was obtained, not what it was — storing it
    // would bake "this was a miss" into an entry that only ever serves hits.
    response: (({ cache_hit, ...rest }) => rest)(res),
  };
  const path = pathFor(hash, req.actor, dir);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(entry, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
}

export function cacheSize(dir = CACHE_DIR): number {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).reduce((n, actor) => {
    const sub = join(dir, actor);
    try {
      return n + readdirSync(sub).filter((f) => f.endsWith('.json')).length;
    } catch {
      return n;
    }
  }, 0);
}
