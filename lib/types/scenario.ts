/**
 * Scenario schema — the contract for the Part 1 dataset.
 *
 * Two properties this file exists to guarantee:
 *
 * 1. **No literal caller dialogue** (D5). Beats declare intent; the caller
 *    implementation decides wording. A scripted caller, an LLM caller, or a future
 *    TTS layer all render the same file, so swapping harness fidelity never
 *    requires rewriting the dataset.
 *
 * 2. **No vacuous expectations.** Every object is `.strict()`, so an unrecognised
 *    key is a load-time error rather than a silently dropped one. Expectation sets
 *    are refined non-empty. Without this, a typo like `tool_fault:` (singular)
 *    injects no fault, the agent legitimately succeeds, and the scenario reports
 *    PASS while testing nothing — a wrong conclusion the system cannot detect.
 */
import { z } from 'zod';
import {
  WorldState,
  Patient,
  Appointment,
  AvailabilitySlot,
  Medication,
  Pharmacy,
  RefillRequest,
  EscalationTicket,
} from './world.js';
import { ToolName } from './tools.js';

// ---------------------------------------------------------------------------
// Caller behaviour: beats
// ---------------------------------------------------------------------------

/** When a beat becomes eligible. Beats always fire in declaration order. */
const Trigger = z
  .union([
    z.literal('next_turn'),
    z.object({ at_turn: z.number().int().positive() }).strict(),
    z.object({ agent_asks_about: z.string() }).strict(),
  ])
  .default('next_turn');

const BeatBase = { when: Trigger, note: z.string().optional() };

/**
 * Opening statement.
 *
 * `text` and `segments` hold **intent descriptions in third person**, not dialogue
 * (D5). "asks for a refill on their blood pressure medication" — never a quoted line.
 * The LLM caller renders them in its own words; a scripted caller renders them
 * verbatim. Keeping the file at the level of intent is what lets harness fidelity
 * change without rewriting the dataset.
 *
 * `segments` + `pause_ms` is the endpointing proxy: the utterance
 * arrives in pieces, and an agent that commits after the first piece acts on
 * information the caller went on to correct. This tests premature commitment, not
 * acoustic endpointing — there is no VAD here.
 */
const StateGoal = z
  .object({
    kind: z.literal('state_goal'),
    text: z.string().optional(),
    segments: z.array(z.string()).min(2).optional(),
    pause_ms: z.number().int().nonnegative().optional(),
    ...BeatBase,
  })
  .strict();
// NOTE: the "exactly one of text/segments" rule is NOT enforced here. Attaching
// `.refine()` would make this a ZodEffects, which `discriminatedUnion` rejects —
// and unwrapping it back to an object silently discards the check. It is enforced
// in `Scenario.superRefine` below instead, where it actually runs.

/** Supplies persona facts the caller volunteers on request (name, DOB). */
const AnswerVerification = z
  .object({ kind: z.literal('answer_verification'), ...BeatBase })
  .strict();

// A `correct` beat (post-commitment correction: the agent already wrote the wrong
// value, the caller corrects it later, and recovery requires undoing a write) was
// defined here and used by zero scenarios. Deleted rather than carried — a beat kind
// nothing exercises has never been run. Parked as C5 in 5-7.md with the scenario that
// would justify it. Scenario B's segmented utterance is a *pre*-commitment correction
// and is a different test.

/** Caller picks from options the agent offered, by rule rather than by script. */
const ChooseOffer = z
  .object({
    kind: z.literal('choose_offer'),
    prefer: z.array(z.string()).default([]),
    reject: z.array(z.string()).default([]),
    ...BeatBase,
  })
  .strict();

/** Discloses a hidden fact, but only if the agent actually asks for it. */
const RevealIfAsked = z
  .object({
    kind: z.literal('reveal_if_asked'),
    fact: z.string(),
    ...BeatBase,
  })
  .strict();

/** Injects an urgent symptom mid-workflow to test escalation in context. */
const RedFlag = z
  .object({
    kind: z.literal('red_flag'),
    symptom: z.string(),
    expected_urgency: z.enum(['urgent', 'emergent']),
    ...BeatBase,
  })
  .strict();

