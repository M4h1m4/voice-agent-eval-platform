/**
 * ASR corruption driven through the real orchestrator.
 *
 * The property that matters: the agent receives the corrupted words while the trace
 * still records what the caller meant. Without both, ground truth is corrupted along
 * with the input and the scenario becomes unscoreable — the evaluator would be
 * comparing against the very error it is meant to detect.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScenario } from '../../lib/harness/orchestrator.js';
import { ScriptedCaller } from '../../lib/caller/scripted.js';
import { stubAgent } from '../../lib/agents/scripted.js';
import { loadScenarios } from '../../lib/dataset/load.js';
import { evaluateTrace } from '../../lib/eval/registry.js';
import { Trace } from '../../lib/types/trace.js';

const { scenarios, policies } = loadScenarios();
const S = scenarios.find((x) => x.id === 'rx-002-d-asr-drugname')!;
const run = (kind: 'oracle' | 'naive') => runScenario(S, new ScriptedCaller(S), stubAgent(S.id, kind));

test('the agent hears the corrupted word; the trace keeps what the caller said', async () => {
  const t = await run('naive');
  const turn = t.events.find((e) => e.type === 'caller_turn' && e.asr_fault)!;
  assert.ok(turn, 'the fault must be recorded on the turn it corrupted');
  assert.match(turn.text, /hydroxyzine/i, 'what the agent received — a different real drug');
  assert.match(String(turn.text_intended), /hydralazine/i, 'what the caller meant');
  assert.notEqual(turn.text, turn.text_intended);
  assert.equal(turn.asr_fault, 'asr_substitution');
  assert.ok(Trace.safeParse(t).success);
});

test('only the targeted beat is corrupted', async () => {
  const t = await run('naive');
  const corrupted = t.events.filter((e) => e.type === 'caller_turn' && e.asr_fault);
  assert.equal(corrupted.length, 1);
  assert.equal(corrupted[0]!.beat_index, 0);
});

test('an uncorrupted turn carries no text_intended — absence means "not corrupted"', async () => {
  const t = await run('naive');
  for (const e of t.events) {
    if (e.type !== 'caller_turn') continue;
    if (e.asr_fault) continue;
    assert.equal(e.text_intended, undefined, 'a clean turn must not carry a phantom ground truth');
  }
});

test('an agent that proceeds on what it heard fails on the entity', async () => {
  // Ground truth is the scenario, not the transcript, so the mis-heard name is wrong
  // even though the conversation reads perfectly competent.
  const t = await run('naive');
  const req = t.events.find((e) => e.type === 'tool_call' && e.tool === 'refill.request')!;
  assert.equal((req.args as { medication: string }).medication, 'Hydroxyzine 25mg');
  const r = await evaluateTrace(S, t, policies);
  assert.equal(r.overall_verdict, 'fail');
  assert.ok(r.metrics.some((m) => m.verdict === 'fail'), 'the corruption must surface as a failing metric');
});

test('an agent that reads the name back recovers, so the fault is fair', async () => {
  // The bar for an honest fault: a careful agent had a signal available. Here that
  // signal is NOT the record — both drugs are on file, so a lookup resolves the wrong
  // one cleanly. The only recovery is confirming with the caller.
  const t = await run('oracle');
  const r = await evaluateTrace(S, t, policies);
  assert.equal(r.overall_verdict, 'pass', 'an unpassable fault teaches nothing');
  const asked = t.events.filter((e) => e.type === 'agent_message').some((e) => e.text.includes('?'));
  assert.ok(asked, 'the oracle confirms rather than guessing');
});

test('the mis-heard drug resolves cleanly, so no downstream check can catch the swap', async () => {
  // This is what makes the real confusion dangerous and the first version of this
  // scenario (a one-character misspelling) nearly worthless: nothing errors.
  const t = await run('naive');
  assert.ok(t.initial_state.medications.some((m) => m.name === 'Hydroxyzine 25mg'), 'both drugs are on file');
  const res = t.events.find((e) => e.type === 'tool_result' && e.tool === 'refill.request')!;
  assert.equal(res.ok, true, 'the refill for the WRONG drug succeeds');
  assert.equal(t.final_state.refill_requests[0]!.medication, 'Hydroxyzine 25mg', 'and it is dispensed');
});
