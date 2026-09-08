/**
 * Workflow and safety policies.
 *
 * Policies are data, not code branches, for two reasons: Part 7 asks about
 * customer-specific policies (a customer gets a policy file, not a fork), and a
 * policy needs a plain-English `statement` that can be shown in the UI next to a
 * violation and pasted into a judge prompt. The `check` descriptor names which
 * deterministic evaluator enforces it.
 */
import { z } from 'zod';
import { ToolName } from './tools.js';

/** Tool A must be called before tool B. Identity verification before disclosure. */
const OrderingCheck = z
  .object({
    kind: z.literal('ordering'),
    must_precede: z.array(ToolName).min(1),
    targets: z.array(ToolName).min(1),
  })
  .strict();

/**
 * If a search returned several records indistinguishable on `ambiguous_on`, the agent
 * must ask before writing. Two Walgreens differ only by address; a transcript where
 * the agent says "sending it to Walgreens" reads perfectly and may still be wrong.
 */
const DisambiguationCheck = z
  .object({
    kind: z.literal('disambiguation'),
    search_tool: ToolName,
    write_tool: ToolName,
    ambiguous_on: z.string(),
  })
  .strict();

/** A write must be followed by a read confirming it before the agent claims success. */
const ReadBackCheck = z
  .object({
    kind: z.literal('read_back'),
    write_tools: z.array(ToolName).min(1),
    read_tools: z.array(ToolName).min(1),
  })
  .strict();

/** Some conditions may never be auto-completed. */
const EscalationCheck = z
  .object({
    kind: z.literal('escalation_required'),
    condition: z.enum(['controlled_substance', 'red_flag_symptom', 'refill_too_soon']),
    min_urgency: z.enum(['routine', 'urgent', 'emergent']),
  })
  .strict();

/**
 * The agent must not assert an action it has no tool to perform.
 *
 * Marked `evaluator: llm_judge` explicitly. Every other check in this file is
 * computed from the trace; this one is a judgement call, and the policy file is the
 * right place to say so rather than leaving it implicit in the evaluator code.
 */
const NoFabricatedCapabilityCheck = z
  .object({
    kind: z.literal('no_fabricated_capability'),
    evaluator: z.literal('llm_judge'),
  })
  .strict();

export const PolicyCheck = z.discriminatedUnion('kind', [
  OrderingCheck,
  DisambiguationCheck,
  ReadBackCheck,
  EscalationCheck,
  NoFabricatedCapabilityCheck,
]);

export const Policy = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    /** Plain English. Rendered in the UI beside violations and reused in judge prompts. */
    statement: z.string().min(1),
    /** Drives triage order in the failure view, not pass/fail. */
    severity: z.enum(['low', 'medium', 'high', 'critical']),
    check: PolicyCheck,
  })
  .strict();
export type Policy = z.infer<typeof Policy>;
export type PolicyCheck = z.infer<typeof PolicyCheck>;

export const PolicyFile = z.object({ policies: z.array(Policy).min(1) }).strict();
