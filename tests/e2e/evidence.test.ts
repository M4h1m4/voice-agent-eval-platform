/**
 * "Why did a particular metric produce its result?"
 *
 * A verdict must point at the trace events it rests on, not merely describe them. This
 * suite enforces that across every scenario and every agent — an evaluator that cannot
 * name the events it looked at may not have looked at any.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScenarios } from '../../lib/dataset/load.js';
import { runScenario } from '../../lib/harness/orchestrator.js';
import { ScriptedCaller } from '../../lib/caller/scripted.js';
import { resolveAgent } from '../../lib/agents/registry.js';
import { evaluateTrace } from '../../lib/eval/registry.js';
import { evaluatorContext } from '../../lib/eval/context.js';

// Judged metrics need a judge. Without one they correctly report "unexercised", which
// would make the universally-unexercised guard below fire on a metric that works.
const CTX = evaluatorContext();
import { loadTrace, listRunIds } from '../../lib/store/traces.js';

const { scenarios, policies } = loadScenarios();
const byId = new Map(scenarios.map((s) => [s.id, s]));

/** Metrics whose verdict rests on the world's end state rather than on any event. */
const STATE_BASED = new Set(['final_state', 'critical_entities']);

test('every failing metric cites the trace events it rests on', async () => {
  const uncited: string[] = [];
  for (const s of scenarios) {
    for (const spec of ['stub:oracle', 'stub:naive', 'stub:panicky']) {
      const t = await runScenario(s, new ScriptedCaller(s), resolveAgent(spec, s.id));
      const r = await evaluateTrace(s, t, policies, CTX);
      for (const m of r.metrics) {
        if (m.verdict !== 'fail' || STATE_BASED.has(m.metric)) continue;
        const ids = m.details.evidence_events;
        if (!ids || ids.length === 0) uncited.push(`${s.id}/${spec}: ${m.metric}`);
      }
    }
  }
  assert.deepEqual([...new Set(uncited.map((x) => x.split(': ')[1]))], [], `metrics failing without evidence:\n  ${uncited.join('\n  ')}`);
});

test('every failing metric on a COMMITTED trace also cites its events', async () => {
  // The stub matrix above misses metrics that only fire on real runs — tool budget
  // exhaustion and caller abandonment appear on the v2 traces and nowhere else.
  const uncited: string[] = [];
  for (const id of listRunIds()) {
    const t = loadTrace(id);
    const s = byId.get(t.scenario_id);
    if (!s) continue;
    const r = await evaluateTrace(s, t, policies, CTX);
    for (const m of r.metrics) {
      if (m.verdict !== 'fail' || STATE_BASED.has(m.metric)) continue;
      if (!m.details.evidence_events?.length) uncited.push(`${id}: ${m.metric}`);
    }
  }
  assert.deepEqual([...new Set(uncited.map((x) => x.split(': ')[1]))], [], uncited.join('\n  '));
});

test('cited event ids exist in the trace they came from', async () => {
  for (const id of listRunIds()) {
    const t = loadTrace(id);
    const s = byId.get(t.scenario_id);
    if (!s) continue;
    const known = new Set(t.events.map((e) => e.id));
    const r = await evaluateTrace(s, t, policies, CTX);
    for (const m of r.metrics) {
      for (const ev of m.details.evidence_events ?? []) {
        assert.ok(known.has(ev), `${id}/${m.metric} cites "${ev}", which is not in the trace`);
      }
    }
  }
});

test('the citation points at the events a reader would want — the redundant writes themselves', async () => {
  // Found by search, not pinned to a seed. The v2 write loop reproduces on 4 of 5 seeds
  // but not all of them, and hardcoding one made this test depend on which sample the
  // cache happened to hold.
  const s = byId.get('sched-reschedule-clean-001')!;
  const candidate = listRunIds().find(
    (id) => id.startsWith(`${s.id}__llm-v2__`) &&
      loadTrace(id).events.filter((e) => e.type === 'tool_call' && e.tool === 'appointments.reschedule').length >= 4,
  );
  assert.ok(candidate, 'no recorded v2 run exhibits the write loop');
  const t = loadTrace(candidate!);
  const r = await evaluateTrace(s, t, policies, CTX);
  const m = r.metrics.find((x) => x.metric === 'redundant_writes' && x.verdict === 'fail');
  assert.ok(m, 'the write loop must be caught');

  const cited = new Set(m!.details.evidence_events ?? []);
  assert.ok(cited.size >= 2, 'a loop is not evidenced by a single call');
  for (const ev of cited) {
    const e = t.events.find((x) => x.id === ev)!;
    assert.equal(e.type, 'tool_call', 'the evidence should be the offending calls');
    assert.equal(e.tool, 'appointments.reschedule');
  }
});

