/**
 * Outcome Evaluator: Task Completion & Final State Match (Part 3).
 *
 * Evaluates whether the clinic world state produced by the agent run
 * matches the declared expected_outcome.final_state, taking into account
 * any acceptable_variants declared by the scenario.
 */
import type { Scenario } from '../../types/scenario.js';
import type { Trace } from '../../types/trace.js';
import type { MetricResult, ExpectationEvaluator } from '../types.js';
import { matchFinalState } from '../state-match.js';

export const finalStateEvaluator: ExpectationEvaluator = (
  scenario: Scenario,
  trace: Trace,
): MetricResult | null => {
  const expectedFinalState = scenario.expected_outcome.final_state;
  if (!expectedFinalState) return null;

  const primaryMismatches = matchFinalState(expectedFinalState as never, trace.final_state);

  // Check acceptable variants if primary has mismatches
  if (primaryMismatches.length > 0) {
    for (const variant of scenario.acceptable_variants) {
      if (variant.final_state) {
        const variantMismatches = matchFinalState(variant.final_state as never, trace.final_state);
        if (variantMismatches.length === 0) {
          return {
            metric: 'final_state',
            category: 'outcome',
            verdict: 'pass',
            score: 1,
            severity: 'critical',
            details: {
              message: `Final state matches acceptable variant: ${variant.reason}`,
              evidence: { matchedVariant: variant.reason },
            },
          };
        }
      }
    }
  }

  const passed = primaryMismatches.length === 0;

  return {
    metric: 'final_state',
    category: 'outcome',
    verdict: passed ? 'pass' : 'fail',
    score: passed ? 1 : 0,
    severity: 'critical',
    details: {
      message: passed
        ? 'Final clinic database state matches all expected records.'
        : `Final state mismatch (${primaryMismatches.length} discrepancy): ${primaryMismatches.map((m) => `${m.path}: ${m.note}`).join('; ')}`,
      evidence: primaryMismatches,
    },
  };
};
