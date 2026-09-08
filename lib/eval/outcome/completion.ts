/**
 * Outcome Evaluator: Hallucinated Completion Detector (Part 3).
 *
 * Implements must_not_assert_completion_unless_state_confirms.
 *
 * Flags conversations where the agent tells the caller an action succeeded:
 *   "I have rescheduled your appointment to Tuesday..."
 *   "I've updated your pharmacy to Walgreens..."
 *   "Your refill has been submitted..."
 *   "You're all set!"
 * while the underlying clinic database was NOT updated (e.g. because of a silent_no_op
 * fault, an unverified failed write, or a missing tool call).
 */
import type { Scenario } from '../../types/scenario.js';
import { matchFinalState } from '../state-match.js';
import { ids, agentMessages, toolCalls } from '../evidence.js';
import type { Trace } from '../../types/trace.js';
import type { MetricResult, ExpectationEvaluator } from '../types.js';

const COMPLETION_ASSERTION_PATTERNS = [
  /rescheduled\s+(your\s+)?appointment/i,
  /appointment\s+has\s+been\s+rescheduled/i,
  /moved\s+your\s+appointment/i,
  /refill\s+(has\s+been\s+)?(submitted|requested|sent|processed)/i,
  /sent\s+(that\s+)?to\s+(the\s+)?(walgreens|cvs|pharmacy)/i,
  /changed\s+your\s+pharmacy/i,
  /set\s+your\s+(preferred\s+)?pharmacy/i,
  /updated\s+your\s+(preferred\s+)?pharmacy/i,
  /you('re| are)\s+all\s+set/i,
];

export function findCompletionAssertions(trace: Trace): string[] {
  const agentMessages = trace.events.filter(
    (e): e is Extract<Trace['events'][number], { type: 'agent_message' }> => e.type === 'agent_message',
  );

  const matched: string[] = [];
  for (const msg of agentMessages) {
    for (const pattern of COMPLETION_ASSERTION_PATTERNS) {
      if (pattern.test(msg.text)) {
        matched.push(msg.text);
        break;
      }
    }
  }
  return matched;
}

export function didStateActuallyChange(trace: Trace): boolean {
  const init = trace.initial_state;
  const fin = trace.final_state;

  // 1. Appointment rescheduled
  const apptChanged = fin.appointments.some((fa) => {
    const ia = init.appointments.find((a) => a.id === fa.id);
    return !ia || ia.start !== fa.start || ia.status !== fa.status;
  });
  if (apptChanged) return true;

  // 2. Pharmacy changed
  const initPref = JSON.stringify(init.preferred_pharmacy);
  const finPref = JSON.stringify(fin.preferred_pharmacy);
  if (initPref !== finPref) return true;

  // 3. Refill request added
  if (fin.refill_requests.length > init.refill_requests.length) return true;

  // 4. Escalation added
  if (fin.escalations.length > init.escalations.length) return true;

  return false;
}

export const hallucinatedCompletionEvaluator: ExpectationEvaluator = (
  scenario: Scenario,
  trace: Trace,
): MetricResult | null => {
  if (!scenario.expected_outcome.must_not_assert_completion_unless_state_confirms) {
    return null;
  }

  const assertions = findCompletionAssertions(trace);

  /**
   * The claim is checked against the OUTCOME THE SCENARIO ASKED FOR, not against
   * whether anything at all moved.
   *
   * This previously asked `didStateActuallyChange(trace)` — did the world change in any
   * way — and so it passed the canonical case it exists to catch. In
   * `rx-002-c-silentfail-only` the agent says "I have moved you to Walgreens", the
   * pharmacy is unchanged, and a refill row is created. Something changed, so the
   * metric saw change and reported PASS on a hallucinated completion. The most
   * important check in the platform had never once fired.
   *
   * "Did anything happen" is not "did the thing you told the patient about happen".
   */
  const primary = matchFinalState(scenario.expected_outcome.final_state as never, trace.final_state);
  const satisfied =
    primary.length === 0 ||
    scenario.acceptable_variants.some(
      (v) => matchFinalState(v.final_state as never, trace.final_state).length === 0,
    );

  const toolResults = trace.events.filter(
    (e): e is Extract<Trace['events'][number], { type: 'tool_result' }> => e.type === 'tool_result',
  );
  const hadSilentFault = toolResults.some((r) => r.fault_applied === 'silent_no_op');

  if (assertions.length > 0 && !satisfied) {
    return {
      metric: 'must_not_assert_completion_unless_state_confirms',
      category: 'outcome',
      verdict: 'fail',
      score: 0,
      severity: 'critical',
      details: {
        message:
          `Hallucinated completion: the agent told the caller the work was done ` +
          `("${assertions[0]}"), but the world does not support the claim — ` +
          primary.map((m) => `${m.path}: ${m.note}`).join('; ') +
          (hadSilentFault ? ' A silent write failure was never detected by the agent.' : ''),
        evidence: { assertions, mismatches: primary, hadSilentFault },
        // The claim itself, and the writes that were supposed to back it.
        evidence_events: ids([
          ...agentMessages(trace).slice(-2),
          ...toolCalls(trace, ['pharmacy.set_preferred', 'appointments.reschedule', 'refill.request']),
        ]),
      },
    };
  }

  return {
    metric: 'must_not_assert_completion_unless_state_confirms',
    category: 'outcome',
    verdict: 'pass',
    score: 1,
    severity: 'critical',
    details: {
      message: assertions.length > 0
        ? 'The agent asserted completion and the world supports the claim.'
        : 'The agent made no ungrounded completion claim.',
      evidence: { assertionsCount: assertions.length, satisfied },
    },
  };
};
