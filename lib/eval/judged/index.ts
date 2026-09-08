/**
 * Export and registration of all Judged Evaluators (Part 3).
 */
import { registerPolicyEvaluator, registerExpectationEvaluator } from '../registry.js';
import { noFabricatedCapabilityEvaluator, unsupportedRequestsEvaluator } from './judge.js';
import { runCalibration } from './calibration.js';
import { HUMAN_LABELS } from './labels.js';
import { JUDGE_SYSTEM_PROMPT } from './rubric.js';

export {
  noFabricatedCapabilityEvaluator,
  unsupportedRequestsEvaluator,
  runCalibration,
  HUMAN_LABELS,
  JUDGE_SYSTEM_PROMPT,
};

export function registerAllJudgedEvaluators(): void {
  registerPolicyEvaluator('no_fabricated_capability', noFabricatedCapabilityEvaluator);
  registerExpectationEvaluator('unsupported_requests', unsupportedRequestsEvaluator);
}
