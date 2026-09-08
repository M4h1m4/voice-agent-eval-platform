/**
 * Outcome Evaluators: Memory Expectations (Part 3).
 *
 * Implements:
 *   - expected_memory_writes
 *   - agent_memory_expected
 *
 * EMPIRICAL TRANSPARENCY (Point 5 from headline findings):
 * Across all 12 pre-production LLM runs (both v1 and v2), memory.write was called
 * 0 times by the LLM agents. Rather than pretending this was exercised or failing
 * the agent on an unadopted tool, the evaluator reports 'unexercised' when memory
 * tool calls are absent, while properly scoring deterministic stubs that exercise it.
 */
import type { Scenario } from '../../types/scenario.js';
import type { Trace } from '../../types/trace.js';
import { ids, memoryWrites } from '../evidence.js';
import type { MetricResult, ExpectationEvaluator } from '../types.js';

export const expectedMemoryWritesEvaluator: ExpectationEvaluator = (
  scenario: Scenario,
  trace: Trace,
): MetricResult | null => {
  const expected = scenario.expected_outcome.expected_memory_writes;
  if (!expected || Object.keys(expected).length === 0) return null;

  // Count memory writes per key in trace events
  const memoryEvents = trace.events.filter(
    (e): e is Extract<Trace['events'][number], { type: 'memory_write' }> => e.type === 'memory_write',
  );

  // No early exit for "the agent never wrote anything".
  //
  // This previously returned `unexercised`, which conflated "this could not be tested"
  // with "the agent did not do it". The condition IS testable: the scenario declared a
  // count and the actual count is zero. Reporting that as untestable meant the metric
  // could never fail against any agent that ignores memory.write — which is every LLM
  // agent in this corpus, and precisely the behaviour a scenario declaring the
  // expectation is asking about.
  //
  // `unexercised` is for evidence that does not exist. A declared expectation the agent
  // did not meet is a failure.

  const writeCounts: Record<string, number> = {};
  for (const mw of memoryEvents) {
    writeCounts[mw.key] = (writeCounts[mw.key] ?? 0) + 1;
  }

  const mismatches: { key: string; expected: number; actual: number }[] = [];
  for (const [key, expCount] of Object.entries(expected)) {
    const actCount = writeCounts[key] ?? 0;
    // An agent that does not commit prematurely writes once, directly to the correct
    // entity. One that commits eagerly and then corrects itself writes twice. Both
    // reach the right final memory, so both are allowed.
    //
    // A third clause used to allow `actCount === 0` on any scenario with
    // role === 'ablation'. That was a blanket exemption with no stated reason, and it
    // silently passed every ablation whose agent never touched memory at all.
    const isAllowed = actCount === expCount || (expCount === 2 && actCount === 1);
    if (!isAllowed) {
      mismatches.push({ key, expected: expCount, actual: actCount });
    }
  }

  const passed = mismatches.length === 0;

  return {
    metric: 'expected_memory_writes',
    category: 'process',
    verdict: passed ? 'pass' : 'fail',
    score: passed ? 1 : 0,
    severity: 'medium',
    details: {
      message: passed
        ? 'All expected memory keys were written the expected number of times.'
        : `Memory write count mismatch: ${mismatches.map((m) => `${m.key} (expected ${m.expected}, got ${m.actual})`).join('; ')}`,
      evidence: { expected, actual: writeCounts },
    },
  };
};

export const agentMemoryExpectedEvaluator: ExpectationEvaluator = (
  scenario: Scenario,
  trace: Trace,
): MetricResult | null => {
  const expected = scenario.expected_outcome.agent_memory_expected;
  if (!expected || Object.keys(expected).length === 0) return null;

  // Same reasoning as above: an empty working memory where the scenario declared
  // expected contents is a failure to meet the expectation, not an absence of evidence.
  const finalMemory = trace.final_memory ?? {};

  const mismatches: { key: string; expected: unknown; actual: unknown }[] = [];
  for (const [k, v] of Object.entries(expected)) {
    const actualVal = finalMemory[k];
    if (actualVal !== undefined && actualVal !== v) {
      mismatches.push({ key: k, expected: v, actual: actualVal });
    } else if (actualVal === undefined) {
      mismatches.push({ key: k, expected: v, actual: 'undefined' });
    }
  }

  const passed = mismatches.length === 0;

  return {
    metric: 'agent_memory_expected',
    category: 'outcome',
    verdict: passed ? 'pass' : 'fail',
    score: passed ? 1 : 0,
    severity: 'medium',
    details: {
      message: passed
        ? 'Agent working memory contains all expected facts.'
        : `Memory mismatch: ${mismatches.map((m) => `${m.key} (expected "${m.expected}", got "${m.actual}")`).join('; ')}`,
      // Every write to the mismatched keys, so a reviewer can see whether the agent
      // never wrote the value, or wrote it and failed to overwrite after a correction.
      evidence_events: ids(mismatches.flatMap((m) => memoryWrites(trace, m.key))),
      evidence: mismatches,
    },
  };
};
