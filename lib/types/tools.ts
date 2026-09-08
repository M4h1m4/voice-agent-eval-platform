/**
 * The tool catalog — the only interface between the agent and the world.
 *
 * Two design notes that matter for evaluation:
 *
 * 1. Read-back tools exist. `pharmacy.get_preferred` and `appointments.list` let an
 *    agent verify a write before confirming it to the caller. Without them the
 *    v2 prompt instruction ("verify before you confirm") would be unfollowable, and
 *    the Part 5 experiment would measure prompt wording rather than behaviour.
 *
 * 2. `memory.write` is a real tool (D6). Memory mutations land in the trace with
 *    before/after values, so "did the agent overwrite the corrected value or keep
 *    the stale one" is a deterministic check instead of a transcript inference.
 */
import { z } from 'zod';
import { IsoDate, IsoMinute } from './world.js';

export const ToolName = z.enum([
  'patients.verify',
  'appointments.list',
  'availability.search',
  'appointments.reschedule',
  'appointments.cancel',
  'medications.list',
  'pharmacies.search',
  'pharmacy.get_preferred',
  'pharmacy.set_preferred',
  'refill.request',
  'escalate',
  'memory.write',
]);
export type ToolName = z.infer<typeof ToolName>;

/** Argument schemas, keyed by tool name. The World validates against these. */
export const TOOL_ARGS = {
  'patients.verify': z.object({ name: z.string(), dob: IsoDate }).strict(),

  'appointments.list': z.object({ patient_id: z.string() }).strict(),

  'availability.search': z
    .object({
      provider: z.string(),
      after: IsoMinute.optional(),
      before: IsoMinute.optional(),
    })
    .strict(),

  'appointments.reschedule': z
    .object({ appointment_id: z.string(), new_start: IsoMinute })
    .strict(),

  'appointments.cancel': z.object({ appointment_id: z.string() }).strict(),

  'medications.list': z.object({ patient_id: z.string() }).strict(),

  /** Searching by chain name returns every match — this is where B's trap surfaces. */
  'pharmacies.search': z.object({ name: z.string().optional() }).strict(),

  'pharmacy.get_preferred': z.object({ patient_id: z.string() }).strict(),

  'pharmacy.set_preferred': z
    .object({ patient_id: z.string(), pharmacy_id: z.string() })
    .strict(),

  'refill.request': z
    .object({
      patient_id: z.string(),
      medication: z.string(),
      pharmacy_id: z.string(),
    })
    .strict(),

  'escalate': z
    .object({
      patient_id: z.string().optional(),
      reason: z.string(),
      urgency: z.enum(['routine', 'urgent', 'emergent']),
      /** Context handed to staff. Empty summaries are a handoff failure, not a pass. */
      summary: z.string(),
    })
    .strict(),

  'memory.write': z
    .object({
      key: z.string(),
      value: z.unknown(),
      /** Forces the agent to state why it is writing — useful signal in disagreements. */
      reason: z.string(),
    })
    .strict(),
} as const satisfies Record<ToolName, z.ZodTypeAny>;

export const ToolCall = z
  .object({
    name: ToolName,
    args: z.record(z.string(), z.unknown()),
  })
  .strict();
export type ToolCall = z.infer<typeof ToolCall>;

/**
 * Tool outcome. `ok: true` does not imply the world changed — that is the entire
 * point of the `silent_no_op` fault, and why completion is measured from state.
 */
export const ToolResult = z
  .object({
    ok: z.boolean(),
    data: z.unknown().optional(),
    error: z.string().optional(),
    /** Set when a fault shaped this result, for trace inspection. Never shown to the agent. */
    fault_applied: z.string().optional(),
  })
  .strict();
export type ToolResult = z.infer<typeof ToolResult>;

/** Parse a call's arguments against its tool's schema. */
export function parseToolArgs(name: ToolName, args: unknown) {
  return TOOL_ARGS[name].safeParse(args);
}
