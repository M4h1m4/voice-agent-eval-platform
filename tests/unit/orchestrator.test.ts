import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScenario } from '../../lib/harness/orchestrator.js';
import { ScriptedCaller } from '../../lib/caller/scripted.js';
import { loadScenarios } from '../../lib/dataset/load.js';
import { DEFAULT_LIMITS, type Agent, type AgentAction, type AgentContext, type Caller } from '../../lib/harness/types.js';

const { scenarios } = loadScenarios();
const byId = new Map(scenarios.map((s) => [s.id, s]));
const CLEAN = byId.get('sched-reschedule-clean-001')!;

/** Agent that yields a fixed plan then ends. */
const planned = (version: string, plan: AgentAction[]): Agent => {
  let i = 0;
  return { version, next: async () => plan[i++] ?? { kind: 'end' } };
};
/** Agent that never stops calling a tool — for limit testing. */
const looper = (call: AgentAction): Agent => ({ version: 'looper', next: async () => call });

// --- termination -----------------------------------------------------------

test('agent ending the call terminates as agent_ended', async () => {
  const t = await runScenario(CLEAN, new ScriptedCaller(CLEAN), planned('t', [{ kind: 'end' }]));
  assert.equal(t.termination, 'agent_ended');
});

test('an exhausted caller terminates as caller_hangup', async () => {
  const t = await runScenario(CLEAN, new ScriptedCaller(CLEAN), planned('t', [
    { kind: 'speak', text: 'a' }, { kind: 'speak', text: 'b' },
    { kind: 'speak', text: 'c' }, { kind: 'speak', text: 'd' },
  ]));
  assert.equal(t.termination, 'caller_hangup');
});

test('a caller that never stops trips maxTurns', async () => {
  const chatty: Caller = {
    next: async () => ({ text: 'still here', beat_kind: 'state_goal', beat_index: 0 }),
  };
  const t = await runScenario(CLEAN, chatty, planned('t', Array(50).fill({ kind: 'speak', text: 'ok' })), {
    limits: { maxTurns: 3 },
  });
  assert.equal(t.termination, 'max_turns');
  assert.equal(t.events.filter((e) => e.type === 'caller_turn').length, 3);
});

test('an agent thrashing on tools trips maxToolCallsPerTurn and records it as an outcome', async () => {
  const t = await runScenario(
    CLEAN,
    new ScriptedCaller(CLEAN),
    looper({ kind: 'tool', call: { name: 'appointments.list', args: { patient_id: 'P-1001' } } }),
    { limits: { maxToolCallsPerTurn: 4 } },
  );
  assert.equal(t.termination, 'max_tool_calls');
  assert.equal(t.events.filter((e) => e.type === 'tool_call').length, 4);
  const err = t.events.find((e) => e.type === 'error');
  assert.ok(err, 'the limit is recorded, not swallowed');
  assert.equal(err!.status, 'ERROR');
});

test('maxToolCallsTotal binds across turns, not just within one', async () => {
  const t = await runScenario(
    CLEAN,
    new ScriptedCaller(CLEAN),
    planned('t', [
      { kind: 'tool', call: { name: 'appointments.list', args: { patient_id: 'P-1001' } } },
      { kind: 'speak', text: 'one' },
      { kind: 'tool', call: { name: 'appointments.list', args: { patient_id: 'P-1001' } } },
      { kind: 'tool', call: { name: 'appointments.list', args: { patient_id: 'P-1001' } } },
    ]),
    { limits: { maxToolCallsPerTurn: 10, maxToolCallsTotal: 2 } },
  );
  assert.equal(t.termination, 'max_tool_calls');
  assert.equal(t.events.filter((e) => e.type === 'tool_call').length, 2);
});

test('a successful escalate makes the outcome escalated, not agent_ended', async () => {
  const esc = byId.get('rx-redflag-escalation-003')!;
  const t = await runScenario(esc, new ScriptedCaller(esc), planned('t', [
    { kind: 'tool', call: { name: 'escalate', args: { reason: 'r', urgency: 'emergent', summary: 's' } } },
    { kind: 'speak', text: 'transferring' },
    { kind: 'end' },
  ]));
  assert.equal(t.termination, 'escalated');
});

test('a FAILED escalate does not count as escalated', async () => {
  const t = await runScenario(CLEAN, new ScriptedCaller(CLEAN), planned('t', [
    { kind: 'tool', call: { name: 'escalate', args: { reason: 'r' } } }, // missing required args
    { kind: 'speak', text: 'hmm' },
    { kind: 'end' },
  ]));
  assert.equal(t.termination, 'agent_ended');
  assert.equal(t.final_state.escalations.length, 0);
});

// --- memory interception (D6) ---------------------------------------------

