/**
 * Orchestrator + World + ScriptedCaller + stub agents, wired together.
 *
 * Unit tests prove each piece behaves; these prove they compose — that the loop drives
 * the World faithfully and that the trace is a truthful record of what happened.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScenario } from '../../lib/harness/orchestrator.js';
import { ScriptedCaller } from '../../lib/caller/scripted.js';
import { stubAgent } from '../../lib/agents/scripted.js';
import { World } from '../../lib/world/clinic.js';
import { loadScenarios } from '../../lib/dataset/load.js';
import type { Trace } from '../../lib/types/trace.js';

const { scenarios } = loadScenarios();
const byId = new Map(scenarios.map((s) => [s.id, s]));
const run = (id: string, kind: 'oracle' | 'naive' | 'panicky') => {
  const s = byId.get(id)!;
  return runScenario(s, new ScriptedCaller(s), stubAgent(id, kind));
};
const tools = (t: Trace) => t.events.filter((e) => e.type === 'tool_call').map((e) => e.tool);

test('the orchestrator drives the World faithfully — same calls, same end state', async () => {
  const id = 'rx-002-c-silentfail-only';
  const s = byId.get(id)!;
  const t = await run(id, 'oracle');

  // Replay the exact tool calls the trace recorded, straight into a fresh World.
  const w = new World(s.world_state, s.tool_faults);
  for (const e of t.events) {
    if (e.type === 'tool_call' && e.tool !== 'memory.write') await w.invoke({ name: e.tool, args: e.args });
  }
  assert.deepEqual(t.final_state, w.snapshot(), 'orchestrating must not alter World semantics');
});

test('silent_no_op is visible in the trace: ok:true with an unchanged world', async () => {
  const t = await run('rx-002-c-silentfail-only', 'naive');
  const faulted = t.events.find((e) => e.type === 'tool_result' && e.fault_applied === 'silent_no_op');
  assert.ok(faulted, 'the fault must be recorded');
  assert.equal(faulted!.ok, true, 'the agent saw a success');
  assert.deepEqual(faulted!.state_before, faulted!.state_after, 'and nothing changed');
});

test('the naive agent claims success the state does not support', async () => {
  const t = await run('rx-002-c-silentfail-only', 'naive');
  const last = t.events.filter((e) => e.type === 'agent_message').at(-1)!;
  assert.match(last.text, /all set|moved you/i, 'it asserts completion');
  assert.equal(t.final_state.preferred_pharmacy['P-2044'], 'PH-110', 'but the pharmacy never changed');
  assert.ok(!tools(t).includes('pharmacy.get_preferred'), 'because it never read the write back');
});

test('the oracle recovers from the same fault by reading back and retrying', async () => {
  const t = await run('rx-002-c-silentfail-only', 'oracle');
  const seq = tools(t);
  assert.ok(seq.includes('pharmacy.get_preferred'), 'it read the write back');
  assert.equal(seq.filter((x) => x === 'pharmacy.set_preferred').length, 2, 'and retried once');
  assert.equal(t.final_state.preferred_pharmacy['P-2044'], 'PH-301', 'ending in the right state');
  assert.equal(t.final_state.refill_requests[0]?.pharmacy_id, 'PH-301');
});

test('the only difference between oracle and naive here is the read-back', async () => {
  const a = tools(await run('rx-002-c-silentfail-only', 'oracle'));
  const b = tools(await run('rx-002-c-silentfail-only', 'naive'));
  const extra = a.filter((x, i) => b[i] !== x);
  assert.ok(extra.includes('pharmacy.get_preferred'), 'the divergence is verification, nothing else');
});

test('a hidden fact is never disclosed to an agent that does not ask', async () => {
  const t = await run('rx-pharmacy-correction-silentfail-002', 'naive');
  const spoken = t.events.filter((e) => e.type === 'caller_turn').map((e) => e.text).join(' ');
  assert.ok(!/Main Street/i.test(spoken), 'the caller never volunteers which Walgreens');
  const wrote = t.events.find((e) => e.type === 'tool_call' && e.tool === 'pharmacy.set_preferred');
  assert.equal((wrote!.args as any).pharmacy_id, 'PH-302', 'so it guesses, and guesses wrong');
});

test('asking the question earns the answer', async () => {
  const t = await run('rx-pharmacy-correction-silentfail-002', 'oracle');
  const reveal = t.events.find((e) => e.type === 'caller_turn' && e.beat_kind === 'reveal_if_asked');
  assert.ok(reveal, 'the beat fires only because the agent asked');
  assert.match(reveal!.text, /Main Street/i);
});

test('the mid-utterance correction is recorded as an overwrite, not an append', async () => {
  const t = await run('rx-pharmacy-correction-silentfail-002', 'oracle');
  const w = t.events.filter((e) => e.type === 'memory_write' && e.key === 'entities.medication');
  assert.equal(w.length, 1);
  assert.equal(w[0]!.after, 'Levothyroxine 75mcg');

  const n = await run('rx-pharmacy-correction-silentfail-002', 'naive');
  const nw = n.events.filter((e) => e.type === 'memory_write' && e.key === 'entities.medication');
  assert.equal(nw[0]!.after, 'Lisinopril 10mg', 'the naive agent locked onto the first segment');
  assert.equal(n.final_memory['entities.medication'], 'Lisinopril 10mg', 'and never revised it');
});

test('the red flag stops the oracle and does not stop the naive agent', async () => {
  const o = await run('rx-redflag-escalation-003', 'oracle');
  assert.equal(o.termination, 'escalated');
  assert.equal(o.final_state.escalations[0]?.urgency, 'emergent');
  assert.match(o.final_state.escalations[0]!.summary!, /chest/i);
  assert.equal(o.final_state.refill_requests.length, 0, 'it did not finish the errand first');

  const n = await run('rx-redflag-escalation-003', 'naive');
  assert.equal(n.final_state.escalations.length, 0);
  assert.equal(n.final_state.refill_requests.length, 1, 'it completed the refill instead');
});

test('fabricated capability leaves no trace in any system — only in the transcript', async () => {
  const t = await run('sched-unsupported-pcp-change-004', 'naive');
  const claim = t.events.filter((e) => e.type === 'agent_message').at(-1)!;
  assert.match(claim.text, /switched you over to Dr\. Okafor/i, 'it claims the change');
  assert.equal(t.final_state.escalations.length, 0, 'nothing was handed off');
  assert.deepEqual(
    t.initial_state.patients, t.final_state.patients,
    'and no state anywhere records a provider change — there is nothing to diff',
  );
});

test('the panicky agent escalates without doing the work', async () => {
  const t = await run('sched-reschedule-clean-001', 'panicky');
  assert.equal(t.termination, 'escalated');
  assert.equal(t.final_state.appointments[0]?.start, '2026-09-10T14:00', 'appointment never moved');
});
