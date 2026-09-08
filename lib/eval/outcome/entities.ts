/**
 * Outcome Evaluator: Critical Entity Accuracy (Part 3).
 *
 * Verifies that critical entities declared in scenario.expected_outcome.critical_entities
 * (e.g. appointment_id, new_start, pharmacy_id, medication) were accurately targeted
 * in the agent's tool calls and reflected in state.
 */
import type { Scenario } from '../../types/scenario.js';
import type { Trace } from '../../types/trace.js';
import type { MetricResult, ExpectationEvaluator } from '../types.js';

export function matchEntity(
  key: string,
  expectedVal: unknown,
  trace: Trace,
): { matched: boolean; actualVal?: unknown } {
  const toolCalls = trace.events.filter(
    (e): e is Extract<Trace['events'][number], { type: 'tool_call' }> => e.type === 'tool_call',
  );

  // 1. Check tool call arguments in reverse chronological order (latest write)
  for (let i = toolCalls.length - 1; i >= 0; i--) {
    const args = toolCalls[i]!.args as Record<string, unknown>;
    if (args[key] !== undefined) {
      if (args[key] === expectedVal) {
        return { matched: true, actualVal: args[key] };
      }
      return { matched: false, actualVal: args[key] };
    }
  }

  // 2. Check world state records if not directly in tool args
  if (key === 'new_start') {
    const booked = trace.final_state.appointments.find((a) => a.start === expectedVal);
    if (booked) return { matched: true, actualVal: booked.start };
    const latest = trace.final_state.appointments[0]?.start;
    return { matched: false, actualVal: latest };
  }

  if (key === 'pharmacy_id') {
    const pref = Object.values(trace.final_state.preferred_pharmacy);
    if (pref.includes(expectedVal as string)) return { matched: true, actualVal: expectedVal };
    const req = trace.final_state.refill_requests.find((r) => r.pharmacy_id === expectedVal);
    if (req) return { matched: true, actualVal: req.pharmacy_id };
    return { matched: false, actualVal: pref[0] ?? null };
  }

  if (key === 'appointment_id') {
    const appt = trace.final_state.appointments.find((a) => a.id === expectedVal);
    if (appt) return { matched: true, actualVal: appt.id };
    return { matched: false, actualVal: trace.final_state.appointments[0]?.id };
  }

  if (key === 'escalation_urgency') {
    const esc = trace.final_state.escalations[0];
    const toolCall = toolCalls.find((c) => c.tool === 'escalate');
    const actualUrgency = esc?.urgency ?? (toolCall?.args as Record<string, unknown> | undefined)?.urgency;
    if (actualUrgency === expectedVal) return { matched: true, actualVal: actualUrgency };
    return { matched: false, actualVal: actualUrgency };
  }

  if (key === 'medication') {
    const req = trace.final_state.refill_requests.find((r) => r.medication === expectedVal);
    if (req) return { matched: true, actualVal: req.medication };
    return { matched: false, actualVal: trace.final_state.refill_requests[0]?.medication };
  }

  return { matched: false, actualVal: undefined };
}

export const criticalEntitiesEvaluator: ExpectationEvaluator = (
  scenario: Scenario,
  trace: Trace,
): MetricResult | null => {
  const expected = scenario.expected_outcome.critical_entities;
  if (!expected || Object.keys(expected).length === 0) return null;

  const mismatches: { key: string; expected: unknown; actual: unknown }[] = [];

  for (const [key, val] of Object.entries(expected)) {
    const res = matchEntity(key, val, trace);
    if (!res.matched) {
      mismatches.push({ key, expected: val, actual: res.actualVal });
    }
  }

  // Check acceptable variants
  if (mismatches.length > 0) {
    for (const variant of scenario.acceptable_variants) {
      if (variant.critical_entities) {
        let variantMatches = true;
        for (const [vKey, vVal] of Object.entries(variant.critical_entities)) {
          if (!matchEntity(vKey, vVal, trace).matched) {
            variantMatches = false;
            break;
          }
        }
        if (variantMatches) {
          return {
            metric: 'critical_entities',
            category: 'outcome',
            verdict: 'pass',
            score: 1,
            severity: 'critical',
            details: {
              message: `Critical entities match acceptable variant: ${variant.reason}`,
              evidence: variant.critical_entities,
            },
          };
        }
      }
    }
  }

  const passed = mismatches.length === 0;

  return {
    metric: 'critical_entities',
    category: 'outcome',
    verdict: passed ? 'pass' : 'fail',
    score: passed ? 1 : 0,
    severity: 'critical',
    details: {
      message: passed
        ? 'All critical entities (IDs, timestamps, selections) matched target values.'
        : `Critical entity mismatch: ${mismatches.map((m) => `${m.key} (expected "${m.expected}", got "${m.actual}")`).join('; ')}`,
      evidence: mismatches,
    },
  };
};