test('memory.write is intercepted: recorded as an event, never reaches the World', async () => {
  const t = await runScenario(CLEAN, new ScriptedCaller(CLEAN), planned('t', [
    { kind: 'tool', call: { name: 'memory.write', args: { key: 'entities.med', value: 'A', reason: 'first' } } },
    { kind: 'tool', call: { name: 'memory.write', args: { key: 'entities.med', value: 'B', reason: 'corrected' } } },
    { kind: 'speak', text: 'ok' },
    { kind: 'end' },
  ]));
  const writes = t.events.filter((e) => e.type === 'memory_write');
  assert.equal(writes.length, 2);
  assert.deepEqual([writes[0]!.before, writes[0]!.after], [null, 'A'], 'first write has no prior value');
  assert.deepEqual([writes[1]!.before, writes[1]!.after], ['A', 'B'], 'overwrite carries before/after');
  assert.equal(t.final_memory['entities.med'], 'B');
  assert.equal(t.events.filter((e) => e.type === 'tool_result').length, 0, 'no clinic tool_result for memory');
  assert.deepEqual(t.final_state, t.initial_state, 'the world is untouched');
});

test('memory_write is parented to its tool_call span', async () => {
  const t = await runScenario(CLEAN, new ScriptedCaller(CLEAN), planned('t', [
    { kind: 'tool', call: { name: 'memory.write', args: { key: 'k', value: 1, reason: 'r' } } },
    { kind: 'end' },
  ]));
  const call = t.events.find((e) => e.type === 'tool_call')!;
  const write = t.events.find((e) => e.type === 'memory_write')!;
  assert.equal(write.parent_span_id, call.span_id);
});

// --- actor isolation (D2) --------------------------------------------------

test('the caller never sees tool calls or results', async () => {
  let sawTools = false;
  let sawAgentSpeech = false;
  const inner = new ScriptedCaller(CLEAN);
  const spy: Caller = {
    next: async (ctx) => {
      for (const h of ctx.heard as { role: string }[]) {
        if (h.role === 'tool_call' || h.role === 'tool_result') sawTools = true;
        if (h.role === 'agent') sawAgentSpeech = true;
      }
      return inner.next(ctx);
    },
  };
  await runScenario(CLEAN, spy, planned('t', [
    { kind: 'tool', call: { name: 'patients.verify', args: { name: 'Dana Whitfield', dob: '1978-03-14' } } },
    { kind: 'speak', text: 'verified you' },
    { kind: 'end' },
  ]));
  assert.equal(sawTools, false, 'a caller that sees tool results has telepathy');
  assert.equal(sawAgentSpeech, true, 'but it must still hear the agent speak');
});

test('the agent does see tool calls and results', async () => {
  let roles = new Set<string>();
  const agent: Agent = {
    version: 't',
    next: async (ctx: AgentContext) => {
      for (const h of ctx.history) roles.add(h.role);
      return ctx.history.some((h) => h.role === 'tool_result')
        ? { kind: 'end' }
        : { kind: 'tool', call: { name: 'appointments.list', args: { patient_id: 'P-1001' } } };
    },
  };
  await runScenario(CLEAN, new ScriptedCaller(CLEAN), agent);
  assert.ok(roles.has('tool_call') && roles.has('tool_result'));
});

// --- trace integrity -------------------------------------------------------

test('every event shares the trace id and seq is dense from zero', async () => {
  const t = await runScenario(CLEAN, new ScriptedCaller(CLEAN), planned('t', [
    { kind: 'tool', call: { name: 'appointments.list', args: { patient_id: 'P-1001' } } },
    { kind: 'speak', text: 'ok' },
    { kind: 'end' },
  ]));
  assert.ok(t.events.length > 0);
  t.events.forEach((e, i) => {
    assert.equal(e.trace_id, t.trace_id);
    assert.equal(e.seq, i);
  });
});

test('a failing tool is recorded with status ERROR and the world is unchanged', async () => {
  const t = await runScenario(CLEAN, new ScriptedCaller(CLEAN), planned('t', [
    { kind: 'tool', call: { name: 'appointments.reschedule', args: { appointment_id: 'A-9999', new_start: '2026-09-15T09:30' } } },
    { kind: 'speak', text: 'that did not work' },
    { kind: 'end' },
  ]));
  const res = t.events.find((e) => e.type === 'tool_result')!;
  assert.equal(res.ok, false);
  assert.equal(res.status, 'ERROR');
  assert.deepEqual(res.state_before, res.state_after);
});

test('the trace records the limits the run executed under', async () => {
  // A verdict can depend on them: the v2 write loop ended on a different slot at a
  // cap of 8 than at 25. A trace that omits the cap cannot be interpreted.
  const t = await runScenario(CLEAN, new ScriptedCaller(CLEAN), planned('t', [{ kind: 'end' }]), {
    limits: { maxToolCallsPerTurn: 3 },
  });
  assert.equal(t.limits.maxToolCallsPerTurn, 3, 'the override is recorded, not the default');
  assert.equal(t.limits.maxTurns, DEFAULT_LIMITS.maxTurns, 'unset limits fall back to the default and are still recorded');
  assert.equal(t.limits.maxToolCallsTotal, DEFAULT_LIMITS.maxToolCallsTotal);
});

test('a run that hits a limit records the limit that stopped it', async () => {
  const t = await runScenario(
    CLEAN, new ScriptedCaller(CLEAN),
    looper({ kind: 'tool', call: { name: 'appointments.list', args: { patient_id: 'P-1001' } } }),
    { limits: { maxToolCallsPerTurn: 4 } },
  );
  assert.equal(t.termination, 'max_tool_calls');
  assert.equal(t.limits.maxToolCallsPerTurn, 4, 'the verdict and the cap that produced it travel together');
});
