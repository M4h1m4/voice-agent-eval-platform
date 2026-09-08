/**
 * End-to-end: every scenario against every stub agent, 15 runs.
 *
 * These are the tests that catch a component that works alone and misbehaves in
 * company — schema drift between producer and consumer, non-determinism leaking in,
 * a scenario the harness cannot actually drive.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScenario } from '../../lib/harness/orchestrator.js';
import { ScriptedCaller } from '../../lib/caller/scripted.js';
import { stubAgent, type StubKind } from '../../lib/agents/scripted.js';
import { loadScenarios } from '../../lib/dataset/load.js';
import { Trace } from '../../lib/types/trace.js';

const { scenarios } = loadScenarios();
const KINDS: StubKind[] = ['oracle', 'naive', 'panicky'];
const exec = (id: string, kind: StubKind, seed = 0) => {
  const s = scenarios.find((x) => x.id === id)!;
  return runScenario(s, new ScriptedCaller(s), stubAgent(id, kind), { seed });
};

const ALL = await Promise.all(
  scenarios.flatMap((s) => KINDS.map(async (k) => ({ id: s.id, kind: k, trace: await exec(s.id, k) }))),
);

test('every scenario x stub combination runs without a harness error', () => {
  // Derived, not hardcoded: adding a scenario should extend the matrix, not fail a
  // count assertion that has nothing to do with what is being tested.
  assert.equal(ALL.length, scenarios.length * KINDS.length);
  for (const { id, kind, trace } of ALL) {
    assert.notEqual(trace.termination, 'harness_error', `${id}/${kind}`);
    assert.ok(trace.events.length > 0, `${id}/${kind} produced no events`);
  }
});

test('every emitted trace validates against the Trace schema', () => {
  // The producer/consumer contract. If the orchestrator drifts from trace.ts, the app
  // and the evaluators break silently — this is what makes that impossible.
  for (const { id, kind, trace } of ALL) {
    const r = Trace.safeParse(trace);
    if (!r.success) {
      assert.fail(
        `${id}/${kind}: ` +
          r.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    }
  }
});

test('runs are byte-for-byte reproducible', async () => {
  for (const { id, kind } of ALL) {
    const a = await exec(id, kind);
    const b = await exec(id, kind);
    assert.equal(JSON.stringify(a), JSON.stringify(b), `${id}/${kind} is not deterministic`);
  }
});

test('the seed is carried into the run id, so runs never collide', async () => {
  const a = await exec('sched-reschedule-clean-001', 'oracle', 0);
  const b = await exec('sched-reschedule-clean-001', 'oracle', 1);
  assert.notEqual(a.run_id, b.run_id);
  assert.notEqual(a.trace_id, b.trace_id);
  assert.equal(a.seed, 0);
  assert.equal(b.seed, 1);
});

test('every tool_call has a matching tool_result or is an intercepted memory write', () => {
  for (const { id, kind, trace } of ALL) {
    for (const e of trace.events) {
      if (e.type !== 'tool_call') continue;
      const child = trace.events.find((x) => x.parent_span_id === e.span_id);
      assert.ok(child, `${id}/${kind}: tool_call ${e.tool} has no outcome recorded`);
      assert.equal(
        child!.type,
        e.tool === 'memory.write' ? 'memory_write' : 'tool_result',
        `${id}/${kind}: wrong outcome type for ${e.tool}`,
      );
    }
  }
});

test('every span parents to the root or to a real span in the same trace', () => {
  for (const { id, kind, trace } of ALL) {
    const spans = new Set(trace.events.map((e) => e.span_id));
    for (const e of trace.events) {
      if (e.parent_span_id === null) continue;
      assert.ok(
        e.parent_span_id === trace.events[0]!.parent_span_id || spans.has(e.parent_span_id),
        `${id}/${kind}: orphaned span on ${e.type}`,
      );
    }
  }
});

test('initial_state is the scenario seed and is never mutated by the run', () => {
  for (const { id, kind, trace } of ALL) {
    const s = scenarios.find((x) => x.id === id)!;
    assert.deepEqual(
      trace.initial_state.appointments, s.world_state.appointments,
      `${id}/${kind}: the recorded starting world drifted from the scenario`,
    );
  }
});

test('the oracle leaves every scenario in its expected final state', async () => {
  const { matchFinalState } = await import('../../lib/eval/state-match.js');
  for (const s of scenarios) {
    const t = await exec(s.id, 'oracle');
    const primary = matchFinalState(s.expected_outcome.final_state as any, t.final_state);
    const ok =
      primary.length === 0 ||
      s.acceptable_variants.some((v) => matchFinalState(v.final_state as any, t.final_state).length === 0);
    assert.ok(ok, `${s.id}: oracle did not reach the expected state — ${JSON.stringify(primary)}`);
  }
});

test('scenarios requiring escalation get one from the oracle, and none from the naive agent', async () => {
  for (const s of scenarios.filter((x) => x.expected_outcome.must_escalate)) {
    const o = await exec(s.id, 'oracle');
    assert.ok(o.final_state.escalations.length > 0, `${s.id}: oracle failed to escalate`);
    const n = await exec(s.id, 'naive');
    assert.equal(n.final_state.escalations.length, 0, `${s.id}: naive agent unexpectedly escalated`);
  }
});

test('control scenarios are not escalated by the oracle', async () => {
  for (const s of scenarios.filter((x) => x.role === 'control')) {
    const o = await exec(s.id, 'oracle');
    assert.equal(o.final_state.escalations.length, 0, `${s.id}: oracle escalated a control scenario`);
  }
});

test('the panicky agent escalates everywhere — including where it must not', async () => {
  for (const s of scenarios) {
    const t = await exec(s.id, 'panicky');
    assert.ok(t.final_state.escalations.length > 0, `${s.id}: panicky agent failed to escalate`);
  }
  const control = await exec('sched-reschedule-clean-001', 'panicky');
  assert.ok(
    control.final_state.escalations.length > 0,
    'the control scenario is what makes over-escalation detectable',
  );
});

test('caller and agent utterances interleave — neither monologues', () => {
  for (const { id, kind, trace } of ALL) {
    const speech = trace.events.filter((e) => e.type === 'caller_turn' || e.type === 'agent_message');
    assert.ok(speech.length >= 2, `${id}/${kind}: no conversation happened`);
    assert.equal(speech[0]!.type, 'caller_turn', `${id}/${kind}: the caller opens the call`);
  }
});

test('the virtual clock only moves forward', () => {
  for (const { id, kind, trace } of ALL) {
    let last = -1;
    for (const e of trace.events) {
      assert.ok(e.start_time >= last, `${id}/${kind}: time went backwards`);
      assert.ok(e.end_time >= e.start_time, `${id}/${kind}: event ends before it starts`);
      last = e.start_time;
    }
    assert.ok(trace.ended_at >= trace.started_at);
  }
});
