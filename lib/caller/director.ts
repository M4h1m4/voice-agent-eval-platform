/**
 * Beat sequencing — the deterministic half of the hybrid caller (D3).
 *
 * Shared by every caller implementation. Scripted and LLM callers differ ONLY in how
 * they turn a beat into words; which beat fires, when, and whether a hidden fact is
 * disclosed is decided here and nowhere else.
 *
 * That split is deliberate. In 2.2 the stub agents were duplicated between two files
 * and the copies could silently drift (D17). Beat sequencing is the same kind of
 * load-bearing logic: if the scripted and LLM callers disagreed about when a correction
 * lands or whether a fact was revealed, the two would test different scenarios while
 * both looked correct.
 */
import type { CallerContext } from '../harness/types.js';
import type { Scenario } from '../types/scenario.js';

type Beat = Scenario['turn_plan'][number];

export type BeatInstruction = {
  beat: Beat;
  beat_index: number;
  /** Set when a beat is delivered in pieces; each piece is its own turn. */
  segment_index?: number;
  segment_text?: string;
  pause_ms: number;
  /**
   * Present ONLY on the turn a hidden fact is actually disclosed.
   *
   * This is the structural guard against simulator leakage: a renderer cannot volunteer
   * a fact it was never handed. Withholding the value beats instructing a model not to
   * mention it — the same reasoning as D2's caller/agent isolation.
   */
  reveals?: { fact: string; value: string };
};

/** Crude but honest: did the agent's last utterance actually ask something? */
export function agentAskedAQuestion(ctx: CallerContext): boolean {
  const lastAgent = [...ctx.heard].reverse().find((h) => h.role === 'agent');
  return !!lastAgent && lastAgent.text.includes('?');
}

export class Director {
  private beat = 0;
  private segment = 0;
  private done = false;

  constructor(private readonly scenario: Scenario) {}

  /** The next beat to voice, or null once the caller has nothing left to say. */
  next(ctx: CallerContext): BeatInstruction | null {
    if (this.done) return null;

    while (this.beat < this.scenario.turn_plan.length) {
      const beat = this.scenario.turn_plan[this.beat]!;
      const beat_index = this.beat;

      if (beat.kind === 'state_goal' && beat.segments) {
        const segment_index = this.segment;
        const segment_text = beat.segments[segment_index]!;
        const pause_ms = segment_index > 0 ? (beat.pause_ms ?? 0) : 0;
        this.segment++;
        if (this.segment >= beat.segments.length) {
          this.beat++;
          this.segment = 0;
        }
        return { beat, beat_index, segment_index, segment_text, pause_ms };
      }

      // An agent that guesses instead of asking never gets told, and so never gets
      // corrected. That silence is the trap.
      if (beat.kind === 'reveal_if_asked' && !agentAskedAQuestion(ctx)) {
        this.beat++;
        continue;
      }

      this.beat++;
      if (beat.kind === 'close') this.done = true;
      return {
        beat,
        beat_index,
        pause_ms: 0,
        ...(beat.kind === 'reveal_if_asked'
          ? { reveals: { fact: beat.fact, value: this.scenario.hidden_facts[beat.fact] ?? '' } }
          : {}),
      };
    }

    this.done = true;
    return null;
  }
}
