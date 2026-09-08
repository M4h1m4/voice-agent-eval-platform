/**
 * The turn loop. Drives a Caller and an Agent against a World and assembles a Trace.
 *
 * It knows nothing about LLMs, prompts, or scoring. Swapping a scripted caller for an
 * LLM one, or agent v1 for v2, changes nothing here — which is the point of the narrow
 * interfaces in `types.ts`.
 */
import { World } from '../world/clinic.js';
import { TraceBuilder, runId } from './trace-builder.js';
import { DEFAULT_LIMITS, type Agent, type Caller, type Exchange, type RunLimits } from './types.js';
import type { Scenario } from '../types/scenario.js';
import type { Trace, Termination } from '../types/trace.js';
import type { ToolName, ToolResult } from '../types/tools.js';
import type { LlmRecorder } from '../llm/client.js';
import { perturb, faultForBeat } from '../caller/asr.js';

export type RunOptions = {
  seed?: number;
  limits?: Partial<RunLimits>;
  mode?: 'live' | 'replay';
  /** Which caller implementation is driving. Recorded, and marks non-default pairings. */
  caller?: 'scripted' | 'llm';
  /**
   * Wire the same recorder that was handed to the caller's and agent's LLM client, and
   * every model call lands in the trace. Omit it for runs with no LLM.
   */
  llm?: LlmRecorder;
};

/** Tools offered to the agent. `memory.write` is included but never reaches the World. */
const ALL_TOOLS: readonly ToolName[] = [
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
];

