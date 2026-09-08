/**
 * Export and registration of all Process Evaluators (Part 3).
 */
import {
  registerProcessEvaluator,
  registerPolicyEvaluator,
  registerExpectationEvaluator,
} from '../registry.js';
import { redundantWritesEvaluator } from './writes.js';
import { toolBudgetExhaustionEvaluator } from './exhaustion.js';
import {
  orderingPolicyEvaluator,
  disambiguationPolicyEvaluator,
  readBackPolicyEvaluator,
  readBackExpectationEvaluator,
  requiredToolOrderEvaluator,
  forbiddenToolsEvaluator,
} from './ordering.js';
import {
  mustEscalateExpectationEvaluator,
  escalationQualityExpectationEvaluator,
  escalationRequiredPolicyEvaluator,
} from './escalation.js';

export {
  redundantWritesEvaluator,
  toolBudgetExhaustionEvaluator,
  orderingPolicyEvaluator,
  disambiguationPolicyEvaluator,
  readBackPolicyEvaluator,
  readBackExpectationEvaluator,
  requiredToolOrderEvaluator,
  forbiddenToolsEvaluator,
  mustEscalateExpectationEvaluator,
  escalationQualityExpectationEvaluator,
  escalationRequiredPolicyEvaluator,
};

/**
 * Registers all process evaluators, policy checkers, and scenario expectation consumers
 * into the central evaluator registry.
 */
export function registerAllProcessEvaluators(): void {
  // Unconditional process monitors (run on every trace)
  registerProcessEvaluator('redundant_writes', redundantWritesEvaluator);
  registerProcessEvaluator('tool_budget_exhaustion', toolBudgetExhaustionEvaluator);

  // Policy check kinds
  registerPolicyEvaluator('ordering', orderingPolicyEvaluator);
  registerPolicyEvaluator('disambiguation', disambiguationPolicyEvaluator);
  registerPolicyEvaluator('read_back', readBackPolicyEvaluator);
  registerPolicyEvaluator('escalation_required', escalationRequiredPolicyEvaluator);

  // Scenario expectation consumers
  registerExpectationEvaluator('must_escalate', mustEscalateExpectationEvaluator);
  registerExpectationEvaluator('escalation', escalationQualityExpectationEvaluator);
  registerExpectationEvaluator('required_tool_order', requiredToolOrderEvaluator);
  registerExpectationEvaluator('forbidden_tools', forbiddenToolsEvaluator);
  registerExpectationEvaluator('must_read_back_after_write', readBackExpectationEvaluator);
}
