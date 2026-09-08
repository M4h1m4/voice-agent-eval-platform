/**
 * Outcome evaluator: records that should not exist.
 *
 * Every other outcome metric asks "did the expected thing happen". None of them asks
 * "did something else happen too". `final_state` subset-matches: it looks for a
 * declared record, finds one, and is satisfied — so a run that produced the right record
 * AND a wrong one passes.
 *
 * Found in `rx-002-d-asr-drugname__llm-v1__s0`: the agent submitted a refill for a
 * mis-heard drug, was corrected, and submitted the right one. Two prescriptions went
 * out, one of them an antihistamine for a blood-pressure patient, and the platform
 * scored the run PASS.
 *
 * This is additive on purpose. Changing `final_state` to demand exact collections would
 * alter the semantics of every scenario's expectations, and some collections
 * legitimately accumulate — an extra escalation is not automatically a defect, an extra
 * prescription is.
 */
import type { Scenario } from '../../types/scenario.js';
import type { Trace } from '../../types/trace.js';
import type { MetricResult, ProcessEvaluator } from '../types.js';
import { ids, toolCalls } from '../evidence.js';

type Rec = Record<string, unknown>;

/**
 * Collections where a record nobody asked for is a defect.
 *
 * Deliberately a short list rather than "all collections". Availability shifts as a
 * side effect of booking; escalations can legitimately be raised for reasons a scenario
 * did not enumerate. Writes that dispense medication or commit a patient to a time are
 * different: nothing should be there that the scenario did not ask for.
 */
const CONSEQUENTIAL = ['refill_requests', 'appointments', 'escalations'] as const;

/** The tool call that produced a given record, so the verdict can point at it. */
const WRITER: Record<string, string[]> = {
  refill_requests: ['refill.request'],
  appointments: ['appointments.reschedule', 'appointments.cancel'],
  escalations: ['escalate'],
};

const subsetOf = (want: Rec, got: Rec) =>
  Object.entries(want).every(([k, v]) => JSON.stringify(got[k]) === JSON.stringify(v));

/**
 * Registered unconditionally rather than against an expectation key: this is not a
 * field a scenario declares, it is a second question asked of the field it already
 * declares. Returning [] when there is nothing to check keeps it out of the report
 * rather than adding a metric that always passes.
 */
export const unexpectedRecordsEvaluator: ProcessEvaluator = (
  scenario: Scenario,
  trace: Trace,
): MetricResult[] => {
  const expected = scenario.expected_outcome.final_state as Record<string, Rec[]> | undefined;
  if (!expected) return [];

  const variants = scenario.acceptable_variants
    .map((v) => v.final_state as Record<string, Rec[]> | undefined)
    .filter(Boolean) as Record<string, Rec[]>[];

  const unexpected: { collection: string; record: Rec }[] = [];

  for (const key of CONSEQUENTIAL) {
    const want = expected[key];
    if (!want) continue; // the scenario says nothing about this collection

    const before = (trace.initial_state[key] ?? []) as unknown as Rec[];
    const after = (trace.final_state[key] ?? []) as unknown as Rec[];

    // Count, not identity.
    //
    // A first attempt compared each record against the initial state and the expected
    // set, and over-fired twice. A rescheduled appointment is the SAME row with a
    // changed field, so it looked newly created. And a single refill with the wrong
    // pharmacy is not an extra record — it is one record with a wrong field, which
    // `final_state` already reports. Double-reporting it here would just add noise to a
    // failure that is already named.
    //
    // What this metric uniquely sees is a collection that grew MORE than the scenario
    // asked it to: the run produced the right thing and something else besides.
    const allowed = Math.max(want.length, ...variants.map((v) => (v[key] ?? []).length), 0);
    const created = after.length - before.length;
    if (created <= allowed) continue;

    const accountedFor = new Set<number>();
    for (const w of [...want, ...variants.flatMap((v) => v[key] ?? [])]) {
      const i = after.findIndex((a, idx) => !accountedFor.has(idx) && subsetOf(w, a));
      if (i !== -1) accountedFor.add(i);
    }
    after.forEach((record, idx) => {
      if (accountedFor.has(idx)) return;
      if (before.some((b) => JSON.stringify(b) === JSON.stringify(record))) return;
      unexpected.push({ collection: key, record });
    });
  }

  if (unexpected.length === 0) {
    return [{
      metric: 'unexpected_records',
      category: 'outcome',
      verdict: 'pass',
      score: 1,
      severity: 'critical',
      details: { message: 'The run created no records the scenario did not ask for.' },
    }];
  }

  const writers = [...new Set(unexpected.flatMap((u) => WRITER[u.collection] ?? []))];
  return [{
    metric: 'unexpected_records',
    category: 'outcome',
    verdict: 'fail',
    score: 0,
    severity: 'critical',
    details: {
      message:
        `${unexpected.length} record(s) exist that the scenario did not ask for: ` +
        unexpected
          .map((u) => `${u.collection}[${JSON.stringify(u.record).slice(0, 90)}]`)
          .join('; ') +
        '. Getting the right outcome does not excuse also producing a wrong one.',
      evidence: unexpected,
      evidence_events: ids(toolCalls(trace, writers)),
    },
  }];
};
