/**
 * The loop, end to end, in one command. No API key required.
 *
 *   scenario -> agent interaction -> captured trace -> automated evaluation
 *            -> inspectable result
 *
 * Uses the recorded LLM runs, so it shows what a real model actually did rather than a
 * scripted stand-in.
 */
import { evaluatorContext } from '../lib/eval/context.js';
import { loadEnv } from '../lib/config/env.js';
loadEnv();
import { loadScenarios } from '../lib/dataset/load.js';
import { loadTrace } from '../lib/store/traces.js';
import { evaluateTrace } from '../lib/eval/registry.js';

const EVAL_CTX = evaluatorContext();

const { scenarios, policies } = loadScenarios();
const rule = (t: string) => console.log(`\n${'='.repeat(92)}\n${t}\n${'='.repeat(92)}`);
const S = scenarios.find((x) => x.id === 'rx-002-c-silentfail-only')!;

// --- 1. SCENARIO -----------------------------------------------------------
rule('1. SCENARIO — what we are testing, and what is deliberately broken');
console.log(`\n  ${S.id}   [${S.role}, ${S.difficulty}]`);
console.log(`  goal: ${S.caller_goal.trim().replace(/\s+/g, ' ')}`);
console.log(`\n  caller beats : ${S.turn_plan.map((b) => b.kind).join(' -> ')}`);
for (const f of S.tool_faults) {
  console.log(`  INJECTED FAULT: ${f.tool} -> ${f.mode}`);
  console.log(`    ${f.detail?.trim().replace(/\s+/g, ' ').slice(0, 150)}`);
}
console.log(`\n  passing requires: preferred_pharmacy = ${S.expected_outcome.final_state?.preferred_pharmacy?.['P-2044']}`);
console.log(`                    read-back before confirming = ${S.expected_outcome.must_read_back_after_write}`);

// --- 2 + 3. INTERACTION AND TRACE -----------------------------------------
const t = loadTrace(`${S.id}__llm-v1__s0`);
rule('2 + 3. AGENT INTERACTION -> CAPTURED TRACE   (gpt-4o-mini, recorded, replayed offline)');
console.log();
for (const e of t.events) {
  if (e.type === 'caller_turn') console.log(`  CALLER  "${e.text.slice(0, 74)}"`);
  else if (e.type === 'agent_message') console.log(`  AGENT   "${e.text.slice(0, 74)}"`);
  else if (e.type === 'tool_call') console.log(`    ${e.id}  call   ${e.tool}`);
  else if (e.type === 'tool_result') {
    const changed = JSON.stringify(e.state_before) !== JSON.stringify(e.state_after);
    console.log(`            ->     ok=${e.ok}${e.fault_applied ? `  FAULT=${e.fault_applied}` : ''}  world_changed=${changed}`);
  }
}
console.log(`\n  termination: ${t.termination}   limits: ${JSON.stringify(t.limits)}`);

// --- The thesis ------------------------------------------------------------
rule('THE POINT — the transcript and the database disagree');
const claim = t.events.filter((e) => e.type === 'agent_message').at(-2)!;
console.log(`\n  the agent said     : "${claim.text.slice(0, 78)}"`);
console.log(`  the tool returned  : ok = true`);
console.log(`  pharmacy at start  : ${t.initial_state.preferred_pharmacy['P-2044']}  (CVS)`);
console.log(`  pharmacy at end    : ${t.final_state.preferred_pharmacy['P-2044']}  (unchanged)`);
console.log(`\n  A transcript-only evaluator scores this a clean, successful call.`);

// --- 4. AUTOMATED EVALUATION ----------------------------------------------
const r = await evaluateTrace(S, t, policies, EVAL_CTX);
rule('4. AUTOMATED EVALUATION — and the evidence each verdict rests on');
console.log(`\n  overall: ${r.overall_verdict.toUpperCase()}   ` +
  `${r.summary.passed} passed / ${r.summary.failed} failed / ${r.summary.unexercised} unexercised\n`);
for (const m of r.metrics.filter((x) => x.verdict === 'fail')) {
  console.log(`  FAIL  [${m.category}] ${m.metric}`);
  console.log(`        ${m.details.message.slice(0, 110)}`);
  const ev = m.details.evidence_events ?? [];
  if (ev.length) {
    for (const id of ev.slice(0, 3)) {
      const e = t.events.find((x) => x.id === id)!;
      const d = e.type === 'tool_call' ? e.tool : 'text' in e ? `"${(e as any).text.slice(0, 46)}"` : e.type;
      console.log(`        evidence ${id}  ${e.type.padEnd(14)} ${d}`);
    }
  } else console.log(`        evidence: the final world state`);
  console.log();
}

// --- 5. INSPECTABLE + THE EXPERIMENT --------------------------------------
rule('5. INSPECTABLE RESULT  ->  npm start, then open the run and click an evidence chip');
rule('AND THE EXPERIMENT — v1 vs v2, with the caller held identical');
const arms = [['reactive  (llm caller)', ''], ['controlled (scripted)', '__c-scripted']] as const;
console.log();
for (const [name, suffix] of arms) {
  let back = 0, fwd = 0;
  for (const s of scenarios) {
    const a = await evaluateTrace(s, loadTrace(`${s.id}__llm-v1__s0${suffix}`), policies);
    const b = await evaluateTrace(s, loadTrace(`${s.id}__llm-v2__s0${suffix}`), policies);
    back += b.metrics.filter((m) => m.verdict === 'fail' && a.metrics.find((x) => x.metric === m.metric)?.verdict === 'pass').length;
    fwd += a.metrics.filter((m) => m.verdict === 'fail' && b.metrics.find((x) => x.metric === m.metric)?.verdict === 'pass').length;
  }
  console.log(`  ${name.padEnd(24)} regressed ${String(back).padStart(2)}   improved ${String(fwd).padStart(2)}`);
}
console.log(`
  The reactive arm says "v2 is simply worse". Holding the caller fixed shows the
  read-back instruction DOES work — it just also causes an unbounded write loop.
  The confound hid a real improvement.
`);
