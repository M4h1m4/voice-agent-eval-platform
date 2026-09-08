import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  RegistryGuardError,
  registerPolicyEvaluator,
  registerExpectationEvaluator,
  registerProcessEvaluator,
  getPolicyEvaluator,
  getExpectationEvaluator,
  getProcessEvaluators,
  clearRegistry,
  assertPoliciesImplemented,
  assertExpectationsImplemented,
  assertRegistryComplete,
  evaluateTrace,
} from '../../lib/eval/registry.js';
import { loadPolicies, loadScenarios } from '../../lib/dataset/load.js';
import type { Policy, PolicyCheck } from '../../lib/types/policy.js';
import type { Scenario } from '../../lib/types/scenario.js';
import type { Trace } from '../../lib/types/trace.js';

const { scenarios, policies } = loadScenarios();
const sampleScenario = scenarios[0]!;
const samplePolicy = Array.from(policies.values())[0]!;

// Mock minimal trace
function makeMockTrace(overrides: Partial<Trace> = {}): Trace {
  return {
    run_id: 'test-run__v1__s0',
    trace_id: '1234567890abcdef1234567890abcdef',
    scenario_id: sampleScenario.id,
    agent_version: 'llm-v1',
    seed: 0,
    mode: 'replay',
    started_at: 1000,
    ended_at: 2000,
    termination: 'caller_hangup',
    initial_state: sampleScenario.world_state,
    final_state: sampleScenario.world_state,
    final_memory: {},
    events: [],
    ...overrides,
  };
}

beforeEach(() => {
  clearRegistry();
});

test('registry guard: throws RegistryGuardError when a policy check kind has no evaluator', () => {
  const dummyPolicy: Policy = {
    id: 'test_unhandled_policy',
    title: 'Unhandled Policy',
    statement: 'This policy has no evaluator registered',
    severity: 'critical',
    check: {
      kind: 'ordering',
      must_precede: ['patients.verify'],
      targets: ['medications.list'],
    },
  };

  // ordering has no evaluator registered yet
  assert.throws(
    () => assertPoliciesImplemented([dummyPolicy]),
    RegistryGuardError,
    'Should throw RegistryGuardError when ordering check has no evaluator',
  );
  assert.throws(
    () => assertPoliciesImplemented([dummyPolicy]),
    /Policy "test_unhandled_policy" declares check\.kind "ordering"/,
  );
});

test('registry guard: succeeds when all policies have registered evaluators', () => {
  const kinds: PolicyCheck['kind'][] = [
    'ordering',
    'disambiguation',
    'read_back',
    'escalation_required',
    'no_fabricated_capability',
  ];

  for (const k of kinds) {
    registerPolicyEvaluator(k, () => ({
      metric: `policy:${k}`,
      category: 'process',
      verdict: 'pass',
      score: 1,
      details: { message: 'ok' },
    }));
  }

  assert.doesNotThrow(() => assertPoliciesImplemented(policies.values()));
});

test('registry guard: throws RegistryGuardError when a scenario declares an unhandled expectation', () => {
  // Clear expectation evaluators so final_state is missing
  clearRegistry();
  // unregister the default final_state
  const fakeScenario = {
    ...sampleScenario,
    expected_outcome: {
      ...sampleScenario.expected_outcome,
      must_read_back_after_write: true,
    },
  };

  assert.throws(
    () => assertExpectationsImplemented([fakeScenario]),
    RegistryGuardError,
    'Should throw RegistryGuardError for unhandled must_read_back_after_write',
  );
});

test('registry guard: assertRegistryComplete validates full matrix when all parts registered', () => {
  // Register stubs for all policy check kinds
  const kinds: PolicyCheck['kind'][] = [
    'ordering',
    'disambiguation',
    'read_back',
    'escalation_required',
    'no_fabricated_capability',
  ];
  for (const k of kinds) {
    registerPolicyEvaluator(k, () => ({
      metric: `policy:${k}`,
      category: 'process',
      verdict: 'pass',
      score: 1,
      details: { message: 'ok' },
    }));
  }

  // Register stubs for all expectation keys
  const keys = [
    'must_escalate',
    'final_state',
    'critical_entities',
    'required_tool_order',
    'forbidden_tools',
    'agent_memory_expected',
    'expected_memory_writes',
    'must_read_back_after_write',
    'must_not_assert_completion_unless_state_confirms',
    'escalation',
    'unsupported_requests',
  ] as const;

  for (const key of keys) {
    registerExpectationEvaluator(key, () => ({
      metric: key,
      category: 'outcome',
      verdict: 'pass',
      score: 1,
      details: { message: 'ok' },
    }));
  }

  // Now assertRegistryComplete across all real scenarios and policies must pass
  assert.doesNotThrow(() => assertRegistryComplete(policies.values(), scenarios));
});

