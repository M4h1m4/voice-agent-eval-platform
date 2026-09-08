/**
 * Assembles trace events: ids, ordering, and the causal tree.
 *
 * Two determinism choices, both so that running the same scenario twice produces a
 * byte-identical trace:
 *
 * - **Ids are derived, not random.** `trace_id` hashes the run id; span ids come from a
 *   counter. OTel-shaped hex (D9), reproducible, and diffable across runs.
 * - **The clock is virtual.** Wall-clock timestamps would make every trace differ from
 *   every other, so `start_time` advances by a fixed step per event plus any declared
 *   `pause_ms`. Durations here describe simulated conversation time, NOT real latency —
 *   this harness cannot tell you how long a real call would take.
 */
import { createHash } from 'node:crypto';
import type { TraceEvent } from '../types/trace.js';

const hex = (s: string, n: number) => createHash('sha256').update(s).digest('hex').slice(0, n);

/** Virtual clock: fixed epoch, so traces are comparable rather than timestamped. */
const EPOCH = Date.UTC(2026, 8, 8, 9, 0, 0);
const STEP_MS = 250;

export class TraceBuilder {
  readonly trace_id: string;
  readonly root_span: string;
  private seq = 0;
  private spanCounter = 0;
  private clock = EPOCH;
  private readonly events: TraceEvent[] = [];

  constructor(run_id: string) {
    this.trace_id = hex(run_id, 32);
    this.root_span = hex(`${run_id}:root`, 16);
  }

  nextSpan(): string {
    return hex(`${this.trace_id}:${this.spanCounter++}`, 16);
  }

  /** Advance simulated time, e.g. for a pause between utterance segments. */
  wait(ms: number) {
    this.clock += ms;
  }

  /**
   * Append an event. Caller supplies the type-specific fields plus `span_id` and
   * `parent_span_id`; ordering, ids, and timing are assigned here so no call site can
   * get them subtly wrong.
   */
  add<T extends TraceEvent['type']>(
    type: T,
    span_id: string,
    parent_span_id: string | null,
    fields: Omit<
      Extract<TraceEvent, { type: T }>,
      'type' | 'id' | 'seq' | 'trace_id' | 'span_id' | 'parent_span_id' | 'start_time' | 'end_time' | 'status'
    > & { status?: 'OK' | 'ERROR'; duration_ms?: number },
  ): TraceEvent {
    const { status = 'OK', duration_ms = STEP_MS, ...rest } = fields as Record<string, unknown> & {
      status?: 'OK' | 'ERROR';
      duration_ms?: number;
    };
    const start_time = this.clock;
    this.clock += duration_ms;
    const ev = {
      type,
      id: `e${String(this.seq).padStart(4, '0')}`,
      seq: this.seq++,
      trace_id: this.trace_id,
      span_id,
      parent_span_id,
      start_time,
      end_time: this.clock,
      status,
      ...rest,
    } as unknown as TraceEvent;
    this.events.push(ev);
    return ev;
  }

  all(): TraceEvent[] {
    return this.events;
  }
  get now(): number {
    return this.clock;
  }
  static get epoch(): number {
    return EPOCH;
  }
}

/**
 * Deterministic run id, so the same configuration always names one run.
 *
 * The caller marker is appended only for a non-default pairing (a scripted caller
 * against an LLM agent, or vice versa). Default pairings keep the shorter id, so
 * existing artefacts and their names stay valid.
 */
export function runId(
  scenario_id: string,
  agent_version: string,
  seed: number,
  callerMarker?: string,
): string {
  const base = `${scenario_id}__${agent_version}__s${seed}`;
  return callerMarker ? `${base}__${callerMarker}` : base;
}
