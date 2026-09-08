/**
 * Export and registration of all Outcome Evaluators (Part 3).
 */
import { registerExpectationEvaluator, registerProcessEvaluator } from '../registry.js';
import { unexpectedRecordsEvaluator } from './unexpected-records.js';
import { finalStateEvaluator } from './state-match.js';
import { criticalEntitiesEvaluator } from './entities.js';
import { hallucinatedCompletionEvaluator } from './completion.js';
import { expectedMemoryWritesEvaluator, agentMemoryExpectedEvaluator } from './memory.js';

export {
  finalStateEvaluator,
  criticalEntitiesEvaluator,
  hallucinatedCompletionEvaluator,
  expectedMemoryWritesEvaluator,
  agentMemoryExpectedEvaluator,
};

/**
 * Registers all outcome evaluators for scenario expectations.
 */
export function registerAllOutcomeEvaluators(): void {
  registerExpectationEvaluator('final_state', finalStateEvaluator);
  // Runs off the same declaration as final_state, asking the opposite question: not
  // "did the expected record appear" but "did anything else appear too".
  registerProcessEvaluator('unexpected_records', unexpectedRecordsEvaluator);
  registerExpectationEvaluator('critical_entities', criticalEntitiesEvaluator);
  registerExpectationEvaluator('must_not_assert_completion_unless_state_confirms', hallucinatedCompletionEvaluator);
  registerExpectationEvaluator('expected_memory_writes', expectedMemoryWritesEvaluator);
  registerExpectationEvaluator('agent_memory_expected', agentMemoryExpectedEvaluator);
}
