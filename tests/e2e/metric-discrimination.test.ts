/**
 * Per-metric discrimination.
 *
 * `dataset-discrimination.ts` proves every SCENARIO separates a careful agent from a
 * careless one. Nothing proved the same of the METRICS, and three of them turned out to
 * be broken — a policy that could never fire (D27), outcome metrics blind to a spurious
 * record (D28), and the headline completion check asking the wrong question (D29). All
 * three produced confident, well-formed, well-explained verdicts. All three were found
 * by reading output, none by a test.
 *
 * This is the same contract, one level down: for every metric, a run it must fail and a
 * run it must pass.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadScenarios } from '../../lib/dataset/load.js';
import { loadTrace } from '../../lib/store/traces.js';
import { evaluateTrace } from '../../lib/eval/registry.js';
import { evaluatorContext } from '../../lib/eval/context.js';

const { scenarios, policies } = loadScenarios();
const byId = new Map(scenarios.map((s) => [s.id, s]));
const CTX = evaluatorContext();

const fixtures = JSON.parse(readFileSync('tests/fixtures/metric-verdicts.json', 'utf8')) as {
  provable: Record<string, { fail: string; pass: string }>;
  unprovable: Record<string, string[]>;
};

async function verdictOf(metric: string, runId: string) {
  const t = loadTrace(runId);
  const s = byId.get(t.scenario_id)!;
  return (await evaluateTrace(s, t, policies, CTX)).metrics.find((m) => m.metric === metric)?.verdict;
}

test('every provable metric still fails the run it is pinned to fail', async () => {
  for (const [metric, { fail }] of Object.entries(fixtures.provable)) {
    assert.equal(await verdictOf(metric, fail), 'fail', `${metric} stopped failing ${fail}`);
  }
});

test('every provable metric still passes the run it is pinned to pass', async () => {
  // The half that catches an evaluator turning into "always fail", which is as broken
  // as "always pass" and much easier to ship by accident.
  for (const [metric, { pass }] of Object.entries(fixtures.provable)) {
    assert.equal(await verdictOf(metric, pass), 'pass', `${metric} stopped passing ${pass}`);
  }
});

test('the fixture set covers every metric the platform produces', async () => {
  // A metric added without a fixture would be untested in exactly the way all three
  // bugs were untested.
  const live = new Set<string>();
  for (const s of scenarios) {
    const t = loadTrace(`${s.id}__stub-naive__s0`);
    for (const m of (await evaluateTrace(s, t, policies, CTX)).metrics) live.add(m.metric);
  }
  const known = new Set([...Object.keys(fixtures.provable), ...Object.keys(fixtures.unprovable)]);
  const missing = [...live].filter((m) => !known.has(m));
  assert.deepEqual(missing, [], `metrics with no fixture — run "npm run fixtures":\n  ${missing.join('\n  ')}`);
});

test('metrics that cannot be proven to discriminate are declared, not hidden', () => {
  // These are the honest gap. Each is a metric the corpus has only ever seen in one
  // state, so nothing here demonstrates it can do its job. Naming them is the point —
  // the failure mode is a metric quietly assumed to work.
  assert.deepEqual(Object.keys(fixtures.unprovable).sort(), [
    'caller_abandonment',
    'escalation_latency',
    'escalation_urgency',
    'policy:verify_identity_before_disclosure',
  ], 'the unprovable set changed — either a gap was closed or a new one opened');
});