test('a passing metric need not cite events, but must never cite a nonexistent one', async () => {
  const s = byId.get('rx-002-c-silentfail-only')!;
  const t = await runScenario(s, new ScriptedCaller(s), resolveAgent('stub:oracle', s.id));
  const known = new Set(t.events.map((e) => e.id));
  const r = await evaluateTrace(s, t, policies, CTX);
  for (const m of r.metrics) {
    for (const ev of m.details.evidence_events ?? []) assert.ok(known.has(ev), `${m.metric} cites a phantom event`);
  }
});

test('no policy is universally unexercised — a check that never fires is not a check', async () => {
  // policy:confirm_pharmacy_when_chain_ambiguous reported "unexercised" on every run
  // for the life of the project. Not agent behaviour: the evaluator asked
  // `Array.isArray(result.data)`, and every tool in this World wraps its rows in an
  // object. It could not have fired on any trace, ever, and nothing noticed.
  const verdicts = new Map<string, Set<string>>();
  for (const id of listRunIds()) {
    const t = loadTrace(id);
    const s = byId.get(t.scenario_id);
    if (!s) continue;
    for (const m of (await evaluateTrace(s, t, policies, CTX)).metrics) {
      if (!m.metric.startsWith('policy:')) continue;
      (verdicts.get(m.metric) ?? verdicts.set(m.metric, new Set()).get(m.metric)!).add(m.verdict);
    }
  }
  for (const [metric, seen] of verdicts) {
    assert.ok(
      seen.has('pass') || seen.has('fail'),
      `${metric} is "unexercised" on every committed trace — it may be structurally unable to fire`,
    );
  }
});

test('no metric is universally passing on runs designed to fail', async () => {
  // The guard that would have caught the hallucinated-completion bug. A metric that
  // never fails across a corpus containing deliberately bad agents is a metric that may
  // be structurally unable to fail — the same shape as the disambiguation policy (D27)
  // and the completion check (D29), both of which reported confident numbers for the
  // life of the project while verifying nothing.
  //
  // Exemptions are listed individually, with a reason, so adding one is a decision
  // rather than an accident.
  const NEVER_FAILS_LEGITIMATELY = new Set([
    // Only the stub agents call memory.write; the LLM agent never does, so there is no
    // corpus in which this can currently fail. Recorded as unexercised, not passed.
    'expected_memory_writes',
    // Every agent verifies identity before disclosing. Never violated in this corpus.
    'policy:verify_identity_before_disclosure',
    // Only emitted when an escalation happened, and every escalation in the corpus
    // carries the right urgency and arrives in time.
    'escalation_urgency',
    'escalation_latency',
  ]);

  const seen = new Map<string, Set<string>>();
  for (const id of listRunIds()) {
    const t = loadTrace(id);
    const s = byId.get(t.scenario_id);
    if (!s) continue;
    for (const m of (await evaluateTrace(s, t, policies, CTX)).metrics) {
      (seen.get(m.metric) ?? seen.set(m.metric, new Set()).get(m.metric)!).add(m.verdict);
    }
  }

  const suspicious = [...seen]
    .filter(([metric, verdicts]) => !verdicts.has('fail') && !NEVER_FAILS_LEGITIMATELY.has(metric))
    .map(([m]) => m);

  assert.deepEqual(
    suspicious,
    [],
    `never observed failing across ${listRunIds().length} runs — verify each can fail at all:\n  ${suspicious.join('\n  ')}`,
  );
});