/**
 * An additional request raised mid-call, distinct from the opening goal. Kept as its
 * own kind rather than a generic `say` beat: a catch-all utterance field would quietly
 * turn scenario files back into scripts (D5).
 */
const FollowUpRequest = z
  .object({ kind: z.literal('follow_up_request'), request: z.string(), ...BeatBase })
  .strict();

const Close = z.object({ kind: z.literal('close'), ...BeatBase }).strict();

export const Beat = z.discriminatedUnion('kind', [
  StateGoal,
  AnswerVerification,
  ChooseOffer,
  RevealIfAsked,
  RedFlag,
  FollowUpRequest,
  Close,
]);
export type Beat = z.infer<typeof Beat>;

// ---------------------------------------------------------------------------
// Fault injection
// ---------------------------------------------------------------------------

/**
 * `silent_no_op` is the important one: the tool returns `{ok: true}` and the world
 * does not change. The agent is not lying when it says "done" — it is failing to
 * verify. That distinction shapes how the metric is worded.
 */
export const FaultMode = z.enum([
  'error_500',
  'timeout',
  'silent_no_op',
  'partial_write',
  'malformed_response',
]);

/**
 * A transcription error injected between the caller and the agent.
 *
 * Simulates what an ASR layer does to the reasoning layer: hands the agent a
 * plausible-looking sentence with a wrong entity in it. Not audio — the agent still
 * reads text, and this must never be described as speech coverage.
 *
 * `at_beat` targets a specific beat rather than firing everywhere, because a
 * corruption the scenario did not intend makes a run unscoreable rather than hard.
 */
export const CallerFault = z
  .object({
    mode: z.enum(['asr_substitution', 'asr_digit_error', 'asr_dropout']),
    at_beat: z.number().int().nonnegative(),
    /** Optional explicit `from -> to`, which overrides the built-in confusion tables. */
    detail: z.string().optional(),
  })
  .strict();
export type CallerFault = z.infer<typeof CallerFault>;

export const ToolFault = z
  .object({
    tool: ToolName,
    mode: FaultMode,
    /** 1-indexed invocation this applies to; omit to affect every call. */
    on_call: z.number().int().positive().optional(),
    detail: z.string().optional(),
  })
  .strict();
export type ToolFault = z.infer<typeof ToolFault>;

// ---------------------------------------------------------------------------
// Expected outcome
// ---------------------------------------------------------------------------

const NonEmptyRecord = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
  .refine((o) => Object.keys(o).length > 0, 'must declare at least one entry');

/**
 * The subset of world state that must hold when the call ends.
 *
 * Deep-partial: a scenario declares only the fields that must be true, and the
 * comparator subset-matches. Escalation tickets carry agent-authored free text
 * (`reason`, `summary`) that cannot be predicted, so demanding whole-object equality
 * would make escalation outcomes unexpressible.
 *
 * Each declared element must name at least one field — an empty `{}` would match any
 * record and silently assert nothing.
 */
const expected = <T extends z.ZodObject<z.ZodRawShape>>(schema: T) =>
  schema.partial().refine(
    (o) => Object.keys(o).length > 0,
    'declare at least one field, or omit the entry entirely',
  );

const PartialWorldState = z
  .object({
    patients: z.array(expected(Patient)).optional(),
    appointments: z.array(expected(Appointment)).optional(),
    availability: z.array(expected(AvailabilitySlot)).optional(),
    medications: z.array(expected(Medication)).optional(),
    pharmacies: z.array(expected(Pharmacy)).optional(),
    refill_requests: z.array(expected(RefillRequest)).optional(),
    escalations: z.array(expected(EscalationTicket)).optional(),
    preferred_pharmacy: z.record(z.string(), z.string()).optional(),
  })
  .strict();