test('evaluateTrace: aggregates process, expectation, and policy evaluators', async () => {
  registerExpectationEvaluator('final_state', () => ({
    metric: 'final_state',
    category: 'outcome',
    verdict: 'pass',
    score: 1,
    details: { message: 'state matches' },
  }));

  registerProcessEvaluator('loop_detector', () => ({
    metric: 'loop_detector',
    category: 'process',
    verdict: 'pass',
    score: 1,
    details: { message: 'no loop' },
  }));

  registerExpectationEvaluator('critical_entities', () => ({
    metric: 'critical_entities',
    category: 'outcome',
    verdict: 'pass',
    score: 1,
    details: { message: 'entities match' },
  }));

  registerPolicyEvaluator('ordering', (p) => ({
    metric: `policy:${p.id}`,
    policy_id: p.id,
    category: 'process',
    verdict: 'pass',
    score: 1,
    details: { message: 'ordering satisfied' },
  }));

  const trace = makeMockTrace();
  const report = await evaluateTrace(sampleScenario, trace, policies);

  assert.equal(report.scenario_id, sampleScenario.id);
  assert.equal(report.overall_verdict, 'pass');
  assert.equal(report.summary.failed, 0);
  assert.ok(report.metrics.some((m) => m.metric === 'loop_detector'));
  assert.ok(report.metrics.some((m) => m.metric === 'critical_entities'));
  assert.ok(report.metrics.some((m) => m.metric.startsWith('policy:')));
});

test('evaluateTrace: fails overall verdict when any evaluator fails', async () => {
  registerExpectationEvaluator('final_state', () => ({
    metric: 'final_state',
    category: 'outcome',
    verdict: 'pass',
    score: 1,
    details: { message: 'ok' },
  }));

  registerProcessEvaluator('failing_check', () => ({
    metric: 'failing_check',
    category: 'process',
    verdict: 'fail',
    score: 0,
    severity: 'critical',
    details: { message: 'redundant writes detected' },
  }));

  const trace = makeMockTrace();
  const report = await evaluateTrace(sampleScenario, trace, policies);

  assert.equal(report.overall_verdict, 'fail');
  assert.equal(report.summary.failed, 1);
  assert.equal(report.summary.critical_violations, 1);
});

test('evaluateTrace: unexercised metrics do not cause overall failure', async () => {
  registerExpectationEvaluator('final_state', () => ({
    metric: 'final_state',
    category: 'outcome',
    verdict: 'pass',
    score: 1,
    details: { message: 'ok' },
  }));

  // Uses `critical_entities` as the vehicle — it must be a field the sample scenario It previously used
  // `expected_memory_writes`, which no scenario declares any more (D32), so the
  // actually declares TRUTHY, or the registry skips it and the assertion tests nothing.
  registerExpectationEvaluator('critical_entities', () => ({
    metric: 'critical_entities',
    category: 'process',
    verdict: 'unexercised',
    score: 0,
    details: { message: 'the entity could not be observed on this trace' },
  }));

  const trace = makeMockTrace();
  const report = await evaluateTrace(sampleScenario, trace, policies);

  // The point of this test is that an unexercised metric does not fail the run — not
  // that exactly one metric is unexercised. Pinning the count made it break whenever
  // any unrelated metric legitimately became untestable on this scenario.
  assert.equal(report.overall_verdict, 'pass');
  assert.ok(report.summary.unexercised >= 1, 'at least the injected metric is unexercised');
  assert.equal(report.summary.failed, 0, 'and nothing failed because of it');
});

test('evaluateTrace: handles evaluator runtime exceptions gracefully', async () => {
  registerProcessEvaluator('buggy_evaluator', () => {
    throw new Error('Unexpected evaluator crash');
  });

  const trace = makeMockTrace();
  const report = await evaluateTrace(sampleScenario, trace, policies);

  assert.equal(report.overall_verdict, 'fail');
  const crashMetric = report.metrics.find((m) => m.metric === 'buggy_evaluator');
  assert.ok(crashMetric);
  assert.equal(crashMetric.verdict, 'fail');
  assert.match(crashMetric.details.message, /Unexpected evaluator crash/);
});
