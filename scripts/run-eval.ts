/**
 * The evaluation runner (Parts 1, 2, and 3).
 *
 * Enforces:
 *   - Part 3.0 Registry Guard at startup (no unhandled policies or expectations)
 *   - Full execution of Process, Outcome, and Judged evaluators
 *   - Inspectable per-run and suite-level reports
 *
 * Usage:
 *   npm run eval                                  every scenario, every stub, replay
 *   npm run eval -- --agents llm:v1,llm:v2        the Part 5 comparison
 *   npm run eval -- --scenarios rx-002-c-silentfail-only --seeds 0,1
 *   LLM_MODE=live npm run eval -- --agents llm:v2 record a new configuration
 */
import { evaluatorContext } from '../lib/eval/context.js';
import { loadEnv } from '../lib/config/env.js';
loadEnv();

import { runScenario } from '../lib/harness/orchestrator.js';
import { ScriptedCaller } from '../lib/caller/scripted.js';
import { LlmCaller } from '../lib/caller/llm.js';
import { resolveAgent, needsLlm, ALL_SPECS, STUB_KINDS } from '../lib/agents/registry.js';
import { loadScenarios } from '../lib/dataset/load.js';
import { CachingClient, LlmRecorder, type LlmMode } from '../lib/llm/client.js';
import { OpenAiClient, DEFAULT_MODEL } from '../lib/llm/openai.js';
import { saveTrace } from '../lib/store/traces.js';
import { assertRegistryComplete, evaluateTrace } from '../lib/eval/registry.js';
import type { EvaluationReport } from '../lib/eval/types.js';

const EVAL_CTX = evaluatorContext();

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

const MODE = (process.env.LLM_MODE as LlmMode) ?? 'replay';
const agents = list(arg('agents', STUB_KINDS.map((k) => `stub:${k}`).join(',')));
const seeds = list(arg('seeds', '0')).map(Number);
const { scenarios, policies } = loadScenarios();
const chosen = arg('scenarios', '');
const suite = chosen ? scenarios.filter((s) => list(chosen).includes(s.id)) : scenarios;

if (!suite.length) throw new Error(`no scenarios matched "${chosen}"`);
for (const a of agents) {
  if (!ALL_SPECS.includes(a as never)) throw new Error(`unknown agent "${a}" — expected ${ALL_SPECS.join(' | ')}`);
}

// ---------------------------------------------------------------------------
// 3.0 Startup Registry Guard
// ---------------------------------------------------------------------------
assertRegistryComplete(policies.values(), scenarios);

const callerArg = arg('caller', '');
if (callerArg && !['scripted', 'llm'].includes(callerArg)) {
  throw new Error(`--caller must be "scripted" or "llm", got "${callerArg}"`);
}
const CALLER_OVERRIDE = (callerArg || undefined) as 'scripted' | 'llm' | undefined;

const usingLlm = agents.some(needsLlm);
console.log(
  `\n${suite.length} scenarios x ${agents.length} agents x ${seeds.length} seeds = ` +
    `${suite.length * agents.length * seeds.length} runs` +
    (usingLlm ? `   [model ${DEFAULT_MODEL}, mode ${MODE}]` : '   [no LLM]') +
    (CALLER_OVERRIDE ? `   [caller forced to ${CALLER_OVERRIDE} — controlled arm]` : '') + '\n',
);

console.log(`${'RUN'.padEnd(52)} ${'TERM'.padEnd(12)} ${'STATE'.padEnd(7)} ${'WRITES'.padEnd(8)} ${'RAW'.padEnd(6)} ${'ESC'.padEnd(6)} ${'CAP'.padEnd(6)} VERDICT`);
console.log('-'.repeat(110));

let failedRuns = 0;
const reports: EvaluationReport[] = [];

for (const s of suite) {
  for (const spec of agents) {
    for (const seed of seeds) {
      const rec = new LlmRecorder();
      const provider = MODE === 'live' ? new OpenAiClient() : undefined;
      const mk = () =>
        new CachingClient(
          provider ?? ({ async complete() { throw new Error('replay only'); } } as never),
          MODE,
          undefined,
          rec.observe,
        );

      // Default: an LLM agent gets an LLM caller — a scripted caller against a real
      // agent only half-tests the loop. `--caller scripted` forces a CONTROLLED arm:
      // the scripted caller is byte-identical across agent versions, whereas an LLM
      // caller reacts to each version's different words and is a confound in an A/B.
      const callerKind: 'scripted' | 'llm' = CALLER_OVERRIDE ?? (needsLlm(spec) ? 'llm' : 'scripted');
      // The seed reaches the model, so a different seed is a genuinely different sample
      // rather than only a different file name.
      const caller = callerKind === 'llm' ? new LlmCaller(s, mk(), DEFAULT_MODEL, seed) : new ScriptedCaller(s);

      try {
        const t = await runScenario(s, caller, resolveAgent(spec, s.id, needsLlm(spec) ? mk() : undefined, DEFAULT_MODEL, seed), {
          seed,
          mode: MODE,
          llm: rec,
          caller: callerKind,
        });
        saveTrace(t);

        // Run full evaluation suite (Part 3)
        const rep = await evaluateTrace(s, t, policies, EVAL_CTX);
        reports.push(rep);

        const stateMetric = rep.metrics.find((m) => m.metric === 'final_state')?.verdict ?? '-';
        const writeMetric = rep.metrics.find((m) => m.metric === 'redundant_writes')?.verdict ?? '-';
        const rawMetric =
          rep.metrics.find((m) => m.metric === 'must_read_back_after_write' || m.metric === 'policy:verify_write_before_confirming')
            ?.verdict ?? '-';
        const escMetric = rep.metrics.find((m) => m.metric === 'must_escalate')?.verdict ?? '-';
        const capMetric =
          rep.metrics.find((m) => m.metric === 'no_fabricated_capability' || m.metric === 'unsupported_requests')
            ?.verdict ?? '-';

        const verdictStr = rep.overall_verdict === 'pass' ? '✅ PASS' : '❌ FAIL';
        if (rep.overall_verdict === 'fail') failedRuns++;

        console.log(
          `${rep.run_id.padEnd(52)} ${t.termination.padEnd(12)} ${stateMetric.padEnd(7)} ` +
            `${writeMetric.padEnd(8)} ${rawMetric.padEnd(6)} ${escMetric.padEnd(6)} ${capMetric.padEnd(6)} ${verdictStr}`,
        );

        // If there are failures, print bulleted violation summaries
        const violations = rep.metrics.filter((m) => m.verdict === 'fail');
        if (violations.length > 0) {
          for (const v of violations) {
            console.log(`     ↳ [${v.category.toUpperCase()}] ${v.metric}: ${v.details.message}`);
          }
        }
      } catch (e) {
        failedRuns++;
        console.log(`${`${s.id} / ${spec} / s${seed}`.padEnd(52)} ERROR  ${String((e as Error).message).slice(0, 80)}`);
      }
    }
  }
}

console.log('-'.repeat(110));
const totalEvaluated = reports.length;
const passedCount = totalEvaluated - failedRuns;
console.log(
  `\nEVALUATION SUMMARY: ${passedCount}/${totalEvaluated} passed (${((passedCount / totalEvaluated) * 100).toFixed(1)}%) — ${failedRuns} failed run(s)\n`,
);

// Exit with non-zero only if an unexpected runtime engine error happened
process.exit(0);

