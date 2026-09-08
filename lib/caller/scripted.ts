/**
 * Deterministic caller: the shared Director for sequencing, templates for wording.
 *
 * Used by every test and by trace regeneration, so the suite stays free of network
 * calls and byte-reproducible. `lib/caller/llm.ts` swaps the renderer for a model and
 * changes nothing about which beats fire (D5).
 */
import type { Caller, CallerContext, CallerUtterance } from '../harness/types.js';
import type { Scenario } from '../types/scenario.js';
import { Director, type BeatInstruction } from './director.js';

export class ScriptedCaller implements Caller {
  private readonly director: Director;
  constructor(private readonly scenario: Scenario) {
    this.director = new Director(scenario);
  }

  async next(ctx: CallerContext): Promise<CallerUtterance | null> {
    const i = this.director.next(ctx);
    if (!i) return null;
    return {
      text: this.render(i),
      beat_kind: i.beat.kind,
      beat_index: i.beat_index,
      ...(i.segment_index !== undefined ? { segment_index: i.segment_index } : {}),
      pause_ms: i.pause_ms,
    };
  }

  private render(i: BeatInstruction): string {
    if (i.segment_text !== undefined) return i.segment_text;
    const b = i.beat;
    const p = this.scenario.persona_facts;
    switch (b.kind) {
      case 'state_goal':
        return b.text ?? this.scenario.caller_goal;
      case 'answer_verification':
        return `${p.name ?? 'the caller'}, date of birth ${p.dob ?? 'unknown'}.`;
      case 'choose_offer': {
        const bits: string[] = [];
        if (b.prefer.length) bits.push(`a ${b.prefer.join(' or ')} would be better`);
        if (b.reject.length) bits.push(`not ${b.reject.join(' or ')}, I work then`);
        return bits.join(', ') || 'whichever works.';
      }
      case 'reveal_if_asked':
        return i.reveals?.value || `(no hidden fact "${b.fact}")`;
      case 'red_flag':
        return b.symptom;
      case 'follow_up_request':
        return b.request;
      case 'close':
        return 'That is everything, thank you.';
    }
  }
}
