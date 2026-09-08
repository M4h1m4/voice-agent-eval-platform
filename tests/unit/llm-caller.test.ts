import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LlmCaller, clean } from '../../lib/caller/llm.js';
import { ScriptedCaller } from '../../lib/caller/scripted.js';
import { Director } from '../../lib/caller/director.js';
import { FakeClient } from '../../lib/llm/fake.js';
import { loadScenarios } from '../../lib/dataset/load.js';
import type { CallerContext, CallerUtterance, Caller } from '../../lib/harness/types.js';
import type { LlmRequest } from '../../lib/llm/types.js';

const { scenarios } = loadScenarios();
const byId = new Map(scenarios.map((s) => [s.id, s]));
const HEADLINE = 'rx-pharmacy-correction-silentfail-002';

/** Drives a caller to exhaustion, feeding back a fixed agent reply each turn. */
async function drain(caller: Caller, agentReply: string): Promise<CallerUtterance[]> {
  const heard: CallerContext['heard'] = [];
  const out: CallerUtterance[] = [];
  for (let i = 0; i < 25; i++) {
    const u = await caller.next({ heard, turn: i });
    if (!u) break;
    out.push(u);
    heard.push({ role: 'caller', text: u.text });
    heard.push({ role: 'agent', text: agentReply });
  }
  return out;
}

/** Records every prompt the caller sends, so we can inspect what it was told. */
function spyClient(reply = (n: number) => `utterance ${n}`) {
  const prompts: LlmRequest[] = [];
  let n = 0;
  const client = {
    async complete(req: LlmRequest) {
      prompts.push(req);
      return {
        text: reply(++n), tool_calls: [], model: req.model,
        usage: { input_tokens: 1, output_tokens: 1 }, prompt_hash: 'h', cache_hit: false,
      };
    },
  };
  return { client, prompts };
}

// --- the property that matters ---------------------------------------------

test('hidden facts NEVER appear in the prompt until the Director discloses them', async () => {
  // Not "we told the model not to mention it" — the value is not in the prompt at all.
  // An LLM patient handed the full persona will eventually volunteer it, and the
  // ambiguity trap would die silently while every scenario still ran and reported.
  const { client, prompts } = spyClient();
  const s = byId.get(HEADLINE)!;
  await drain(new LlmCaller(s, client), 'Okay, one moment.');   // agent never asks

  const secret = s.hidden_facts['which_walgreens']!;
  for (const p of prompts) {
    const whole = p.system + JSON.stringify(p.messages);
    assert.ok(!whole.includes(secret), 'hidden fact leaked into a prompt');
    assert.ok(!/Main St/i.test(p.system), 'hidden fact leaked into the system prompt');
  }
});

test('the fact reaches the prompt only on the turn it is disclosed', async () => {
  const { client, prompts } = spyClient();
  const s = byId.get(HEADLINE)!;
  await drain(new LlmCaller(s, client), 'Which pharmacy would you like?');  // agent asks

  const secret = s.hidden_facts['which_walgreens']!;
  const carrying = prompts.filter((p) => p.messages.some((m) => 'content' in m && m.content.includes(secret)));
  assert.equal(carrying.length, 1, 'exactly one turn may carry it');
  assert.match(String((carrying[0]!.messages.at(-1) as any).content), /^\[direction\] Answer their question/);
});

test('the system prompt carries persona facts and no hidden ones', () => {
  const { client, prompts } = spyClient();
  const s = byId.get(HEADLINE)!;
  return new LlmCaller(s, client).next({ heard: [], turn: 0 }).then(() => {
    const sys = prompts[0]!.system;
    assert.match(sys, /Marcus Oyelaran/);
    assert.match(sys, /1965-11-02/);
    for (const v of Object.values(s.hidden_facts)) assert.ok(!sys.includes(v));
  });
});

// --- the Director is shared, so the two callers cannot drift ----------------

test('scripted and LLM callers fire the identical beat sequence', async () => {
  for (const s of scenarios) {
    for (const reply of ['Okay.', 'Which one would you like?']) {
      const a = await drain(new ScriptedCaller(s), reply);
      const b = await drain(new LlmCaller(s, spyClient().client), reply);
      assert.deepEqual(
        a.map((u) => [u.beat_kind, u.beat_index, u.segment_index, u.pause_ms]),
        b.map((u) => [u.beat_kind, u.beat_index, u.segment_index, u.pause_ms]),
        `${s.id} diverged with agent reply "${reply}"`,
      );
    }
  }
});

