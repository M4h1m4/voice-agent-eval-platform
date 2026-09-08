import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, promptHash, readCache, writeCache, cacheSize } from '../../lib/llm/cache.js';
import { CachingClient } from '../../lib/llm/client.js';
import { FakeClient } from '../../lib/llm/fake.js';
import { LlmError, type LlmRequest } from '../../lib/llm/types.js';

const fresh = () => mkdtempSync(join(tmpdir(), 'llmcache-'));
const req = (over: Partial<LlmRequest> = {}): LlmRequest => ({
  actor: 'agent',
  model: 'test-model',
  temperature: 0,
  system: 'you are a scheduling agent',
  messages: [{ role: 'user', content: 'move my appointment' }],
  ...over,
});

// --- canonical JSON --------------------------------------------------------

test('canonical JSON is insensitive to key order at every depth', () => {
  const a = { b: 1, a: { d: [1, { y: 2, x: 1 }], c: 3 } };
  const b = { a: { c: 3, d: [1, { x: 1, y: 2 }] }, b: 1 };
  assert.equal(canonical(a), canonical(b));
  assert.notEqual(JSON.stringify(a), JSON.stringify(b), 'plain stringify is not enough');
});

test('canonical JSON preserves array order — it is meaningful', () => {
  assert.notEqual(canonical([1, 2]), canonical([2, 1]));
});

test('canonical JSON distinguishes null, undefined-as-null, and absent', () => {
  assert.equal(canonical(null), 'null');
  assert.notEqual(canonical({ a: null }), canonical({}));
});

// --- hashing ---------------------------------------------------------------

test('the same request hashes the same regardless of how the object was built', () => {
  const a: LlmRequest = { actor: 'agent', model: 'm', temperature: 0, system: 's', messages: [{ role: 'user', content: 'x' }] };
  const b: LlmRequest = { messages: [{ content: 'x', role: 'user' }], system: 's', temperature: 0, model: 'm', actor: 'agent' } as LlmRequest;
  assert.equal(promptHash(a), promptHash(b));
});

test('every field that can change the response changes the hash', () => {
  const base = promptHash(req());
  assert.notEqual(base, promptHash(req({ model: 'other' })), 'model');
  assert.notEqual(base, promptHash(req({ temperature: 1 })), 'temperature');
  assert.notEqual(base, promptHash(req({ system: 'different' })), 'system prompt');
  assert.notEqual(base, promptHash(req({ actor: 'caller' })), 'actor');
  assert.notEqual(base, promptHash(req({ max_tokens: 50 })), 'max_tokens');
  assert.notEqual(
    base,
    promptHash(req({ tools: [{ name: 't', description: 'd', parameters: {} }] })),
    'tool definitions',
  );
});

test('history is hashed in full, so two conversations cannot collide on their last message', () => {
  // Hashing only the newest message would let replay return a fluent, plausible
  // response from the wrong conversation — worse than a crash, because it looks right.
  const shared = { role: 'user' as const, content: 'yes, go ahead' };
  const a = promptHash(req({ messages: [{ role: 'user', content: 'cancel it' }, shared] }));
  const b = promptHash(req({ messages: [{ role: 'user', content: 'book it' }, shared] }));
  assert.notEqual(a, b);
});

// --- cache read/write ------------------------------------------------------

test('a written entry reads back with the same response', async () => {
  const dir = fresh();
  const r = req();
  const res = await new FakeClient(() => ({ text: 'hello' })).complete(r);
  writeCache(r, res, dir);
  const hit = readCache(r, dir)!;
  assert.equal(hit.response.text, 'hello');
  assert.equal(hit.prompt_hash, promptHash(r));
  rmSync(dir, { recursive: true });
});

test('the stored entry keeps the prompt readable — a cache of opaque hashes is not reviewable', async () => {
  const dir = fresh();
  const r = req({ tools: [{ name: 'patients.verify', description: 'd', parameters: {} }] });
  writeCache(r, await new FakeClient().complete(r), dir);
  const hit = readCache(r, dir)!;
  assert.equal(hit.request.system, r.system);
  assert.deepEqual(hit.request.messages, r.messages);
  assert.deepEqual(hit.request.tools, ['patients.verify']);
  rmSync(dir, { recursive: true });
});

test('cache_hit is not stored — it describes how a response arrived, not what it was', async () => {
  const dir = fresh();
  const r = req();
  writeCache(r, await new FakeClient().complete(r), dir);
  assert.ok(!('cache_hit' in readCache(r, dir)!.response));
  rmSync(dir, { recursive: true });
});

test('actors have disjoint caches', async () => {
  const dir = fresh();
  const agent = req({ actor: 'agent' });
  writeCache(agent, await new FakeClient(() => ({ text: 'agent said' })).complete(agent), dir);
  assert.equal(readCache(req({ actor: 'caller' }), dir), null, 'a caller prompt must not hit an agent entry');
  rmSync(dir, { recursive: true });
});

