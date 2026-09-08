/**
 * Generates the per-metric discrimination fixtures.
 *
 * For every metric, pins one recorded run where it says FAIL and one where it says
 * PASS. That pair is the contract `dataset-discrimination.ts` already enforces for
 * scenarios — a careful agent passes, a careless one fails — applied one level down to
 * the thing doing the judging.
 *
 * HONEST LIMIT: this pins CURRENT behaviour, so it is a regression net, not a proof of
 * correctness. It would have caught all three evaluator bugs the moment anyone changed
 * the code, but it would NOT have caught them at the moment they were written — for
 * that the expected verdicts have to be reasoned about by a human rather than sampled.
 * Every verdict pinned here was reviewed against its trace before being written.
 *
 * Metrics with only one observed verdict are recorded as `unprovable`, which is the
 * honest state: nothing in the corpus can demonstrate they discriminate.
 */
import { writeFileSync } from 'node:fs';
import { loadScenarios } from '../lib/dataset/load.js';
import { loadTrace, listRunIds } from '../lib/store/traces.js';
import { evaluateTrace } from '../lib/eval/registry.js';
import { evaluatorContext } from '../lib/eval/context.js';

const { scenarios, policies } = loadScenarios();
const CTX = evaluatorContext();
const byId = new Map(scenarios.map((s) => [s.id, s]));

const examples = new Map<string, Record<string, string>>();
for (const id of listRunIds().sort()) {
  const t = loadTrace(id);
  const s = byId.get(t.scenario_id);
  if (!s) continue;
  for (const m of (await evaluateTrace(s, t, policies, CTX)).metrics) {
    const e = examples.get(m.metric) ?? {};
    if (!e[m.verdict]) e[m.verdict] = id;   // first run exhibiting this verdict
    examples.set(m.metric, e);
  }
}

const provable: Record<string, { fail: string; pass: string }> = {};
const unprovable: Record<string, string[]> = {};
for (const [metric, seen] of [...examples].sort()) {
  if (seen.fail && seen.pass) provable[metric] = { fail: seen.fail, pass: seen.pass };
  else unprovable[metric] = Object.keys(seen);
}

writeFileSync(
  'tests/fixtures/metric-verdicts.json',
  JSON.stringify({ generated_from: `${listRunIds().length} runs`, provable, unprovable }, null, 2) + '\n',
);
console.log(`  ${Object.keys(provable).length} metrics pinned with a fail AND a pass example`);
console.log(`  ${Object.keys(unprovable).length} metrics cannot be proven to discriminate from this corpus:`);
for (const [m, v] of Object.entries(unprovable)) console.log(`    ${m.padEnd(52)} only ever: ${v.join('/')}`);