test('reveal gating behaves the same in both callers', async () => {
  const s = byId.get(HEADLINE)!;
  for (const [reply, expected] of [['Okay.', false], ['Which one?', true]] as const) {
    const a = await drain(new ScriptedCaller(s), reply);
    const b = await drain(new LlmCaller(s, spyClient().client), reply);
    assert.equal(a.some((u) => u.beat_kind === 'reveal_if_asked'), expected);
    assert.equal(b.some((u) => u.beat_kind === 'reveal_if_asked'), expected);
  }
});

// --- conversation shaping ---------------------------------------------------

test('the caller is the assistant in its own transcript, the agent is the user', async () => {
  const { client, prompts } = spyClient();
  const s = byId.get('sched-reschedule-clean-001')!;
  await drain(new LlmCaller(s, client), 'Can I take your name?');
  const later = prompts.at(-1)!;
  assert.equal(later.messages[0]!.role, 'assistant', 'the caller spoke first');
  assert.equal(later.messages[1]!.role, 'user', 'the agent replied');
  assert.equal(later.actor, 'caller', 'and it is cached as the caller');
});

test('each turn ends with exactly one direction', async () => {
  const { client, prompts } = spyClient();
  await drain(new LlmCaller(byId.get(HEADLINE)!, client), 'Which one?');
  for (const p of prompts) {
    const directions = p.messages.filter((m) => 'content' in m && m.content.startsWith('[direction]'));
    assert.equal(directions.length, 1);
    assert.equal(p.messages.at(-1), directions[0], 'the direction is the final message');
  }
});

test('the red-flag direction forbids signalling urgency', async () => {
  const { client, prompts } = spyClient();
  await drain(new LlmCaller(byId.get('rx-redflag-escalation-003')!, client), 'Okay.');
  const rf = prompts.find((p) => String((p.messages.at(-1) as any).content).includes('as an aside'))!;
  assert.ok(rf, 'the red flag has its own direction');
  assert.match(String((rf.messages.at(-1) as any).content), /do NOT treat it as urgent/i);
});

test('the caller is pinned to temperature 0', async () => {
  const { client, prompts } = spyClient();
  await drain(new LlmCaller(byId.get(HEADLINE)!, client), 'Okay.');
  for (const p of prompts) assert.equal(p.temperature, 0);
});

// --- output hygiene ---------------------------------------------------------

test('quotes, speaker labels and runaway length are stripped', () => {
  assert.equal(clean('  "I need a refill."  '), 'I need a refill.');
  assert.equal(clean('Patient: hello there'), 'hello there');
  assert.equal(clean('a\n\n  b'), 'a b');
  assert.ok(clean('x'.repeat(900)).length <= 401);
});

test('an empty completion still lands the beat rather than producing a silent turn', async () => {
  const empty = { async complete(req: LlmRequest) {
    return { text: '   ', tool_calls: [], model: req.model, usage: { input_tokens: 0, output_tokens: 0 }, prompt_hash: 'h', cache_hit: false };
  } };
  const turns = await drain(new LlmCaller(byId.get(HEADLINE)!, empty), 'Okay.');
  assert.ok(turns.length > 0);
  for (const t of turns) assert.ok(t.text.trim().length > 0, 'no empty utterances');
});

test('the LLM cannot change the beat sequence, only the words', async () => {
  // A caller that rambles, refuses, or answers something else still advances exactly
  // one beat: sequencing is the Director's, wording is the model's.
  const chaotic = { async complete(req: LlmRequest) {
    return { text: 'Actually never mind, goodbye, I have to go now.', tool_calls: [], model: req.model,
             usage: { input_tokens: 1, output_tokens: 1 }, prompt_hash: 'h', cache_hit: false };
  } };
  const s = byId.get(HEADLINE)!;
  const turns = await drain(new LlmCaller(s, chaotic), 'Which one?');
  const expected = await drain(new ScriptedCaller(s), 'Which one?');
  assert.deepEqual(turns.map((t) => t.beat_kind), expected.map((t) => t.beat_kind));
});

// --- Director in isolation --------------------------------------------------

test('the Director hands over a hidden fact only alongside a reveal beat', () => {
  const s = byId.get(HEADLINE)!;
  const d = new Director(s);
  const heard: CallerContext['heard'] = [];
  const withReveals: string[] = [];
  for (let i = 0; i < 12; i++) {
    const step = d.next({ heard, turn: i });
    if (!step) break;
    if (step.reveals) withReveals.push(step.beat.kind);
    heard.push({ role: 'caller', text: 'x' }, { role: 'agent', text: 'Which one?' });
  }
  assert.deepEqual(withReveals, ['reveal_if_asked']);
});
