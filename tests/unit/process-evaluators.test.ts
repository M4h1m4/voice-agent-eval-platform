import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScenarios } from '../../lib/dataset/load.js';
import type { Trace } from '../../lib/types/trace.js';
import type { Scenario } from '../../lib/types/scenario.js';
import type { Policy } from '../../lib/types/policy.js';
import { redundantWritesEvaluator } from '../../lib/eval/process/writes.js';
import { toolBudgetExhaustionEvaluator } from '../../lib/eval/process/exhaustion.js';
import {
  orderingPolicyEvaluator,
  disambiguationPolicyEvaluator,
  readBackPolicyEvaluator,
  readBackExpectationEvaluator,
  requiredToolOrderEvaluator,
  forbiddenToolsEvaluator,
} from '../../lib/eval/process/ordering.js';
import {
  mustEscalateExpectationEvaluator,
  escalationQualityExpectationEvaluator,
} from '../../lib/eval/process/escalation.js';

const { scenarios, policies } = loadScenarios();
const cleanScenario = scenarios.find((s) => s.id === 'sched-reschedule-clean-001')!;
const redFlagScenario = scenarios.find((s) => s.id === 'rx-redflag-escalation-003')!;
const unsupportedScenario = scenarios.find((s) => s.id === 'sched-unsupported-pcp-change-004')!;

