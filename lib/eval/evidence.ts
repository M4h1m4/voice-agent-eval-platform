/**
 * Helpers for citing trace events in a verdict.
 *
 * The assignment asks "Why did a particular metric produce its result?" A message
 * answers that in prose; event ids answer it by pointing, so the inspector can
 * highlight exactly what the evaluator looked at and a reviewer can check the reasoning
 * instead of trusting it.
 *
 * Kept in one place so every evaluator cites the same way — the identifier is the
 * event's stable `id`, never `seq` (an index that shifts) or `span_id` (an internal
 * tree key the UI does not address events by).
 */
import type { Trace, TraceEvent } from '../types/trace.js';

type Ev = Trace['events'][number];

/**
 * Event ids, skipping absent entries.
 *
 * Accepts `undefined` because call sites routinely cite "the triggering turn, if there
 * was one" — pushing that narrowing onto every evaluator produced noisier code than the
 * citation itself.
 */
export const ids = (events: readonly ({ id: string } | undefined | null)[]): string[] =>
  events.filter((e): e is { id: string } => !!e).map((e) => e.id);

/** Every tool_call for the named tools, in order. */
export function toolCalls(trace: Trace, tools?: readonly string[]) {
  return trace.events.filter(
    (e): e is Extract<Ev, { type: 'tool_call' }> =>
      e.type === 'tool_call' && (!tools || tools.includes(e.tool)),
  );
}

/** The result event belonging to a tool_call, matched by span parentage. */
export function resultFor(trace: Trace, call: { span_id: string }) {
  return trace.events.find(
    (e): e is Extract<Ev, { type: 'tool_result' }> =>
      e.type === 'tool_result' && e.parent_span_id === call.span_id,
  );
}

export function callerTurns(trace: Trace) {
  return trace.events.filter(
    (e): e is Extract<Ev, { type: 'caller_turn' }> => e.type === 'caller_turn',
  );
}

export function agentMessages(trace: Trace) {
  return trace.events.filter(
    (e): e is Extract<Ev, { type: 'agent_message' }> => e.type === 'agent_message',
  );
}

export function memoryWrites(trace: Trace, key?: string) {
  return trace.events.filter(
    (e): e is Extract<Ev, { type: 'memory_write' }> =>
      e.type === 'memory_write' && (key === undefined || e.key === key),
  );
}

/** The caller turn that fired a given beat kind — where an escalation clock starts. */
export function turnForBeat(trace: Trace, kind: string) {
  return callerTurns(trace).find((e) => e.beat_kind === kind);
}

/**
 * The closing utterance. Where a completion claim lives, so it is what a
 * "claimed success the state does not support" verdict should point at.
 */
export function lastAgentMessage(trace: Trace) {
  return agentMessages(trace).at(-1);
}

export const errors = (trace: Trace) =>
  trace.events.filter((e): e is Extract<Ev, { type: 'error' }> => e.type === 'error');

export type { TraceEvent };