export async function runScenario(
  scenario: Scenario,
  caller: Caller,
  agent: Agent,
  opts: RunOptions = {},
): Promise<Trace> {
  const seed = opts.seed ?? 0;
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const callerKind = opts.caller ?? (agent.version.startsWith('llm-') ? 'llm' : 'scripted');
  // Default pairing: llm agent + llm caller, stub agent + scripted caller. Anything
  // else is a deliberate variation and gets its own id so it cannot overwrite the run
  // it is meant to be compared against.
  const isDefaultPairing = callerKind === (agent.version.startsWith('llm-') ? 'llm' : 'scripted');
  const run_id = runId(scenario.id, agent.version, seed, isDefaultPairing ? undefined : `c-${callerKind}`);

  const world = new World(scenario.world_state, scenario.tool_faults);
  const tb = new TraceBuilder(run_id);
  const initial_state = world.snapshot();

  const history: Exchange[] = [];
  const memory: Record<string, unknown> = {};

  /** Emit one llm_call event per model interaction, in the order they happened. */
  const drainLlm = () => {
    for (const { req, res } of opts.llm?.drain() ?? []) {
      tb.add('llm_call', tb.nextSpan(), tb.root_span, {
        actor: req.actor,
        'gen_ai.system': res.provider,
        'gen_ai.request.model': res.model,
        'gen_ai.request.temperature': req.temperature,
        'gen_ai.usage.input_tokens': res.usage.input_tokens,
        'gen_ai.usage.output_tokens': res.usage.output_tokens,
        prompt_hash: res.prompt_hash,
        cache_hit: res.cache_hit,
        duration_ms: 0,
      });
    }
  };

  let termination: Termination = 'max_turns';
  let escalated = false;
  let turns = 0;
  let toolCallsTotal = 0;

  outer: while (true) {
    if (turns >= limits.maxTurns) {
      termination = 'max_turns';
      break;
    }

    // ---- caller's turn -------------------------------------------------
    // The caller sees speech only. Filtering here rather than trusting the caller
    // implementation is what makes D2's isolation structural instead of a convention.
    const heard = history.filter(
      (h): h is Extract<Exchange, { role: 'caller' | 'agent' }> =>
        h.role === 'caller' || h.role === 'agent',
    );
    const utterance = await caller.next({ heard, turn: turns });
    drainLlm();

    if (!utterance) {
      termination = escalated ? 'escalated' : 'caller_hangup';
      break;
    }
    if (utterance.pause_ms) tb.wait(utterance.pause_ms);

    // A transcription fault sits between the caller's mouth and the agent's ears. The
    // caller is unaware of it — it never sees its own corrupted words — so the fault is
    // applied here rather than inside the caller (D2's isolation, applied to noise).
    const fault = faultForBeat(scenario.caller_faults, utterance.beat_index);
    const heardText = fault ? perturb(utterance.text, fault.mode, fault.detail) : null;
    const delivered = heardText ?? utterance.text;

    tb.add('caller_turn', tb.nextSpan(), tb.root_span, {
      text: delivered,
      beat_kind: utterance.beat_kind,
      beat_index: utterance.beat_index,
      ...(utterance.segment_index !== undefined
        ? { segment_index: utterance.segment_index }
        : {}),
      // Recorded only when the words actually changed, so a reader can tell a corrupted
      // turn from an ordinary one at a glance.
      ...(heardText !== null
        ? { text_intended: utterance.text, asr_fault: fault!.mode }
        : {}),
    });
    history.push({ role: 'caller', text: delivered });
    turns++;

    if (utterance.hangup) {
      termination = 'caller_hangup';
      break;
    }

    // ---- agent's turn: tools until it speaks or ends --------------------
    let toolCallsThisTurn = 0;
    while (true) {
      const action = await agent.next({ history: [...history], memory: { ...memory }, tools: ALL_TOOLS });
      drainLlm();

      if (action.kind === 'end') {
        termination = escalated ? 'escalated' : 'agent_ended';
        break outer;
      }

      if (action.kind === 'speak') {
        tb.add('agent_message', tb.nextSpan(), tb.root_span, { text: action.text });
        history.push({ role: 'agent', text: action.text });
        break; // floor returns to the caller
      }

      // --- tool call ---
      if (toolCallsThisTurn >= limits.maxToolCallsPerTurn || toolCallsTotal >= limits.maxToolCallsTotal) {
        tb.add('error', tb.nextSpan(), tb.root_span, {
          message: `tool call limit reached (turn ${toolCallsThisTurn}/${limits.maxToolCallsPerTurn}, total ${toolCallsTotal}/${limits.maxToolCallsTotal})`,
          where: 'orchestrator',
          status: 'ERROR',
        });
        termination = 'max_tool_calls';
        break outer;
      }
      toolCallsThisTurn++;
      toolCallsTotal++;

      const callSpan = tb.nextSpan();
      const { name, args } = action.call;
      tb.add('tool_call', callSpan, tb.root_span, { tool: name, args });
      history.push({ role: 'tool_call', name, args });

      let result: ToolResult;

      if (name === 'memory.write') {
        // Agent state, not clinic state (D6). Recorded as its own event with
        // before/after so "did it overwrite or keep the stale value" is a
        // deterministic check. No tool_result is emitted: one would have to carry an
        // unchanged WorldState pair, which reads as evidence and is noise.
        const key = String((args as Record<string, unknown>).key ?? '');
        const before = key in memory ? memory[key] : null;
        const after = (args as Record<string, unknown>).value;
        memory[key] = after;
        tb.add('memory_write', tb.nextSpan(), callSpan, {
          key,
          before: before ?? null,
          after,
          reason: String((args as Record<string, unknown>).reason ?? ''),
        });
        result = { ok: true, data: { key, value: after } };
      } else {
        const outcome = await world.invoke(action.call);
        result = outcome.result;
        tb.add('tool_result', tb.nextSpan(), callSpan, {
          tool: name,
          ok: result.ok,
          ...(result.data !== undefined ? { data: result.data } : {}),
          ...(result.error !== undefined ? { error: result.error } : {}),
          fault_applied: outcome.fault_applied,
          state_before: outcome.state_before,
          state_after: outcome.state_after,
          status: result.ok ? 'OK' : 'ERROR',
        });
        if (name === 'escalate' && result.ok) escalated = true;
      }

      history.push({ role: 'tool_result', name, result });
    }
  }

  return {
    run_id,
    trace_id: tb.trace_id,
    scenario_id: scenario.id,
    agent_version: agent.version,
    seed,
    caller: callerKind,
    limits,
    mode: opts.mode ?? 'replay',
    started_at: TraceBuilder.epoch,
    ended_at: tb.now,
    termination,
    initial_state,
    final_state: world.snapshot(),
    final_memory: memory,
    events: tb.all(),
  };
}