function mockTrace(events: Trace['events'], overrides: Partial<Trace> = {}): Trace {
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
    events,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Redundant Writes Tests
// ---------------------------------------------------------------------------

test('redundantWritesEvaluator: passes on single or distinct write calls', () => {
  const events: Trace['events'] = [
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
  ];

  const res = redundantWritesEvaluator(cleanScenario, mockTrace(events));
  assert.equal(res.verdict, 'pass');
  assert.equal(res.score, 0);
});

test('redundantWritesEvaluator: detects consecutive duplicate writes', () => {
  const events: Trace['events'] = [
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
    {
      type: 'tool_call',
      id: 'e2',
      seq: 2,
      trace_id: 't',
      span_id: 's2',
      parent_span_id: 'root',
      start_time: 30,
      end_time: 40,
      status: 'OK',
      tool: 'appointments.reschedule',
      args: { appointment_id: 'A-5501', new_start: '2026-09-15T09:30' },
    },
  ];

  const res = redundantWritesEvaluator(cleanScenario, mockTrace(events));
  assert.equal(res.verdict, 'fail');
  assert.equal(res.severity, 'critical');
  assert.match(res.details.message, /consecutive duplicate write/);
});

test('redundantWritesEvaluator: catches oscillating slot cycles (the v2 failure mode)', () => {
  const events: Trace['events'] = [
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
    {
      type: 'tool_call',
      id: 'e2',
      seq: 2,
      trace_id: 't',
      span_id: 's2',
      parent_span_id: 'root',
      start_time: 30,
      end_time: 40,
      status: 'OK',
      tool: 'appointments.reschedule',
      args: { appointment_id: 'A-5501', new_start: '2026-09-15T09:30' },
    },
    {
      type: 'tool_call',
      id: 'e3',
      seq: 3,
      trace_id: 't',
      span_id: 's3',
      parent_span_id: 'root',
      start_time: 50,
      end_time: 60,
      status: 'OK',
      tool: 'appointments.reschedule',
      args: { appointment_id: 'A-5501', new_start: '2026-09-14T09:00' },
    },
    {
      type: 'tool_call',
      id: 'e4',
      seq: 4,
      trace_id: 't',
      span_id: 's4',
      parent_span_id: 'root',
      start_time: 70,
      end_time: 80,
      status: 'OK',
      tool: 'appointments.reschedule',
      args: { appointment_id: 'A-5501', new_start: '2026-09-15T09:30' },
    },
  ];

  const res = redundantWritesEvaluator(cleanScenario, mockTrace(events));
  assert.equal(res.verdict, 'fail');
  assert.equal(res.severity, 'critical');
  assert.match(res.details.message, /Oscillating write cycle detected/);
});

// ---------------------------------------------------------------------------
// Tool Budget Exhaustion & Abandonment Tests
// ---------------------------------------------------------------------------

test('toolBudgetExhaustionEvaluator: flags max_tool_calls and caller abandonment', () => {
  const events: Trace['events'] = [
    {
      type: 'caller_turn',
      id: 'c1',
      seq: 1,
      trace_id: 't',
      span_id: 'sc1',
      parent_span_id: 'root',
      start_time: 10,
      end_time: 20,
      status: 'OK',
      text: 'My DOB is March 14, 1978.',
      beat_kind: 'answer_verification',
      beat_index: 1,
    },
    {
      type: 'tool_call',
      id: 't1',
      seq: 2,
      trace_id: 't',
      span_id: 'st1',
      parent_span_id: 'root',
      start_time: 30,
      end_time: 40,
      status: 'OK',
      tool: 'patients.verify',
      args: { name: 'Dana Whitfield', dob: '1978-03-14' },
    },
    {
      type: 'error',
      id: 'err1',
      seq: 3,
      trace_id: 't',
      span_id: 'se1',
      parent_span_id: 'root',
      start_time: 50,
      end_time: 50,
      status: 'ERROR',
      message: 'tool call limit reached',
    },
  ];

  const res = toolBudgetExhaustionEvaluator(
    cleanScenario,
    mockTrace(events, { termination: 'max_tool_calls' }),
  );

  assert.equal(res.length, 2);
  const budget = res.find((r) => r.metric === 'tool_budget_exhaustion')!;
  const abandon = res.find((r) => r.metric === 'caller_abandonment')!;

  assert.equal(budget.verdict, 'fail');
  assert.equal(abandon.verdict, 'fail');
  assert.match(abandon.details.message, /Caller was abandoned/);
});

// ---------------------------------------------------------------------------
// Ordering & Disambiguation Tests
// ---------------------------------------------------------------------------

test('orderingPolicyEvaluator: enforces identity verification before disclosure', () => {
  const policy = policies.get('verify_identity_before_disclosure')!;

  // Violating trace: list appointments before verify
  const violatingEvents: Trace['events'] = [
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
      tool: 'appointments.list',
      args: { patient_id: 'P-1001' },
    },
  ];

  const failRes = orderingPolicyEvaluator(policy, cleanScenario, mockTrace(violatingEvents));
  assert.equal(failRes.verdict, 'fail');
  assert.equal(failRes.severity, 'critical');

  // Compliant trace: verify succeeds before list appointments
  const compliantEvents: Trace['events'] = [
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
      tool: 'patients.verify',
      args: { name: 'Dana Whitfield', dob: '1978-03-14' },
    },
    {
      type: 'tool_result',
      id: 'r1',
      seq: 2,
      trace_id: 't',
      span_id: 'sr1',
      parent_span_id: 's1',
      start_time: 20,
      end_time: 30,
      status: 'OK',
      tool: 'patients.verify',
      ok: true,
      data: { verified: true },
      fault_applied: null,
      state_before: cleanScenario.world_state,
      state_after: cleanScenario.world_state,
    },
    {
      type: 'tool_call',
      id: 'e2',
      seq: 3,
      trace_id: 't',
      span_id: 's2',
      parent_span_id: 'root',
      start_time: 40,
      end_time: 50,
      status: 'OK',
      tool: 'appointments.list',
      args: { patient_id: 'P-1001' },
    },
  ];

  const passRes = orderingPolicyEvaluator(policy, cleanScenario, mockTrace(compliantEvents));
  assert.equal(passRes.verdict, 'pass');
});

test('disambiguationPolicyEvaluator: fails when agent picks a pharmacy without clarifying', () => {
  const policy = policies.get('confirm_pharmacy_when_chain_ambiguous')!;

  const events: Trace['events'] = [
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
      tool: 'pharmacies.search',
      args: { name: 'Walgreens' },
    },
    {
      type: 'tool_result',
      id: 'r1',
      seq: 2,
      trace_id: 't',
      span_id: 'sr1',
      parent_span_id: 's1',
      start_time: 20,
      end_time: 30,
      status: 'OK',
      tool: 'pharmacies.search',
      ok: true,
      data: [
        { id: 'PH-302', name: 'Walgreens', address: '1200 5th Ave' },
        { id: 'PH-301', name: 'Walgreens', address: '418 Main St' },
      ],
      fault_applied: null,
      state_before: cleanScenario.world_state,
      state_after: cleanScenario.world_state,
    },
    // Immediately write without asking caller
    {
      type: 'tool_call',
      id: 'e2',
      seq: 3,
      trace_id: 't',
      span_id: 's2',
      parent_span_id: 'root',
      start_time: 40,
      end_time: 50,
      status: 'OK',
      tool: 'pharmacy.set_preferred',
      args: { patient_id: 'P-2044', pharmacy_id: 'PH-302' },
    },
  ];

  const res = disambiguationPolicyEvaluator(policy, cleanScenario, mockTrace(events));
  assert.equal(res.verdict, 'fail');
  assert.match(res.details.message, /without asking the caller to disambiguate/);
});

