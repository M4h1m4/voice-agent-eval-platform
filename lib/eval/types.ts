/**
 * Core types for the evaluation platform (Part 3).
 *
 * Distinguishes three families of metrics:
 *   - OUTCOME: checks the final world state and verified entities
 *   - PROCESS: checks tool-call sequencing, ordering, thrashing, and safety guards
 *   - JUDGED: qualitative checks requiring an LLM judge with human calibration
 *
 * Verdicts are strictly three-state:
 *   - 'pass': condition checked and satisfied
 *   - 'fail': condition checked and violated
 *   - 'unexercised': condition could not be tested on this trace (e.g. uncalled tool, unreached beat)
 */
import type { Scenario, ExpectedOutcome } from '../types/scenario.js';
import type { Policy } from '../types/policy.js';
import type { Trace } from '../types/trace.js';

export type MetricCategory = 'outcome' | 'process' | 'judged';

export type MetricVerdict = 'pass' | 'fail' | 'unexercised';

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export interface MetricResult {
  metric: string;
  category: MetricCategory;
  verdict: MetricVerdict;
  score: number; // 1 for pass, 0 for fail, or a quantitative count (e.g. redundant write count)
  details: {
    message: string;
    evidence?: unknown;
    /**
     * Trace event ids this verdict rests on.
     *
     * The assignment asks "Why did a particular metric produce its result?" A message
     * and a data blob answer that in prose; these answer it by pointing. The inspector
     * highlights exactly the turns and tool calls the evaluator used, so a reviewer can
     * check the reasoning rather than take it on trust.
     *
     * A score with no citable evidence is not reviewable — and an evaluator that cannot
     * name the events it looked at may not have looked at any.
     */
    evidence_events?: string[];
  };
  policy_id?: string;
  severity?: Severity;
}

export interface EvaluationSummary {
  total: number;
  passed: number;
  failed: number;
  unexercised: number;
  critical_violations: number;
}

export interface EvaluationReport {
  run_id: string;
  scenario_id: string;
  agent_version: string;
  overall_verdict: 'pass' | 'fail';
  metrics: MetricResult[];
  summary: EvaluationSummary;
  evaluated_at: number;
}

export interface EvaluatorContext {
  llmClient?: unknown;
}

/** Evaluates a specific policy referenced by a scenario. */
export type PolicyEvaluator = (
  policy: Policy,
  scenario: Scenario,
  trace: Trace,
  context?: EvaluatorContext,
) => Promise<MetricResult> | MetricResult;

/** Evaluates an expectation declared under scenario.expected_outcome. */
export type ExpectationEvaluator = (
  scenario: Scenario,
  trace: Trace,
  context?: EvaluatorContext,
) => Promise<MetricResult | MetricResult[] | null> | MetricResult | MetricResult[] | null;

/** Evaluates an unconditional process property across any trace (e.g. thrashing, budget exhaustion). */
export type ProcessEvaluator = (
  scenario: Scenario,
  trace: Trace,
  context?: EvaluatorContext,
) => Promise<MetricResult | MetricResult[]> | MetricResult | MetricResult[];

/** All valid expectation keys on scenario.expected_outcome */
export const EXPECTATION_KEYS = [
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
] as const satisfies readonly (keyof ExpectedOutcome)[];

export type ExpectationKey = (typeof EXPECTATION_KEYS)[number];
