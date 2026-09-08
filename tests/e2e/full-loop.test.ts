/**
 * The minimum functional slice, end to end, exactly as the assignment states it:
 *
 *   scenario -> agent interaction or replay -> captured trace -> automated evaluation
 *            -> inspectable result in the application
 *
 * Each test names the assignment question it answers. These are deliberately written
 * against the *product requirement*, not against the implementation — an assertion that
 * merely restates the code cannot tell us the platform does its job.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScenarios } from '../../lib/dataset/load.js';
import { runScenario } from '../../lib/harness/orchestrator.js';
import { ScriptedCaller } from '../../lib/caller/scripted.js';
import { resolveAgent } from '../../lib/agents/registry.js';
import { evaluateTrace, assertRegistryComplete } from '../../lib/eval/registry.js';
import { loadTrace, listRunIds, summarise } from '../../lib/store/traces.js';
import { Trace } from '../../lib/types/trace.js';

const { scenarios, policies } = loadScenarios();
const byId = new Map(scenarios.map((s) => [s.id, s]));

// ---------------------------------------------------------------------------
// The slice itself
// ---------------------------------------------------------------------------

test('LOOP: a scenario runs, emits a trace, and is scored — with no LLM and no key', async () => {
  const s = byId.get('rx-002-c-silentfail-only')!;
  const trace = await runScenario(s, new ScriptedCaller(s), resolveAgent('stub:naive', s.id));
  assert.ok(Trace.safeParse(trace).success, 'the trace must satisfy its schema');

  const report = await evaluateTrace(s, trace, policies);
  assert.equal(report.run_id, trace.run_id);
  assert.ok(report.metrics.length > 0, 'a run must produce metrics');
  assert.ok(['pass', 'fail'].includes(report.overall_verdict));
});

test('LOOP: every scenario is scoreable by every agent — no run falls through unevaluated', async () => {
  for (const s of scenarios) {
    for (const spec of ['stub:oracle', 'stub:naive', 'stub:panicky']) {
      const t = await runScenario(s, new ScriptedCaller(s), resolveAgent(spec, s.id));
      const r = await evaluateTrace(s, t, policies);
      assert.ok(r.metrics.length > 0, `${s.id}/${spec} produced no metrics`);
      assert.equal(r.summary.total, r.metrics.length);
    }
  }
});

// ---------------------------------------------------------------------------
// "Did it actually complete the work it claimed to complete?"
// ---------------------------------------------------------------------------

test('CLAIM vs STATE: the silent write failure is caught, and it is invisible in the transcript', async () => {
  const s = byId.get('rx-002-c-silentfail-only')!;
  const t = await runScenario(s, new ScriptedCaller(s), resolveAgent('stub:naive', s.id));

  // What the transcript says.
  const closing = t.events.filter((e) => e.type === 'agent_message').at(-1)!;
  assert.match(closing.text, /all set|moved you/i, 'the agent asserts completion');
  // What the world says.
  assert.equal(t.final_state.preferred_pharmacy['P-2044'], 'PH-110', 'the pharmacy never changed');
  // What the platform says.
  const r = await evaluateTrace(s, t, policies);
  assert.equal(r.overall_verdict, 'fail', 'a transcript-only evaluator would have passed this');
  assert.ok(r.metrics.some((m) => m.verdict === 'fail'), 'and it must name a failing metric');
});

test('CLAIM vs STATE: the same fault is survivable — the oracle reads back, retries, and passes', async () => {
  const s = byId.get('rx-002-c-silentfail-only')!;
  const r = await evaluateTrace(s, await runScenario(s, new ScriptedCaller(s), resolveAgent('stub:oracle', s.id)), policies);
  assert.equal(r.overall_verdict, 'pass', 'the scenario must be winnable, or its failures mean nothing');
});

// ---------------------------------------------------------------------------
// "Do your scenarios distinguish systems that genuinely behave differently?"
// ---------------------------------------------------------------------------

test('DISCRIMINATION: careful and careless agents are separated on every scenario', async () => {
  for (const s of scenarios) {
    const verdict = async (spec: string) =>
      (await evaluateTrace(s, await runScenario(s, new ScriptedCaller(s), resolveAgent(spec, s.id)), policies)).overall_verdict;
    assert.equal(await verdict('stub:oracle'), 'pass', `${s.id}: the oracle must pass or the scenario is unwinnable`);
    assert.equal(await verdict('stub:naive'), 'fail', `${s.id}: a careless agent must not pass`);
  }
});

test('ANTI-GAMING: escalating everything does not score well', async () => {
  // Without this, an agent could ace every safety metric by transferring every call.
  const control = byId.get('sched-reschedule-clean-001')!;
  const r = await evaluateTrace(control, await runScenario(control, new ScriptedCaller(control), resolveAgent('stub:panicky', control.id)), policies);
  assert.equal(r.overall_verdict, 'fail', 'escalating a task it should have completed must fail');
});

test('BOTH DIRECTIONS: escalation is checked for absence and for excess', async () => {
  const missing = byId.get('rx-redflag-escalation-003')!;
  const under = await evaluateTrace(missing, await runScenario(missing, new ScriptedCaller(missing), resolveAgent('stub:naive', missing.id)), policies);
  assert.ok(under.metrics.some((m) => m.verdict === 'fail'), 'failing to escalate must be caught');

  const control = byId.get('sched-reschedule-clean-001')!;
  const over = await evaluateTrace(control, await runScenario(control, new ScriptedCaller(control), resolveAgent('stub:panicky', control.id)), policies);
  assert.ok(over.metrics.some((m) => m.verdict === 'fail'), 'escalating unnecessarily must be caught');
});

// ---------------------------------------------------------------------------
// "Why did a particular metric produce its result?"
// ---------------------------------------------------------------------------

test('EXPLICABILITY: every failing metric carries a human-readable reason', async () => {
  const s = byId.get('rx-002-c-silentfail-only')!;
  const r = await evaluateTrace(s, await runScenario(s, new ScriptedCaller(s), resolveAgent('stub:naive', s.id)), policies);
  for (const m of r.metrics.filter((x) => x.verdict === 'fail')) {
    assert.ok(m.details.message && m.details.message.length > 15, `${m.metric} failed without explaining why`);
    assert.ok(m.category, `${m.metric} has no category`);
  }
});

test('HONESTY: a metric that could not be tested reports "unexercised", never "pass"', async () => {
  // memory.write is never called by the LLM agent, so memory metrics have no evidence.
  // Reporting those as passes would be the platform's own vacuous-pass failure.
  const anyUnexercised = [];
  for (const s of scenarios) {
    const r = await evaluateTrace(s, await runScenario(s, new ScriptedCaller(s), resolveAgent('stub:naive', s.id)), policies);
    anyUnexercised.push(...r.metrics.filter((m) => m.verdict === 'unexercised'));
  }
  for (const m of anyUnexercised) {
    assert.notEqual(m.verdict, 'pass');
    assert.ok(m.details.message, `unexercised metric ${m.metric} gives no reason`);
  }
});

// ---------------------------------------------------------------------------
// "What changed between two agent versions?"
// ---------------------------------------------------------------------------

test('REGRESSION: v1 passes the control scenario on every seed and v2 fails it on every seed', async () => {
  // Across 5 seeds rather than one. The single-seed version of this test was passing on
  // a sample that happened to show the effect, which is not the same as the effect
  // being reproducible.
  const s = byId.get('sched-reschedule-clean-001')!;
  const seeds = listRunIds().filter((id) => id.startsWith(`${s.id}__llm-v1__s`) && !id.includes('c-scripted'));
  assert.ok(seeds.length >= 3, 'expected several seeds recorded');
  for (const id of seeds) {
    const v1 = await evaluateTrace(s, loadTrace(id), policies);
    assert.equal(v1.overall_verdict, 'pass', `${id}: v1 should complete the control scenario`);
    const v2id = id.replace('llm-v1', 'llm-v2');
    const v2 = await evaluateTrace(s, loadTrace(v2id), policies);
    assert.equal(v2.overall_verdict, 'fail', `${v2id}: v2 regressed it — the Part 5 finding`);
  }
  const v1 = await evaluateTrace(s, loadTrace(`${s.id}__llm-v1__s0`), policies);
  const v2 = await evaluateTrace(s, loadTrace(`${s.id}__llm-v2__s0`), policies);

  const regressed = v2.metrics.filter(
    (m) => m.verdict === 'fail' && v1.metrics.find((x) => x.metric === m.metric)?.verdict === 'pass',
  );
  assert.ok(regressed.length > 0, 'the comparison must name which metrics moved backwards');
});

test('PROCESS OVER OUTCOME: the v2 write loop is caught even though it is scored on process, not state', async () => {
  // The run ends with the appointment on the wrong slot only because of where the
  // tool-call cap fell. An outcome-only evaluator would return a coin-flip verdict.
  const s = byId.get('sched-reschedule-clean-001')!;
  const candidate = listRunIds().find(
    (id) => id.startsWith(`${s.id}__llm-v2__`) &&
      loadTrace(id).events.filter((e) => e.type === 'tool_call' && e.tool === 'appointments.reschedule').length >= 4,
  );
  assert.ok(candidate, 'no recorded v2 run exhibits the write loop');
  const t = loadTrace(candidate!);

  const r = await evaluateTrace(s, t, policies);
  const proc = r.metrics.filter((m) => m.category === 'process' && m.verdict === 'fail');
  assert.ok(proc.length > 0, 'a process metric must catch the loop');
});

// ---------------------------------------------------------------------------
// Reviewability without credentials
// ---------------------------------------------------------------------------

test('NO-KEY REVIEW: every committed trace loads, validates, and scores offline', async () => {
  delete process.env.OPENAI_API_KEY;
  const ids = listRunIds();
  assert.ok(ids.length >= scenarios.length * 3, 'committed artefacts must cover the stub matrix');
  for (const id of ids) {
    const t = loadTrace(id);
    const s = byId.get(t.scenario_id);
    assert.ok(s, `${id} references an unknown scenario`);
    assert.ok(summarise(t).run_id === id);
  }
});

test('GUARD: no policy or expectation can ship without an implementing evaluator', () => {
  // The failure this prevents: a policy cited by a scenario, displayed in the UI, and
  // enforced by nothing — passing silently forever.
  assert.doesNotThrow(() => assertRegistryComplete(policies.values(), scenarios));
});
