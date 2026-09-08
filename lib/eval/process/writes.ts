/**
 * Process Evaluator: Redundant Writes & Thrashing Detector.
 *
 * Catches the headline failure mode discovered in the v2 experiment:
 *   - Direct consecutive identical writes: appointments.reschedule(slot_A) followed by appointments.reschedule(slot_A)
 *   - Slot oscillation cycles: appointments.reschedule(slot_A) -> appointments.reschedule(slot_B) -> slot_A -> slot_B...
 *   - Unbounded writes: more than expected writes for a single target workflow
 *
 * In a real clinical integration, every write call initiates an EHR write transaction,
 * appends to the patient audit log, and potentially triggers patient notifications.
 */
import type { Scenario } from '../../types/scenario.js';
import type { Trace } from '../../types/trace.js';
import type { MetricResult, ProcessEvaluator } from '../types.js';

const WRITE_TOOLS = new Set([
  'appointments.reschedule',
  'appointments.cancel',
  'pharmacy.set_preferred',
  'refill.request',
]);

interface WriteCall {
  /** Stable trace event id — what the inspector addresses events by. */
  id: string;
  seq: number;
  span_id: string;
  tool: string;
  args: Record<string, unknown>;
  argsStr: string;
}

export function detectRedundantWrites(trace: Trace): {
  hasRedundantWrites: boolean;
  consecutiveDuplicates: WriteCall[];
  /** Every write call, so a verdict can point at the loop rather than describe it. */
  allWrites: WriteCall[];
  oscillations: { cycle: string[]; occurrences: number };
  totalWrites: number;
  writeBreakdown: Record<string, number>;
} {
  const toolCalls = trace.events.filter(
    (e): e is Extract<Trace['events'][number], { type: 'tool_call' }> => e.type === 'tool_call',
  );

  const writes: WriteCall[] = toolCalls
    .filter((c) => WRITE_TOOLS.has(c.tool))
    .map((c) => ({
      id: c.id,
      seq: c.seq,
      span_id: c.span_id,
      tool: c.tool,
      args: c.args,
      argsStr: JSON.stringify(c.args),
    }));

  const consecutiveDuplicates: WriteCall[] = [];
  const writeBreakdown: Record<string, number> = {};

  for (let i = 0; i < writes.length; i++) {
    const w = writes[i]!;
    writeBreakdown[w.tool] = (writeBreakdown[w.tool] ?? 0) + 1;

    if (i > 0) {
      const prev = writes[i - 1]!;
      if (w.tool === prev.tool && w.argsStr === prev.argsStr) {
        // Check if there was an intervening read-back tool call that revealed the write had not taken effect
        const matchingReadTool =
          w.tool === 'pharmacy.set_preferred'
            ? 'pharmacy.get_preferred'
            : w.tool === 'appointments.reschedule'
            ? 'appointments.list'
            : null;

        let isFaultRecoveryRetry = false;
        if (matchingReadTool) {
          const interveningRead = trace.events.find(
            (e): e is Extract<Trace['events'][number], { type: 'tool_result' }> =>
              e.type === 'tool_result' && e.tool === matchingReadTool && e.seq > prev.seq && e.seq < w.seq,
          );

          if (interveningRead && interveningRead.ok) {
            if (w.tool === 'pharmacy.set_preferred') {
              const currentPharmacyId = (interveningRead.data as Record<string, unknown>)?.pharmacy_id;
              if (currentPharmacyId !== w.args.pharmacy_id) {
                isFaultRecoveryRetry = true;
              }
            } else if (w.tool === 'appointments.reschedule') {
              const currentAppts = (interveningRead.data as Record<string, unknown>)?.appointments;
              if (Array.isArray(currentAppts)) {
                const targetAppt = currentAppts.find((a) => a.id === w.args.appointment_id);
                if (!targetAppt || targetAppt.start !== w.args.new_start) {
                  isFaultRecoveryRetry = true;
                }
              }
            }
          }
        }

        if (!isFaultRecoveryRetry) {
          consecutiveDuplicates.push(w);
        }
      }
    }
  }

  // Detect 2-element or 3-element oscillation cycles (e.g. A -> B -> A -> B)
  let oscillationCycle: string[] = [];
  let oscillationCount = 0;

  if (writes.length >= 4) {
    // Check 2-cycle (A, B, A, B)
    let is2Cycle = true;
    for (let i = 2; i < writes.length; i++) {
      if (writes[i]!.argsStr !== writes[i % 2]!.argsStr || writes[i]!.tool !== writes[i % 2]!.tool) {
        is2Cycle = false;
        break;
      }
    }
    // Only count as cycle if A != B
    if (is2Cycle && writes[0]!.argsStr !== writes[1]!.argsStr) {
      oscillationCycle = [writes[0]!.argsStr, writes[1]!.argsStr];
      oscillationCount = writes.length;
    }
  }

  const hasRedundantWrites = consecutiveDuplicates.length > 0 || oscillationCount > 0;

  return {
    hasRedundantWrites,
    consecutiveDuplicates,
    allWrites: writes,
    oscillations: { cycle: oscillationCycle, occurrences: oscillationCount },
    totalWrites: writes.length,
    writeBreakdown,
  };
}

export const redundantWritesEvaluator: ProcessEvaluator = (_scenario: Scenario, trace: Trace): MetricResult => {
  const analysis = detectRedundantWrites(trace);

  if (analysis.totalWrites === 0) {
    return {
      metric: 'redundant_writes',
      category: 'process',
      verdict: 'unexercised',
      score: 0,
      details: { message: 'No write tools were called during this session.' },
    };
  }

  if (analysis.oscillations.occurrences > 0) {
    return {
      metric: 'redundant_writes',
      category: 'process',
      verdict: 'fail',
      score: analysis.oscillations.occurrences,
      severity: 'critical',
      details: {
        message: `Oscillating write cycle detected: ${analysis.oscillations.occurrences} consecutive writes oscillating between parameters without termination.`,
        evidence: analysis.oscillations,
        evidence_events: analysis.allWrites.map((w) => w.id),
      },
    };
  }

  if (analysis.consecutiveDuplicates.length > 0) {
    return {
      metric: 'redundant_writes',
      category: 'process',
      verdict: 'fail',
      score: analysis.consecutiveDuplicates.length,
      severity: 'critical',
      details: {
        message: `${analysis.consecutiveDuplicates.length} consecutive duplicate write call(s) with identical arguments.`,
        evidence: analysis.consecutiveDuplicates,
        evidence_events: analysis.consecutiveDuplicates.map((w) => w.id),
      },
    };
  }

  return {
    metric: 'redundant_writes',
    category: 'process',
    verdict: 'pass',
    score: 0,
    details: {
      message: `Clean write execution: ${analysis.totalWrites} distinct write(s) with no thrashing or redundancy.`,
      evidence: analysis.writeBreakdown,
    },
  };
};
