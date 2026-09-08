/**
 * Evaluator Registry & Registry Guard (Part 3.0).
 *
 * This module is the structural spine of Part 3.
 *
 * It enforces two load-bearing invariants:
 *   1. POLICY GUARD: Every policy in policies.yaml must resolve to an implementing evaluator.
 *   2. EXPECTATION GUARD: Every expectation declared on a scenario's expected_outcome must
 *      have a registered evaluator consuming it.
 *
 * Without these guards, an engineer could cite a policy or declare a scenario expectation
 * that passes silently forever without executing a single line of verification code.
 */
import type { Scenario, ExpectedOutcome } from '../types/scenario.js';
import type { Policy, PolicyCheck } from '../types/policy.js';
import type { Trace } from '../types/trace.js';
import { matchFinalState } from './state-match.js';
import { registerAllProcessEvaluators } from './process/index.js';
import { registerAllOutcomeEvaluators } from './outcome/index.js';
import { registerAllJudgedEvaluators } from './judged/index.js';
import {
  type MetricResult,
  type EvaluationReport,
  type PolicyEvaluator,
  type ExpectationEvaluator,
  type ProcessEvaluator,
  type EvaluatorContext,
  type ExpectationKey,
  EXPECTATION_KEYS,
} from './types.js';

export class RegistryGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryGuardError';
  }
}

// ---------------------------------------------------------------------------
// Registries
// ---------------------------------------------------------------------------

const policyEvaluators = new Map<PolicyCheck['kind'], PolicyEvaluator>();
const expectationEvaluators = new Map<string, ExpectationEvaluator>();
const processEvaluators = new Map<string, ProcessEvaluator>();

export function registerPolicyEvaluator(kind: PolicyCheck['kind'], evaluator: PolicyEvaluator): void {
  policyEvaluators.set(kind, evaluator);
}

export function getPolicyEvaluator(kind: PolicyCheck['kind']): PolicyEvaluator | undefined {
  return policyEvaluators.get(kind);
}

export function registerExpectationEvaluator(field: ExpectationKey, evaluator: ExpectationEvaluator): void {
  expectationEvaluators.set(field, evaluator);
}

export function getExpectationEvaluator(field: string): ExpectationEvaluator | undefined {
  return expectationEvaluators.get(field);
}

export function registerProcessEvaluator(name: string, evaluator: ProcessEvaluator): void {
  processEvaluators.set(name, evaluator);
}

export function getProcessEvaluators(): ReadonlyMap<string, ProcessEvaluator> {
  return processEvaluators;
}

export function clearRegistry(): void {
  policyEvaluators.clear();
  expectationEvaluators.clear();
  processEvaluators.clear();
}

// ---------------------------------------------------------------------------
// Registry Guards
// ---------------------------------------------------------------------------

/**
 * Asserts that every policy loaded in policies.yaml has an active evaluator.
 * Throws RegistryGuardError if any declared check.kind is unhandled.
 */
export function assertPoliciesImplemented(policies: Iterable<Policy>): void {
  for (const p of policies) {
    if (!policyEvaluators.has(p.check.kind)) {
      throw new RegistryGuardError(
        `Policy "${p.id}" declares check.kind "${p.check.kind}" with no implementing evaluator in registry.`,
      );
    }
  }
}

/**
 * Determines whether a scenario's declared expected_outcome field is active and requires enforcement.
 */
function isExpectationActive(key: ExpectationKey, expected: ExpectedOutcome): boolean {
  const val = expected[key];
  if (val === undefined || val === null) return false;
  if (typeof val === 'boolean') return val; // true means active, false means not required
  if (Array.isArray(val)) return val.length > 0;
  if (typeof val === 'object') return Object.keys(val).length > 0;
  return true;
}

/**
 * Asserts that every active expectation in every scenario's expected_outcome
 * has an active evaluator registered to consume it.
 */
export function assertExpectationsImplemented(scenarios: Iterable<Scenario>): void {
  for (const s of scenarios) {
    for (const key of EXPECTATION_KEYS) {
      if (isExpectationActive(key, s.expected_outcome)) {
        if (!expectationEvaluators.has(key)) {
          throw new RegistryGuardError(
            `Scenario "${s.id}" declares expected_outcome.${key}, but no evaluator is registered to consume it.`,
          );
        }
      }
    }
  }
}