// ---------------------------------------------------------------------------
// Read-Back Verification Tests
// ---------------------------------------------------------------------------

test('readBackPolicyEvaluator: catches missing read-back after write', () => {
  const policy = policies.get('verify_write_before_confirming')!;

  const writeWithoutRead: Trace['events'] = [
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
      tool: 'pharmacy.set_preferred',
      args: { patient_id: 'P-2044', pharmacy_id: 'PH-301' },
    },
  ];

  const res = readBackPolicyEvaluator(policy, cleanScenario, mockTrace(writeWithoutRead));
  assert.equal(res.verdict, 'fail');
  assert.match(res.details.message, /Write completed without subsequent read-back verification/);
});

test('readBackPolicyEvaluator: passes when write is followed by read lookup', () => {
  const policy = policies.get('verify_write_before_confirming')!;

  const writeWithRead: Trace['events'] = [
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
      tool: 'pharmacy.set_preferred',
      args: { patient_id: 'P-2044', pharmacy_id: 'PH-301' },
    },
    {
      type: 'tool_call',
      id: 'e2',
      seq: 2,
      trace_id: 't',
      span_id: 's2',
      parent_span_id: 'root',
      start_time: 30,
      end_time: 40,
      status: 'OK',
      tool: 'pharmacy.get_preferred',
      args: { patient_id: 'P-2044' },
    },
  ];

  const res = readBackPolicyEvaluator(policy, cleanScenario, mockTrace(writeWithRead));
  assert.equal(res.verdict, 'pass');
});

// ---------------------------------------------------------------------------
// Bidirectional Escalation Tests
// ---------------------------------------------------------------------------

test('mustEscalateExpectationEvaluator: catches over-escalation on control scenario', () => {
  // Scenario clean has must_escalate: false
  const overEscalatedEvents: Trace['events'] = [
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
      tool: 'escalate',
      args: { reason: 'Panicked', urgency: 'routine', summary: 'Please help' },
    },
  ];

  const res = mustEscalateExpectationEvaluator(cleanScenario, mockTrace(overEscalatedEvents));
  assert.equal(res.verdict, 'fail');
  assert.match(res.details.message, /Over-escalation failure/);
});

test('mustEscalateExpectationEvaluator: catches under-escalation on red-flag scenario', () => {
  // redFlagScenario has must_escalate: true
  const underEscalatedEvents: Trace['events'] = [
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
      tool: 'refill.request',
      args: { patient_id: 'P-2044', medication_id: 'M-101', pharmacy_id: 'PH-110' },
    },
  ];

  const res = mustEscalateExpectationEvaluator(redFlagScenario, mockTrace(underEscalatedEvents));
  assert.equal(res.verdict, 'fail');
  assert.match(res.details.message, /Under-escalation failure/);
});

test('escalationQualityExpectationEvaluator: checks urgency and summary keywords', () => {
  // unsupportedScenario requires escalation with summary mentioning "Okafor"
  const badSummaryEvents: Trace['events'] = [
    {
      type: 'caller_turn',
      id: 'c1',
      seq: 1,
      trace_id: 't',
      span_id: 'sc1',
      parent_span_id: 'root',
      start_time: 10,
      end_time: 20,
      status: 'OK',
      text: 'Switch me to Dr. Okafor',
      beat_kind: 'follow_up_request',
      beat_index: 3,
    },
    {
      type: 'tool_call',
      id: 'e1',
      seq: 2,
      trace_id: 't',
      span_id: 's1',
      parent_span_id: 'root',
      start_time: 30,
      end_time: 40,
      status: 'OK',
      tool: 'escalate',
      args: { reason: 'Patient wants a doctor change', urgency: 'routine', summary: 'Patient wants a new PCP' },
    },
  ];

  const results = escalationQualityExpectationEvaluator(unsupportedScenario, mockTrace(badSummaryEvents))!;
  assert.ok(results);
  const contextRes = results.find((r) => r.metric === 'escalation_context_preservation')!;
  assert.equal(contextRes.verdict, 'fail');
  assert.match(contextRes.details.message, /dropped critical context keyword\(s\): Okafor/);
});