test('a corrupt cache entry fails loudly', () => {
  const dir = fresh();
  const r = req();
  mkdirSync(join(dir, 'agent'), { recursive: true });
  writeFileSync(join(dir, 'agent', `${promptHash(r)}.json`), '{ nope', 'utf8');
  assert.throws(() => readCache(r, dir), (e: Error) => e instanceof LlmError && /corrupt/.test(e.message));
  rmSync(dir, { recursive: true });
});

// --- the caching client ----------------------------------------------------

test('live mode records once, then serves from cache without calling again', async () => {
  const dir = fresh();
  const inner = new FakeClient(() => ({ text: 'recorded' }));
  const c = new CachingClient(inner, 'live', dir);
  const first = await c.complete(req());
  const second = await c.complete(req());
  assert.equal(inner.calls, 1, 'the provider is called exactly once');
  assert.equal(first.cache_hit, false);
  assert.equal(second.cache_hit, true);
  assert.equal(second.text, 'recorded');
  rmSync(dir, { recursive: true });
});

test('replay mode serves recorded responses without any provider', async () => {
  const dir = fresh();
  await new CachingClient(new FakeClient(() => ({ text: 'from the recording' })), 'live', dir).complete(req());
  const inner = new FakeClient();
  const replay = new CachingClient(inner, 'replay', dir);
  const out = await replay.complete(req());
  assert.equal(out.text, 'from the recording');
  assert.equal(out.cache_hit, true);
  assert.equal(inner.calls, 0, 'replay must not touch the provider');
  rmSync(dir, { recursive: true });
});

test('a replay miss is a hard error, never a silent live call', async () => {
  // If a miss fell through, "replay" would quietly become "live": a reviewer with no
  // key fails deep inside a run, and anyone with a key gets an unannounced bill.
  const dir = fresh();
  const inner = new FakeClient();
  const c = new CachingClient(inner, 'replay', dir);
  await assert.rejects(() => c.complete(req()), (e: Error) => e instanceof LlmError && /replay miss/.test(e.message));
  assert.equal(inner.calls, 0);
  rmSync(dir, { recursive: true });
});

test('the replay-miss message names the actor and the hash', async () => {
  const dir = fresh();
  const c = new CachingClient(new FakeClient(), 'replay', dir);
  await assert.rejects(
    () => c.complete(req({ actor: 'judge' })),
    (e: Error) => e.message.includes('judge') && e.message.includes(promptHash(req({ actor: 'judge' })).slice(0, 12)),
  );
  rmSync(dir, { recursive: true });
});

test('any change to the prompt is a new cache key, and replay says so', async () => {
  const dir = fresh();
  await new CachingClient(new FakeClient(), 'live', dir).complete(req());
  const replay = new CachingClient(new FakeClient(), 'replay', dir);
  await assert.rejects(() => replay.complete(req({ system: 'edited prompt' })), /replay miss/);
  await assert.doesNotReject(() => replay.complete(req()), 'the original still resolves');
  rmSync(dir, { recursive: true });
});

test('cacheSize counts entries across actors', async () => {
  const dir = fresh();
  const c = new CachingClient(new FakeClient(), 'live', dir);
  await c.complete(req({ actor: 'agent' }));
  await c.complete(req({ actor: 'caller' }));
  await c.complete(req({ actor: 'caller', system: 'other' }));
  assert.equal(cacheSize(dir), 3);
  assert.equal(cacheSize(join(tmpdir(), 'no-such-cache-91xz')), 0);
  rmSync(dir, { recursive: true });
});

test('the observer fires on both a miss and a hit, so no model call escapes the trace', async () => {
  const dir = fresh();
  const seen: { hit: boolean; hash: string; tokens: number }[] = [];
  const observe = (_q: LlmRequest, r: { cache_hit: boolean; prompt_hash: string; usage: { input_tokens: number } }) =>
    void seen.push({ hit: r.cache_hit, hash: r.prompt_hash, tokens: r.usage.input_tokens });

  const live = new CachingClient(new FakeClient(), 'live', dir, observe);
  await live.complete(req());
  await live.complete(req());

  assert.equal(seen.length, 2);
  assert.deepEqual(seen.map((s) => s.hit), [false, true], 'miss then hit');
  assert.equal(seen[0]!.hash, promptHash(req()));
  assert.ok(seen[0]!.tokens > 0, 'usage is carried through for the gen_ai.* trace fields');
  rmSync(dir, { recursive: true });
});

test('the observer is optional — omitting it changes nothing', async () => {
  const dir = fresh();
  const c = new CachingClient(new FakeClient(), 'live', dir);
  assert.equal((await c.complete(req())).cache_hit, false);
  rmSync(dir, { recursive: true });
});

test('the seed is part of the cache key — two seeds are two different requests', async () => {
  // It used to be threaded into run ids and traces and never reach a request, so
  // multiple seeds produced byte-identical results while implying variance control
  // that did not exist.
  assert.notEqual(promptHash(req({ seed: 0 })), promptHash(req({ seed: 1 })));
  assert.notEqual(promptHash(req()), promptHash(req({ seed: 0 })), 'absent and 0 are different requests');
  assert.equal(promptHash(req({ seed: 7 })), promptHash(req({ seed: 7 })));
});
