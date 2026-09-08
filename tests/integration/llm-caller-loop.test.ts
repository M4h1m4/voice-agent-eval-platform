/**
 * The LLM caller driven through the real orchestrator against the real World, with a
 * fake model standing in for the provider. Proves the swap is transparent: the harness
 * cannot tell which caller it is driving.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScenario } from '../../lib/harness/orchestrator.js';
import { ScriptedCaller } from '../../lib/caller/scripted.js';
import { LlmCaller } from '../../lib/caller/llm.js';
import { stubAgent } from '../../lib/agents/scripted.js';
import { loadScenarios } from '../../lib/dataset/load.js';
import { Trace } from '../../lib/types/trace.js';
import type { LlmRequest } from '../../lib/llm/types.js';

const { scenarios } = loadScenarios();
const byId = new Map(scenarios.map((s) => [s.id, s]));

const canned = () => ({
  async complete(req: LlmRequest) {
    const direction = String((req.messages.at(-1) as { content: string }).content);
    return {
      text: `[spoken] ${direction.replace('[direction] ', '').slice(0, 80)}`,
      tool_calls: [], model: req.model,
      usage: { input_tokens: 20, output_tokens: 8 }, prompt_hash: 'h', cache_hit: false,
    };
  },
});

test('a run driven by the LLM caller produces a schema-valid trace', async () => {
  for (const s of scenarios) {
    const t = await runScenario(s, new LlmCaller(s, canned()), stubAgent(s.id, 'oracle'));
    const r = Trace.safeParse(t);
    assert.ok(r.success, `${s.id}: ${r.success ? '' : r.error.issues[0]!.message}`);
    assert.notEqual(t.termination, 'harness_error');
  }
});

test('swapping the caller changes the words, never the beats or the world', async () => {
  for (const s of scenarios) {
    const scripted = await runScenario(s, new ScriptedCaller(s), stubAgent(s.id, 'oracle'));
    const llm = await runScenario(s, new LlmCaller(s, canned()), stubAgent(s.id, 'oracle'));

    const beats = (t: typeof scripted) =>
      t.events.filter((e) => e.type === 'caller_turn').map((e) => [e.beat_kind, e.beat_index, e.segment_index]);
    assert.deepEqual(beats(scripted), beats(llm), `${s.id}: beat sequence diverged`);
    assert.deepEqual(scripted.final_state, llm.final_state, `${s.id}: world diverged`);
    assert.equal(scripted.termination, llm.termination);

    const words = (t: typeof scripted) => t.events.filter((e) => e.type === 'caller_turn').map((e) => e.text);
    assert.notDeepEqual(words(scripted), words(llm), 'but the wording should differ');
  }
});

test('the hidden fact stays out of the transcript when the agent never asks', async () => {
  const s = byId.get('rx-pharmacy-correction-silentfail-002')!;
  const t = await runScenario(s, new LlmCaller(s, canned()), stubAgent(s.id, 'naive'));
  const spoken = t.events.filter((e) => e.type === 'caller_turn').map((e) => e.text).join(' ');
  assert.ok(!/Main St/i.test(spoken), 'the trap survives an LLM caller');
});

test('pauses between segments still advance the virtual clock', async () => {
  const s = byId.get('rx-pharmacy-correction-silentfail-002')!;
  const t = await runScenario(s, new LlmCaller(s, canned()), stubAgent(s.id, 'oracle'));
  const segs = t.events.filter((e) => e.type === 'caller_turn' && e.segment_index !== undefined);
  assert.equal(segs.length, 2);
  const between = segs[1]!.start_time - segs[0]!.end_time;
  assert.ok(between >= 900, `expected the 900ms pause to be reflected, saw ${between}`);
});

test('every model call the caller makes lands in the trace as an llm_call event', async () => {
  // The D19 gap: the agent and caller own the LLM client, only the orchestrator owns
  // the trace. Without the recorder seam a run made model calls that left no record.
  const { CachingClient, LlmRecorder } = await import('../../lib/llm/client.js');
  const { FakeClient } = await import('../../lib/llm/fake.js');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'llmrec-'));
  const rec = new LlmRecorder();
  const client = new CachingClient(new FakeClient(), 'live', dir, rec.observe);
  const s = byId.get('sched-reschedule-clean-001')!;

  const t = await runScenario(s, new LlmCaller(s, client), stubAgent(s.id, 'oracle'), { llm: rec });
  const calls = t.events.filter((e) => e.type === 'llm_call');
  const turns = t.events.filter((e) => e.type === 'caller_turn');

  assert.equal(calls.length, turns.length, 'one model call per caller utterance');
  for (const c of calls) {
    assert.equal(c.actor, 'caller');
    assert.equal(c['gen_ai.system'], 'fake');
    assert.equal(c['gen_ai.request.temperature'], 0);
    assert.ok(c['gen_ai.usage.input_tokens']! > 0, 'token usage is carried through');
    assert.match(c.prompt_hash, /^[0-9a-f]{8,}$/);
  }
  assert.ok(Trace.safeParse(t).success);
  rmSync(dir, { recursive: true });
});

test('an llm_call is recorded before the turn it produced', async () => {
  const { CachingClient, LlmRecorder } = await import('../../lib/llm/client.js');
  const { FakeClient } = await import('../../lib/llm/fake.js');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'llmrec2-'));
  const rec = new LlmRecorder();
  const s = byId.get('sched-reschedule-clean-001')!;
  const t = await runScenario(
    s, new LlmCaller(s, new CachingClient(new FakeClient(), 'live', dir, rec.observe)),
    stubAgent(s.id, 'oracle'), { llm: rec },
  );
  const firstCall = t.events.findIndex((e) => e.type === 'llm_call');
  const firstTurn = t.events.findIndex((e) => e.type === 'caller_turn');
  assert.ok(firstCall < firstTurn, 'the call that generated the words precedes the words');
  rmSync(dir, { recursive: true });
});

test('runs without an LLM record no llm_call events', async () => {
  const s = byId.get('sched-reschedule-clean-001')!;
  const t = await runScenario(s, new ScriptedCaller(s), stubAgent(s.id, 'oracle'));
  assert.equal(t.events.filter((e) => e.type === 'llm_call').length, 0);
});
