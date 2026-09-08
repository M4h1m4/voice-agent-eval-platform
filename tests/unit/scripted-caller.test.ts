import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScriptedCaller } from '../../lib/caller/scripted.js';
import { loadScenarios } from '../../lib/dataset/load.js';
import type { CallerContext, CallerUtterance } from '../../lib/harness/types.js';

const { scenarios } = loadScenarios();
const byId = new Map(scenarios.map((s) => [s.id, s]));

/** Drives a caller to exhaustion, feeding back whatever the agent "said". */
async function drain(
  scenarioId: string,
  agentReplies: (n: number) => string,
): Promise<CallerUtterance[]> {
  const caller = new ScriptedCaller(byId.get(scenarioId)!);
  const heard: CallerContext['heard'] = [];
  const out: CallerUtterance[] = [];
  for (let i = 0; i < 25; i++) {
    const u = await caller.next({ heard, turn: i });
    if (!u) break;
    out.push(u);
    heard.push({ role: 'caller', text: u.text });
    heard.push({ role: 'agent', text: agentReplies(i) });
  }
  return out;
}

const SILENT = () => 'Okay.';
const ASKS = () => 'Which one would you like?';

test('a segmented utterance becomes separate turns, so the agent gets the floor between them', async () => {
  const turns = await drain('rx-pharmacy-correction-silentfail-002', SILENT);
  const segs = turns.filter((t) => t.segment_index !== undefined);
  assert.equal(segs.length, 2, 'both segments delivered');
  assert.equal(segs[0]!.segment_index, 0);
  assert.equal(segs[1]!.segment_index, 1);
  assert.equal(segs[0]!.beat_index, segs[1]!.beat_index, 'same beat');
  assert.match(segs[0]!.text, /blood pressure/);
  assert.match(segs[1]!.text, /thyroid|levothyroxine/);
});

test('the pause is attached to the later segment, not the first', async () => {
  const turns = await drain('rx-pharmacy-correction-silentfail-002', SILENT);
  const segs = turns.filter((t) => t.segment_index !== undefined);
  assert.equal(segs[0]!.pause_ms, 0);
  assert.equal(segs[1]!.pause_ms, 900);
});

test('reveal_if_asked stays hidden when the agent never asks', async () => {
  const turns = await drain('rx-pharmacy-correction-silentfail-002', SILENT);
  assert.ok(!turns.some((t) => t.beat_kind === 'reveal_if_asked'), 'beat must not fire');
  assert.ok(!turns.some((t) => /Main St/i.test(t.text)), 'hidden fact must never be spoken');
});

test('reveal_if_asked fires when the agent does ask', async () => {
  const turns = await drain('rx-pharmacy-correction-silentfail-002', ASKS);
  const reveal = turns.find((t) => t.beat_kind === 'reveal_if_asked');
  assert.ok(reveal, 'beat should fire');
  assert.match(reveal!.text, /Main Street/i);
});

test('beats fire in declaration order and the caller then goes quiet', async () => {
  const turns = await drain('sched-reschedule-clean-001', SILENT);
  assert.deepEqual(
    turns.map((t) => t.beat_kind),
    ['state_goal', 'answer_verification', 'choose_offer', 'close'],
  );
  const caller = new ScriptedCaller(byId.get('sched-reschedule-clean-001')!);
  for (let i = 0; i < 4; i++) await caller.next({ heard: [], turn: i });
  assert.equal(await caller.next({ heard: [], turn: 4 }), null, 'exhausted caller returns null');
});

test('choose_offer voices the constraint that lives in hidden_facts', async () => {
  const turns = await drain('sched-reschedule-clean-001', SILENT);
  const choose = turns.find((t) => t.beat_kind === 'choose_offer')!;
  assert.match(choose.text, /morning/i);
  assert.match(choose.text, /monday/i);
});

test('the red flag is delivered as an aside, not as a request for help', async () => {
  const turns = await drain('rx-redflag-escalation-003', SILENT);
  const rf = turns.find((t) => t.beat_kind === 'red_flag')!;
  assert.match(rf.text, /chest/i);
  assert.ok(!/help|emergency|urgent/i.test(rf.text), 'caller must not signal urgency itself');
});

test('the caller is deterministic — same inputs, same utterances', async () => {
  const a = await drain('rx-pharmacy-correction-silentfail-002', ASKS);
  const b = await drain('rx-pharmacy-correction-silentfail-002', ASKS);
  assert.deepEqual(a, b);
});
