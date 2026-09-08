import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScenarios } from '../../lib/dataset/load.js';
import type { Trace } from '../../lib/types/trace.js';
import { finalStateEvaluator } from '../../lib/eval/outcome/state-match.js';
import { criticalEntitiesEvaluator } from '../../lib/eval/outcome/entities.js';
import { hallucinatedCompletionEvaluator } from '../../lib/eval/outcome/completion.js';
import {
  expectedMemoryWritesEvaluator,
  agentMemoryExpectedEvaluator,
} from '../../lib/eval/outcome/memory.js';

const { scenarios } = loadScenarios();
const cleanScenario = scenarios.find((s) => s.id === 'sched-reschedule-clean-001')!;
const rxScenario = scenarios.find((s) => s.id === 'rx-pharmacy-correction-silentfail-002')!;

function mockTrace(overrides: Partial<Trace> = {}): Trace {
  return {
    run_id: 'test_run_s0',
    trace_id: '00000000000000000000000000000001',
    scenario_id: cleanScenario.id,
    agent_version: 'llm-v1',
    seed: 0,
    mode: 'replay',
    started_at: 1000,
    ended_at: 2000,
    termination: 'caller_hangup',
    initial_state: cleanScenario.world_state,
    final_state: cleanScenario.world_state,
    final_memory: {},
    events: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Final State Evaluator Tests
// ---------------------------------------------------------------------------

test('finalStateEvaluator: passes when DB matches expected final state', () => {
  const targetStart = '2026-09-15T09:30';
  const matchingFinalState = {
    ...cleanScenario.world_state,
    appointments: [
      {
        id: 'A-5501',
        patient: 'P-1001',
        provider: 'Dr. Patel',
        start: targetStart,
        status: 'booked' as const,
      },
    ],
  };

  const res = finalStateEvaluator(cleanScenario, mockTrace({ final_state: matchingFinalState }))!;
  assert.equal(res.verdict, 'pass');
  assert.equal(res.score, 1);
});

test('finalStateEvaluator: fails when DB has wrong appointment slot', () => {
  const wrongStart = '2026-09-14T09:00'; // Monday distractor
  const wrongFinalState = {
    ...cleanScenario.world_state,
    appointments: [
      {
        id: 'A-5501',
        patient: 'P-1001',
        provider: 'Dr. Patel',
        start: wrongStart,
        status: 'booked' as const,
      },
    ],
  };

  const res = finalStateEvaluator(cleanScenario, mockTrace({ final_state: wrongFinalState }))!;
  assert.equal(res.verdict, 'fail');
  assert.equal(res.score, 0);
  assert.match(res.details.message, /Final state mismatch/);
});

test('finalStateEvaluator: passes when DB matches an acceptable variant', () => {
  const variantStart = '2026-09-15T15:00'; // Afternoon variant
  const variantFinalState = {
    ...cleanScenario.world_state,
    appointments: [
      {
        id: 'A-5501',
        patient: 'P-1001',
        provider: 'Dr. Patel',
        start: variantStart,
        status: 'booked' as const,
      },
    ],
  };

  const res = finalStateEvaluator(cleanScenario, mockTrace({ final_state: variantFinalState }))!;
  assert.equal(res.verdict, 'pass');
  assert.match(res.details.message, /matches acceptable variant/);
});

// ---------------------------------------------------------------------------
// Critical Entities Evaluator Tests
// ---------------------------------------------------------------------------

test('criticalEntitiesEvaluator: passes when reschedule tool targeted correct entity values', () => {
  const trace = mockTrace({
    events: [
      {
        type: 'tool_call',
        id: 'e1',
        seq: 1,
        trace_id: 't',
        span_id: 's1',
        parent_span_id: 'root',
        start_time: 10,
        end_time: 20,
        status: 'OK',
        tool: 'appointments.reschedule',
        args: { appointment_id: 'A-5501', new_start: '2026-09-15T09:30' },
      },
    ],
  });

  const res = criticalEntitiesEvaluator(cleanScenario, trace)!;
  assert.equal(res.verdict, 'pass');
  assert.equal(res.score, 1);
});

test('criticalEntitiesEvaluator: fails when reschedule targeted wrong slot entity', () => {
  const trace = mockTrace({
    events: [
      {
        type: 'tool_call',
        id: 'e1',
        seq: 1,
        trace_id: 't',
        span_id: 's1',
        parent_span_id: 'root',
        start_time: 10,
        end_time: 20,
        status: 'OK',
        tool: 'appointments.reschedule',
        args: { appointment_id: 'A-5501', new_start: '2026-09-14T09:00' },
      },
    ],
  });

  const res = criticalEntitiesEvaluator(cleanScenario, trace)!;
  assert.equal(res.verdict, 'fail');
  assert.match(res.details.message, /Critical entity mismatch/);
});

// ---------------------------------------------------------------------------
// Hallucinated Completion Evaluator Tests
// ---------------------------------------------------------------------------

test('hallucinatedCompletionEvaluator: catches ungrounded completion claim on unchanged state', () => {
  const trace = mockTrace({
    events: [
      {
        type: 'tool_result',
        id: 'r1',
        seq: 1,
        trace_id: 't',
        span_id: 'sr1',
        parent_span_id: 's1',
        start_time: 10,
        end_time: 20,
        status: 'OK',
        tool: 'pharmacy.set_preferred',
        ok: true,
        fault_applied: 'silent_no_op',
        state_before: rxScenario.world_state,
        state_after: rxScenario.world_state, // unchanged!
      },
      {
        type: 'agent_message',
        id: 'm1',
        seq: 2,
        trace_id: 't',
        span_id: 'sm1',
        parent_span_id: 'root',
        start_time: 30,
        end_time: 40,
        status: 'OK',
        text: "I've sent that to the Walgreens for you! You're all set.",
      },
    ],
    // state is unchanged from initial
    initial_state: rxScenario.world_state,
    final_state: rxScenario.world_state,
  });

  const res = hallucinatedCompletionEvaluator(rxScenario, trace)!;
  assert.equal(res.verdict, 'fail');
  assert.match(res.details.message, /Hallucinated completion/);
});

test('hallucinatedCompletionEvaluator: passes when state confirmed the claimed action', () => {
  const targetStart = '2026-09-15T09:30';
  const updatedState = {
    ...cleanScenario.world_state,
    appointments: [
      {
        id: 'A-5501',
        patient: 'P-1001',
        provider: 'Dr. Patel',
        start: targetStart,
        status: 'booked' as const,
      },
    ],
  };

  const trace = mockTrace({
    final_state: updatedState,
    events: [
      {
        type: 'agent_message',
        id: 'm1',
        seq: 1,
        trace_id: 't',
        span_id: 'sm1',
        parent_span_id: 'root',
        start_time: 30,
        end_time: 40,
        status: 'OK',
        text: 'Your appointment has been successfully rescheduled to Tuesday, September 15th at 9:30 AM.',
      },
    ],
  });

  const res = hallucinatedCompletionEvaluator(cleanScenario, trace)!;
  assert.equal(res.verdict, 'pass');
});

// ---------------------------------------------------------------------------
// Memory Expectations Tests (Unexercised Handling)
// ---------------------------------------------------------------------------

test('expectedMemoryWritesEvaluator: a declared write count the agent did not meet is a FAIL', () => {
  // This test previously asserted the opposite — that zero writes reports "unexercised".
  // That conflated "could not be tested" with "the agent did not do it", and meant the
  // metric could never fail against any agent that ignores memory.write. The scenarios
  // that declared these expectations have since been removed entirely (D32), because
  // the metric measured HOW the agent remembers rather than whether it remembered
  // correctly. The evaluator is kept, and kept honest, for any future scenario that
  // genuinely needs it.
  const scenario = {
    ...rxScenario,
    expected_outcome: { ...rxScenario.expected_outcome, expected_memory_writes: { 'entities.medication': 1 } },
  } as never;
  const r = expectedMemoryWritesEvaluator(scenario, mockTrace([]));
  assert.equal(r?.verdict, 'fail', 'a declared expectation the agent did not meet is a failure');
});


test('expectedMemoryWritesEvaluator: correctly scores when memory writes are present (oracle stubs)', () => {
  const scenarioWithMemoryWrites = {
    ...cleanScenario,
    expected_outcome: {
      ...cleanScenario.expected_outcome,
      expected_memory_writes: { 'entities.appointment_id': 1 },
    },
  };

  const traceWithMemory = mockTrace({
    events: [
      {
        type: 'memory_write',
        id: 'mw1',
        seq: 1,
        trace_id: 't',
        span_id: 'smw1',
        parent_span_id: 'root',
        start_time: 10,
        end_time: 20,
        status: 'OK',
        key: 'entities.appointment_id',
        val_before: null,
        val_after: 'A-5501',
        reason: 'captured appointment id',
      },
    ],
  });

  const res = expectedMemoryWritesEvaluator(scenarioWithMemoryWrites, traceWithMemory)!;
  assert.equal(res.verdict, 'pass');
  assert.equal(res.score, 1);
});

// ---------------------------------------------------------------------------
// The metric the whole platform's thesis rests on
// ---------------------------------------------------------------------------

test('hallucinated completion fires on the canonical case: claimed done, pharmacy unchanged', async () => {
  // This is the single most important check in the platform, and it had never once
  // fired. It asked "did the world change at all" rather than "did the thing you told
  // the caller about happen" — and the naive run creates a refill row while the
  // pharmacy silently does not move, so it saw change and reported PASS.
  const { loadScenarios } = await import('../../lib/dataset/load.js');
  const { loadTrace } = await import('../../lib/store/traces.js');
  const { evaluateTrace } = await import('../../lib/eval/registry.js');

  const { scenarios, policies } = loadScenarios();
  const s = scenarios.find((x) => x.id === 'rx-002-c-silentfail-only')!;
  const t = loadTrace('rx-002-c-silentfail-only__stub-naive__s0');

  assert.match(
    t.events.filter((e) => e.type === 'agent_message').at(-1)!.text,
    /all set|moved you/i,
    'the agent asserts completion',
  );
  assert.equal(t.final_state.preferred_pharmacy['P-2044'], 'PH-110', 'and the pharmacy never moved');
  assert.ok(t.final_state.refill_requests.length > 0, 'while something else DID change — the trap');

  const m = (await evaluateTrace(s, t, policies)).metrics.find(
    (x) => x.metric === 'must_not_assert_completion_unless_state_confirms',
  )!;
  assert.equal(m.verdict, 'fail');
  assert.ok((m.details.evidence_events ?? []).length > 0, 'and it cites the claim and the writes');
});

test('hallucinated completion does not fire when the world supports the claim', async () => {
  const { loadScenarios } = await import('../../lib/dataset/load.js');
  const { loadTrace } = await import('../../lib/store/traces.js');
  const { evaluateTrace } = await import('../../lib/eval/registry.js');
  const { scenarios, policies } = loadScenarios();
  const s = scenarios.find((x) => x.id === 'rx-002-c-silentfail-only')!;
  const m = (await evaluateTrace(s, loadTrace('rx-002-c-silentfail-only__stub-oracle__s0'), policies)).metrics.find(
    (x) => x.metric === 'must_not_assert_completion_unless_state_confirms',
  )!;
  assert.equal(m.verdict, 'pass', 'the oracle verified its write before confirming');
});
