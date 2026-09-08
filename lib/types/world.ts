/**
 * The mock clinic's data model.
 *
 * This is the ground truth surface (D7). Every metric that answers "did the work
 * actually happen" reads from here, never from the transcript. Scenario files seed
 * it; the World applies tool calls to it; evaluators diff the final state against
 * `expected_outcome.final_state`.
 *
 * Deliberately small. It is not an EHR schema — it holds exactly the fields our
 * scenarios need to distinguish correct behaviour from confident-sounding failure.
 */
import { z } from 'zod';

/** ISO-8601 local datetime, minute precision: "2026-09-15T09:30". */
export const IsoMinute = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'expected "YYYY-MM-DDTHH:mm"');

export const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected "YYYY-MM-DD"');

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export const Patient = z
  .object({
    id: z.string(),
    name: z.string(),
    dob: IsoDate,
    phone: z.string().optional(),
  })
  .strict();

export const AppointmentStatus = z.enum(['booked', 'cancelled', 'completed']);

export const Appointment = z
  .object({
    id: z.string(),
    patient: z.string(),
    provider: z.string(),
    start: IsoMinute,
    status: AppointmentStatus,
  })
  .strict();

/** An open slot. Booking one removes it; rescheduling away from a time restores one. */
export const AvailabilitySlot = z
  .object({
    provider: z.string(),
    start: IsoMinute,
  })
  .strict();

export const Medication = z
  .object({
    patient: z.string(),
    name: z.string(),
    refills_left: z.number().int().nonnegative(),
    last_filled: IsoDate.optional(),
    /** Drives the escalation policy: schedule II–V cannot be auto-approved. */
    controlled_schedule: z.enum(['II', 'III', 'IV', 'V']).optional(),
  })
  .strict();

/**
 * `name` is the chain and is deliberately NOT unique — two Walgreens is the
 * same-chain ambiguity trap in scenario B. Only `id` identifies a pharmacy.
 */
export const Pharmacy = z
  .object({
    id: z.string(),
    name: z.string(),
    address: z.string(),
    /** Marks the patient's pharmacy of record at seed time. */
    current: z.boolean().optional(),
  })
  .strict();

export const RefillRequest = z
  .object({
    id: z.string(),
    patient: z.string(),
    medication: z.string(),
    pharmacy_id: z.string(),
    status: z.enum(['submitted', 'pending_clinician_review', 'denied']),
  })
  .strict();

/** Written when the agent hands off. Its presence is the escalation ground truth. */
export const EscalationTicket = z
  .object({
    id: z.string(),
    patient: z.string().optional(),
    reason: z.string(),
    /** Context the agent passed along — measured by the handoff metric. */
    summary: z.string().optional(),
    urgency: z.enum(['routine', 'urgent', 'emergent']),
  })
  .strict();

// ---------------------------------------------------------------------------
// World state
// ---------------------------------------------------------------------------

/**
 * The complete clinic state. Snapshotted before and after every tool call so the
 * trace carries a full before/after history rather than only the final result.
 */
export const WorldState = z
  .object({
    patients: z.array(Patient).default([]),
    appointments: z.array(Appointment).default([]),
    availability: z.array(AvailabilitySlot).default([]),
    medications: z.array(Medication).default([]),
    pharmacies: z.array(Pharmacy).default([]),
    refill_requests: z.array(RefillRequest).default([]),
    escalations: z.array(EscalationTicket).default([]),
    /** Patient id -> pharmacy id. The field scenario B's silent no-op fails to write. */
    preferred_pharmacy: z.record(z.string(), z.string()).default({}),
  })
  .strict();

export type Patient = z.infer<typeof Patient>;
export type Appointment = z.infer<typeof Appointment>;
export type AvailabilitySlot = z.infer<typeof AvailabilitySlot>;
export type Medication = z.infer<typeof Medication>;
export type Pharmacy = z.infer<typeof Pharmacy>;
export type RefillRequest = z.infer<typeof RefillRequest>;
export type EscalationTicket = z.infer<typeof EscalationTicket>;
export type WorldState = z.infer<typeof WorldState>;
