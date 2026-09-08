/**
 * Trace schema — the contract between the harness and the application (D1).
 *
 * Per D9 this borrows OpenTelemetry's identifiers and timing/status vocabulary
 * (`trace_id`, `span_id`, `parent_span_id`, `start_time`, `end_time`, `status`) so
 * the causal tree comes for free and an OTLP ingestion adapter stays thin — but it
 * stores a typed, ordered event log rather than spans, because evaluators query
 * nested payloads that OTel's flat primitive attributes would force into opaque
 * JSON strings.
 *
 * OTel is the wire format, not the storage model.
 */
import { z } from 'zod';
import { WorldState } from './world.js';
import { ToolName } from './tools.js';

export const SpanStatus = z.enum(['OK', 'ERROR']);

/** Fields every event carries. `seq` gives total order; span ids give the tree. */
const EventBase = {
  /** Stable id. Evaluators cite these as evidence, so the UI can jump to them. */
  id: z.string(),
  seq: z.number().int().nonnegative(),
  trace_id: z.string(),
  span_id: z.string(),
  parent_span_id: z.string().nullable(),
  start_time: z.number(),
  end_time: z.number(),
  status: SpanStatus.default('OK'),
};

/** What the simulated caller said, and which beat produced it. */
const CallerTurn = z
  .object({
    type: z.literal('caller_turn'),
    text: z.string(),
    beat_kind: z.string(),
    beat_index: z.number().int().nonnegative(),
    /** Set when a segmented utterance is delivered in pieces (endpointing proxy). */
    segment_index: z.number().int().nonnegative().optional(),
    /**
     * What the caller actually said, when a transcription fault corrupted it.
     *
     * `text` is what the AGENT received. Both are required or the scenario becomes
     * unscoreable: ground truth would be corrupted along with the input, and the
     * evaluator would be comparing against the very error it is meant to detect.
     */
    text_intended: z.string().optional(),
    asr_fault: z.string().optional(),
    ...EventBase,
  })
  .strict();

const AgentMessage = z
  .object({ type: z.literal('agent_message'), text: z.string(), ...EventBase })
  .strict();

const ToolCallEvent = z
  .object({
    type: z.literal('tool_call'),
    tool: ToolName,
    args: z.record(z.string(), z.unknown()),
    ...EventBase,
  })
  .strict();

/**
 * `ok: true` does not imply the world changed — see the `silent_no_op` fault.
 * `state_before`/`state_after` are what make that detectable at all.
 */
const ToolResultEvent = z
  .object({
    type: z.literal('tool_result'),
    tool: ToolName,
    ok: z.boolean(),
    data: z.unknown().optional(),
    error: z.string().optional(),
    /** Which fault shaped this result. Recorded for inspection, never sent to the agent. */
    fault_applied: z.string().nullable().default(null),
    state_before: WorldState,
    state_after: WorldState,
    ...EventBase,
  })
  .strict();

/**
 * Memory as a first-class event (D6): before/after make "did the agent overwrite the
 * corrected value or keep the stale one" a deterministic check.
 */
const MemoryWrite = z
  .object({
    type: z.literal('memory_write'),
    key: z.string(),
    before: z.unknown().nullable(),
    after: z.unknown(),
    reason: z.string(),
    ...EventBase,
  })
  .strict();

/** LLM invocation. Attribute names follow OTel's GenAI semantic conventions. */
const LlmCall = z
  .object({
    type: z.literal('llm_call'),
    /** Which actor made the call — the agent and the caller must stay separate (D2). */
    actor: z.enum(['agent', 'caller', 'judge']),
    'gen_ai.system': z.string(),
    'gen_ai.request.model': z.string(),
    'gen_ai.request.temperature': z.number().optional(),
    'gen_ai.usage.input_tokens': z.number().int().optional(),
    'gen_ai.usage.output_tokens': z.number().int().optional(),
    /** Hash of the rendered prompt. Keys the replay cache, so reviewers need no API key. */
    prompt_hash: z.string(),
    cache_hit: z.boolean().default(false),
    ...EventBase,
  })
  .strict();

const ErrorEvent = z
  .object({
    type: z.literal('error'),
    message: z.string(),
    where: z.string(),
    ...EventBase,
  })
  .strict();

export const TraceEvent = z.discriminatedUnion('type', [
  CallerTurn,
  AgentMessage,
  ToolCallEvent,
  ToolResultEvent,
  MemoryWrite,
  LlmCall,
  ErrorEvent,
]);
export type TraceEvent = z.infer<typeof TraceEvent>;

/**
 * Why the call ended. `max_turns` and `max_tool_calls` are recorded as distinct
 * outcomes rather than errors: an agent thrashing on a failing tool is a real
 * production behaviour worth catching, not noise to hide.
 */
export const Termination = z.enum([
  'agent_ended',
  'caller_hangup',
  'escalated',
  'max_turns',
  'max_tool_calls',
  'harness_error',
]);
export type Termination = z.infer<typeof Termination>;

export const Trace = z
  .object({
    run_id: z.string(),
    trace_id: z.string(),
    scenario_id: z.string(),
    agent_version: z.string(),
    /** Seed + mode are what make a run reproducible. */
    seed: z.number().int(),
    /**
     * Which caller drove the run.
     *
     * An LLM caller reacts to the agent's words, so two agent versions face materially
     * different callers — realistic, but a confound in an A/B comparison. A scripted
     * caller is byte-identical across arms and gives a controlled contrast. Both are
     * worth running; which one produced a trace has to be recorded or the two cannot be
     * told apart afterwards (D26).
     */
    caller: z.enum(['scripted', 'llm']).default('scripted'),
    /**
     * The limits this run executed under.
     *
     * Recorded because a verdict can depend on them. In the v2 experiment the agent
     * entered an unbounded write loop and the run's FINAL STATE was decided by where
     * the tool-call cap happened to fall — correct at one cap, wrong at another. A
     * trace that does not say which cap applied cannot be interpreted, and the most
     * important finding in the project would rest on a number stored nowhere (D25).
     */
    limits: z
      .object({
        maxTurns: z.number().int().positive(),
        maxToolCallsPerTurn: z.number().int().positive(),
        maxToolCallsTotal: z.number().int().positive(),
      })
      .strict(),
    mode: z.enum(['live', 'replay']),
    started_at: z.number(),
    ended_at: z.number(),
    termination: Termination,
    initial_state: WorldState,
    final_state: WorldState,
    /** The agent's working memory as of call end (D6). */
    final_memory: z.record(z.string(), z.unknown()).default({}),
    events: z.array(TraceEvent),
  })
  .strict();
export type Trace = z.infer<typeof Trace>;

/**
 * How a metric points at the evidence behind its verdict. Every evaluator result
 * carries these so the trace inspector can highlight exactly what was used — a
 * score with no citable evidence is not reviewable.
 */
export const EvidenceRef = z
  .object({
    event_ids: z.array(z.string()),
    note: z.string().optional(),
  })
  .strict();
export type EvidenceRef = z.infer<typeof EvidenceRef>;