/**
 * A request the agent has no tool to perform.
 *
 * This is the one failure mechanism state comparison cannot reach: nothing was
 * attempted, so there is no failed write to find and no `ok: true` masking an
 * unchanged row. The only evidence is what the agent said. Evaluated by an LLM judge
 * against `no_tool_because`, with human calibration.
 */
const UnsupportedRequest = z
  .object({
    request: z.string().min(1),
    /** Why no tool covers it. Passed verbatim to the judge so it is not guessing. */
    no_tool_because: z.string().min(1),
  })
  .strict();

/**
 * Criteria for a scenario that must escalate. Required whenever
 * `must_escalate: true` — a scenario that demands escalation without saying how fast,
 * how urgently, or carrying what context asserts almost nothing.
 */
const EscalationExpectation = z
  .object({
    /** Turns allowed between the triggering beat and the handoff. 0 = same turn. */
    max_turns_after_trigger: z.number().int().nonnegative(),
    min_urgency: z.enum(['routine', 'urgent', 'emergent']),
    /**
     * Substrings the handoff summary must contain — does the reason for escalating
     * survive the handoff, or does staff receive an empty ticket? Crude by design:
     * keyword presence, not comprehension. Its failure mode is a summary that mentions
     * the term incidentally, which is recorded as a known limitation rather than fixed
     * with a second LLM call.
     */
    summary_must_mention: z.array(z.string()).default([]),
    /** Tools the agent must not call between trigger and handoff. */
    forbidden_between_trigger_and_escalation: z.array(ToolName).default([]),
    /**
     * Index of the beat that creates the escalation requirement — the point
     * `max_turns_after_trigger` is measured from. Inferred as the `red_flag` beat when
     * there is one; must be declared otherwise, or latency is measured from an
     * arbitrary turn and the number means nothing.
     */
    trigger_beat: z.number().int().nonnegative().optional(),
  })
  .strict();

const ExpectedOutcome = z
  .object({
    /** Required, never optional: `undefined` would make the escalation check vanish. */
    must_escalate: z.boolean(),
    final_state: PartialWorldState.optional(),
    critical_entities: NonEmptyRecord,
    /** Enforces policy ordering, e.g. verify identity before disclosing records. */
    required_tool_order: z.array(ToolName).optional(),
    forbidden_tools: z.array(ToolName).optional(),
    agent_memory_expected: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional(),
    /**
     * Key -> how many times the agent should have written it. A mid-call correction
     * means 2: the initial value, then an overwrite. 1 means it never updated;
     * appending a second key instead of overwriting shows up as 1 here too.
     */
    expected_memory_writes: z.record(z.string(), z.number().int().nonnegative()).optional(),
    /** Requires a read-back call after a write before the agent may confirm. */
    must_read_back_after_write: z.boolean().default(false),
    must_not_assert_completion_unless_state_confirms: z.boolean().default(true),
    escalation: EscalationExpectation.optional(),
    unsupported_requests: z.array(UnsupportedRequest).min(1).optional(),
  })
  .strict()
  .refine(
    (e) => !e.must_escalate || !!e.escalation,
    { path: ['escalation'], message: 'must_escalate: true requires an `escalation` block' },
  );
export type ExpectedOutcome = z.infer<typeof ExpectedOutcome>;

/** A different-but-correct outcome. Matching any variant counts as a pass. */
const AcceptableVariant = z
  .object({
    reason: z.string(),
    final_state: PartialWorldState.optional(),
    critical_entities: NonEmptyRecord.optional(),
  })
  .strict()
  .refine(
    (v) => v.final_state || v.critical_entities,
    'a variant must relax something — declare final_state or critical_entities',
  );

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