/**
 * Validates the entire evaluation platform against the active dataset.
 * Must run at engine/CLI startup before traces are evaluated.
 */
export function assertRegistryComplete(
  policies: Iterable<Policy>,
  scenarios: Iterable<Scenario>,
): void {
  assertPoliciesImplemented(policies);
  assertExpectationsImplemented(scenarios);
}

// ---------------------------------------------------------------------------
// Execution Engine
// ---------------------------------------------------------------------------

/**
 * Runs all registered evaluators against a single trace and compiles the EvaluationReport.
 */
export async function evaluateTrace(
  scenario: Scenario,
  trace: Trace,
  policies: Map<string, Policy>,
  context?: EvaluatorContext,
): Promise<EvaluationReport> {
  const results: MetricResult[] = [];

  // 1. Run unconditional Process Evaluators
  for (const [name, evalFn] of processEvaluators) {
    try {
      const res = await evalFn(scenario, trace, context);
      if (Array.isArray(res)) results.push(...res);
      else results.push(res);
    } catch (err) {
      results.push({
        metric: name,
        category: 'process',
        verdict: 'fail',
        score: 0,
        severity: 'critical',
        details: { message: `Evaluator threw error: ${(err as Error).message}` },
      });
    }
  }

  // 2. Run Scenario Expectation Evaluators for active expectations
  for (const key of EXPECTATION_KEYS) {
    if (isExpectationActive(key, scenario.expected_outcome)) {
      const evalFn = expectationEvaluators.get(key);
      if (evalFn) {
        try {
          const res = await evalFn(scenario, trace, context);
          if (res) {
            if (Array.isArray(res)) results.push(...res);
            else results.push(res);
          }
        } catch (err) {
          results.push({
            metric: key,
            category: 'outcome',
            verdict: 'fail',
            score: 0,
            severity: 'critical',
            details: { message: `Expectation evaluator "${key}" threw error: ${(err as Error).message}` },
          });
        }
      }
    }
  }

  // 3. Run Policy Evaluators for policies referenced by the scenario
  for (const policyId of scenario.policy_refs) {
    const policy = policies.get(policyId);
    if (!policy) {
      results.push({
        metric: `policy:${policyId}`,
        category: 'process',
        verdict: 'fail',
        score: 0,
        severity: 'critical',
        details: { message: `Referenced policy "${policyId}" not found in policy map.` },
      });
      continue;
    }

    const evalFn = policyEvaluators.get(policy.check.kind);
    if (evalFn) {
      try {
        const res = await evalFn(policy, scenario, trace, context);
        results.push(res);
      } catch (err) {
        results.push({
          metric: `policy:${policy.id}`,
          policy_id: policy.id,
          category: 'process',
          verdict: 'fail',
          score: 0,
          severity: policy.severity,
          details: { message: `Policy evaluator threw error: ${(err as Error).message}` },
        });
      }
    }
  }

  // 4. Summarize and determine overall verdict
  let passed = 0;
  let failed = 0;
  let unexercised = 0;
  let critical_violations = 0;

  for (const r of results) {
    if (r.verdict === 'pass') passed++;
    else if (r.verdict === 'fail') {
      failed++;
      if (r.severity === 'critical') critical_violations++;
    } else if (r.verdict === 'unexercised') {
      unexercised++;
    }
  }

  return {
    run_id: trace.run_id,
    scenario_id: scenario.id,
    agent_version: trace.agent_version,
    overall_verdict: failed === 0 ? 'pass' : 'fail',
    metrics: results,
    summary: {
      total: results.length,
      passed,
      failed,
      unexercised,
      critical_violations,
    },
    evaluated_at: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Default / Built-in Registration
// ---------------------------------------------------------------------------

/**
 * Installs base evaluators (e.g. final_state matching) that exist at scaffold time.
 */
export function installDefaultEvaluators(): void {
  // Install all core process evaluators
  registerAllProcessEvaluators();

  // Install all core outcome evaluators
  registerAllOutcomeEvaluators();

  // Install judged evaluators (no_fabricated_capability, unsupported_requests)
  registerAllJudgedEvaluators();
}

// Install defaults on initial module load
installDefaultEvaluators();
