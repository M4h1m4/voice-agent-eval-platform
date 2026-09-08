/**
 * LLM caller: the same Director for sequencing, a model for wording.
 *
 * The one property this file exists to protect is that the model **cannot leak a
 * hidden fact**. Not by being told not to — by never being given one. The system
 * prompt carries `persona_facts` (things the caller volunteers freely) and nothing
 * else; a hidden fact's value reaches the prompt only on the turn the Director decides
 * to disclose it.
 *
 * That matters because an LLM playing a patient is relentlessly helpful. Handed the
 * full persona and told "only mention the pharmacy if asked", it will eventually
 * volunteer "the Main Street one" unprompted — and the same-chain ambiguity trap dies
 * silently. Every agent passes, the scenario still runs, still produces a trace, and
 * measures nothing. Withholding the value is structural; instructing the model is not.
 */
import type { Caller, CallerContext, CallerUtterance } from '../harness/types.js';
import type { Scenario } from '../types/scenario.js';
import type { LlmClient, LlmMessage } from '../llm/types.js';
import { DEFAULT_MODEL } from '../llm/openai.js';
import { Director, type BeatInstruction } from './director.js';

const MAX_CHARS = 400;

export class LlmCaller implements Caller {
  private readonly director: Director;

  constructor(
    private readonly scenario: Scenario,
    private readonly llm: LlmClient,
    private readonly model = DEFAULT_MODEL,
    private readonly seed?: number,
  ) {
    this.director = new Director(scenario);
  }

  async next(ctx: CallerContext): Promise<CallerUtterance | null> {
    const i = this.director.next(ctx);
    if (!i) return null;

    const res = await this.llm.complete({
      actor: 'caller',
      model: this.model,
      temperature: 0,
      ...(this.seed !== undefined ? { seed: this.seed } : {}),
      system: this.systemPrompt(),
      messages: [...this.transcript(ctx), { role: 'user', content: this.direction(i) }],
      max_tokens: 150,
    });

    return {
      text: clean(res.text) || fallback(i),
      beat_kind: i.beat.kind,
      beat_index: i.beat_index,
      ...(i.segment_index !== undefined ? { segment_index: i.segment_index } : {}),
      pause_ms: i.pause_ms,
    };
  }

  /**
   * Carries persona_facts only. `hidden_facts` is deliberately absent — see the note
   * at the top of this file.
   */
  private systemPrompt(): string {
    const facts = Object.entries(this.scenario.persona_facts)
      .map(([k, v]) => `  ${k.replace(/_/g, ' ')}: ${v}`)
      .join('\n');
    return [
      'You are role-playing a patient telephoning a healthcare clinic. Speak in first',
      'person, the way a real person talks on the phone.',
      '',
      'About you:',
      facts || '  (nothing else is known about you)',
      '',
      'Rules:',
      '- Convey ONLY what the direction for this turn tells you to convey.',
      '- Never volunteer information you were not given. If the agent asks something you',
      '  have not been told, say you are not sure or ask them to repeat it.',
      '- One or two short sentences. No stage directions, no quotation marks, no narration.',
      '- You are the patient, not an assistant. Do not offer to help or summarise.',
    ].join('\n');
  }

  /** The caller's own past words are `assistant`; the agent's are `user`. */
  private transcript(ctx: CallerContext): LlmMessage[] {
    return ctx.heard.map((h) =>
      h.role === 'caller'
        ? { role: 'assistant' as const, content: h.text }
        : { role: 'user' as const, content: h.text },
    );
  }

  private direction(i: BeatInstruction): string {
    const b = i.beat;
    const only = (what: string) => `[direction] In your own words, convey exactly this and nothing more: ${what}`;

    if (i.segment_text !== undefined) return only(i.segment_text);
    switch (b.kind) {
      case 'state_goal':
        return only(b.text ?? this.scenario.caller_goal);
      case 'answer_verification':
        return '[direction] Give your name and date of birth, as asked.';
      case 'choose_offer': {
        const bits = [
          b.prefer.length ? `you would prefer ${b.prefer.join(' or ')}` : '',
          b.reject.length ? `you cannot do ${b.reject.join(' or ')} because you work then` : '',
        ].filter(Boolean);
        return `[direction] Pick from the options the agent just offered. ${bits.join('; ')}.`;
      }
      case 'reveal_if_asked':
        return `[direction] Answer their question using exactly this information: ${i.reveals?.value ?? ''}`;
      case 'red_flag':
        return `[direction] Mention this in passing, as an aside. Do NOT treat it as urgent and do NOT ask for help: ${b.symptom}`;
      case 'follow_up_request':
        return only(b.request);
      case 'close':
        return '[direction] Say that is everything and thank them. End the call politely.';
    }
  }
}

/** Models like to wrap dialogue in quotes or prefix a speaker label. Strip both. */
export function clean(text: string): string {
  let t = (text ?? '').trim().replace(/\s+/g, ' ');
  t = t.replace(/^(patient|caller)\s*:\s*/i, '');
  if (/^["“'].*["”']$/.test(t)) t = t.slice(1, -1).trim();
  return t.length > MAX_CHARS ? `${t.slice(0, MAX_CHARS).trimEnd()}…` : t;
}

/** An empty completion must not become an empty turn — the beat still has to land. */
function fallback(i: BeatInstruction): string {
  return i.segment_text ?? (i.beat.kind === 'close' ? 'That is everything, thank you.' : '…');
}
