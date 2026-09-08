/**
 * v1 vs v2, in both arms.
 *
 *   REACTIVE   LLM caller. Realistic — it answers whatever each agent version said —
 *              but therefore NOT the same caller in both arms, which is a confound.
 *   CONTROLLED Scripted caller. Byte-identical utterances across both arms, so the
 *              only thing that differs is the agent prompt.
 *
 * Reporting both is the honest form: agreement between them is evidence the effect is
 * the agent's; disagreement localises it to the caller.
 */
import { loadEnv } from '../lib/config/env.js';
loadEnv();
import { loadScenarios } from '../lib/dataset/load.js';
import { loadTrace } from '../lib/store/traces.js';
import { evaluateTrace } from '../lib/eval/registry.js';

const { scenarios, policies } = loadScenarios();
const ARMS = [
  { name: 'reactive  (llm caller)', suffix: '' },
  { name: 'controlled (scripted)  ', suffix: '__c-scripted' },
];

for (const arm of ARMS) {
  console.log(`\n${'='.repeat(96)}\n${arm.name}\n${'='.repeat(96)}`);
  console.log(`${'scenario'.padEnd(40)} ${'v1'.padEnd(16)} ${'v2'.padEnd(16)} moved`);
  console.log('-'.repeat(96));

  let regressions = 0, improvements = 0;
  for (const s of scenarios) {
    try {
      const a = await evaluateTrace(s, loadTrace(`${s.id}__llm-v1__s0${arm.suffix}`), policies);
      const b = await evaluateTrace(s, loadTrace(`${s.id}__llm-v2__s0${arm.suffix}`), policies);

      const back = b.metrics.filter((m) => m.verdict === 'fail' && a.metrics.find((x) => x.metric === m.metric)?.verdict === 'pass');
      const fwd = a.metrics.filter((m) => m.verdict === 'fail' && b.metrics.find((x) => x.metric === m.metric)?.verdict === 'pass');
      regressions += back.length; improvements += fwd.length;

      const label = (r: typeof a) => `${r.overall_verdict}(${r.summary.failed}f)`;
      const moved = [back.length ? `-${back.length}` : '', fwd.length ? `+${fwd.length}` : ''].filter(Boolean).join(' ') || '=';
      console.log(`${s.id.padEnd(40)} ${label(a).padEnd(16)} ${label(b).padEnd(16)} ${moved}`);
      for (const m of back) console.log(`${' '.repeat(42)}REGRESSED  ${m.metric}`);
      for (const m of fwd) console.log(`${' '.repeat(42)}improved   ${m.metric}`);
    } catch (e) {
      console.log(`${s.id.padEnd(40)} (missing trace: ${String((e as Error).message).slice(0, 40)})`);
    }
  }
  console.log(`\n  metrics regressed: ${regressions}   improved: ${improvements}`);
}
console.log();