export const Scenario = z
  .object({
    id: z.string().min(1),
    workflow: z.enum(['appointment_reschedule', 'prescription_refill']),
    difficulty: z.enum(['ordinary', 'hard']),
    /**
     * `control` scenarios are ones where escalating or transferring would be WRONG.
     * They are what stop an agent from scoring well on safety by escalating everything.
     */
    role: z.enum(['control', 'headline', 'ablation', 'standard']),
    caller_goal: z.string().min(1),

    /** Facts the caller volunteers freely. */
    persona_facts: z.record(z.string(), z.string()).default({}),
    /** Facts the caller discloses only when asked. Never visible to the agent. */
    hidden_facts: z.record(z.string(), z.string()).default({}),

    turn_plan: z.array(Beat).min(1),
    world_state: WorldState,
    tool_faults: z.array(ToolFault).default([]),
    caller_faults: z.array(CallerFault).default([]),
    policy_refs: z.array(z.string()).default([]),

    expected_outcome: ExpectedOutcome,
    acceptable_variants: z.array(AcceptableVariant).default([]),

    /** Set on inherited scenarios; resolved away before validation. */
    extends: z.string().optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    // Cross-field beat rules live here rather than on the beat schemas themselves:
    // `discriminatedUnion` cannot hold refined objects, so a refinement declared up
    // there would be silently dropped instead of enforced.
    s.turn_plan.forEach((beat, i) => {
      // A red-flag beat is a trigger the dataset has planted on purpose. Pairing one
      // with `must_escalate: false` means the scenario stages an urgent symptom and
      // then declines to check what the agent did about it.
      if (beat.kind === 'red_flag' && !s.expected_outcome.must_escalate) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['expected_outcome', 'must_escalate'],
          message: 'a red_flag beat requires must_escalate: true',
        });
      }
      if (beat.kind !== 'state_goal') return;
      if (!!beat.text === !!beat.segments) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['turn_plan', i],
          message: 'state_goal needs exactly one of `text` or `segments`',
        });
      }
      if (beat.segments && beat.pause_ms === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['turn_plan', i, 'pause_ms'],
          message: 'segmented utterances must declare pause_ms — it is the endpointing signal',
        });
      }
    });

    // A hidden fact with no `reveal_if_asked` beat can never be disclosed. It reads
    // like evidence design and is dead data — and worse, it makes leak detection
    // meaningless, since a fact that cannot be revealed cannot be revealed early.
    const disclosable = new Set(
      s.turn_plan.flatMap((b) => (b.kind === 'reveal_if_asked' ? [b.fact] : [])),
    );
    for (const key of Object.keys(s.hidden_facts)) {
      if (!disclosable.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['hidden_facts', key],
          message: `no reveal_if_asked beat discloses "${key}" — it can never reach the caller's mouth`,
        });
      }
    }
    for (const b of s.turn_plan) {
      if (b.kind === 'reveal_if_asked' && !(b.fact in s.hidden_facts)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['turn_plan'],
          message: `reveal_if_asked names "${b.fact}", which is not in hidden_facts`,
        });
      }
    }

    for (const [i, f] of s.caller_faults.entries()) {
      if (f.at_beat >= s.turn_plan.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['caller_faults', i, 'at_beat'],
          message: `beat ${f.at_beat} does not exist (turn_plan has ${s.turn_plan.length})`,
        });
      }
    }

    const esc = s.expected_outcome.escalation;
    if (esc && esc.trigger_beat === undefined && !s.turn_plan.some((b) => b.kind === 'red_flag')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expected_outcome', 'escalation', 'trigger_beat'],
        message:
          'no red_flag beat to infer the trigger from — declare trigger_beat, or escalation latency is measured from an arbitrary turn',
      });
    }
    if (esc?.trigger_beat !== undefined && esc.trigger_beat >= s.turn_plan.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expected_outcome', 'escalation', 'trigger_beat'],
        message: `trigger_beat ${esc.trigger_beat} is past the end of turn_plan (${s.turn_plan.length} beats)`,
      });
    }
  });

export type Scenario = z.infer<typeof Scenario>;

/** Raw shape of an inheriting file, before the parent is merged in. */
export const ScenarioPatch = z
  .object({
    id: z.string().min(1),
    extends: z.string().min(1),
    role: z.enum(['control', 'headline', 'ablation', 'standard']).optional(),
    overrides: z.record(z.string(), z.unknown()),
  })
  .strict();
export type ScenarioPatch = z.infer<typeof ScenarioPatch>;
