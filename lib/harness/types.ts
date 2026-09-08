/**
 * The three actor interfaces (D2). Narrow on purpose: they are what let us swap a
 * scripted caller for an LLM one, agent v1 for v2, and live for replay, without the
 * orchestrator knowing which is which.
 *
 * The isolation rule is enforced structurally rather than by convention — the Caller's
 * context type has no field that could carry a tool result. If the caller and agent
 * shared a view, the agent would silently gain telepathy: it would "know" hidden facts
 * without asking, every entity metric would read perfect, and nothing in the transcript
 * would reveal it.
 */
import type { ToolCall, ToolResult, ToolName } from '../types/tools.js';

/** One entry in the conversation. Tool activity is agent-side only. */
export type Exchange =
  | { role: 'caller'; text: string }
  | { role: 'agent'; text: string }
  | { role: 'tool_call'; name: ToolName; args: Record<string, unknown> }
  | { role: 'tool_result'; name: ToolName; result: ToolResult };

/** What the caller can see: speech only, never tools. */
export type CallerContext = {
  /** Filtered by the orchestrator — contains no tool_call or tool_result entries. */
  heard: Extract<Exchange, { role: 'caller' | 'agent' }>[];
  turn: number;
};

export type CallerUtterance = {
  text: string;
  beat_kind: string;
  beat_index: number;
  /** Set when a beat is delivered in pieces. Each piece is its own turn. */
  segment_index?: number;
  /** Simulated silence before this piece, in ms. Advances the virtual clock. */
  pause_ms?: number;
  hangup?: boolean;
};

export interface Caller {
  /** Returns the next utterance, or null when the caller has nothing left to say. */
  next(ctx: CallerContext): Promise<CallerUtterance | null>;
}

export type AgentContext = {
  history: Exchange[];
  memory: Record<string, unknown>;
  tools: readonly ToolName[];
};

export type AgentAction =
  | { kind: 'speak'; text: string }
  | { kind: 'tool'; call: ToolCall }
  | { kind: 'end' };

export interface Agent {
  readonly version: string;
  next(ctx: AgentContext): Promise<AgentAction>;
}

export type RunLimits = {
  maxTurns: number;
  maxToolCallsPerTurn: number;
  maxToolCallsTotal: number;
};

export const DEFAULT_LIMITS: RunLimits = {
  maxTurns: 20,
  /** Hitting this is recorded as an outcome, not an error — an agent thrashing on a
   *  failing tool is a real production behaviour worth catching. */
  maxToolCallsPerTurn: 8,
  maxToolCallsTotal: 40,
};
