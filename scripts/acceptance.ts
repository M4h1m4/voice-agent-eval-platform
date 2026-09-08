/**
 * Acceptance run: Parts 1 and 2 together, with a real model on both sides.
 *
 * Results are split into two kinds that must not be confused.
 *
 *   INVARIANTS   must hold no matter how good or bad the agent is. Assertions. A
 *                failure here is a bug in the harness or the dataset.
 *   OBSERVATIONS what the agent actually did. NOT pass/fail — the evaluators do not
 *                exist yet, and calling these results would be inventing a verdict.
 *
 * Run live once to record the cache, then it replays forever with no key:
 *
 *   LLM_MODE=live  OPENAI_API_KEY=... npx tsx scripts/acceptance.ts
 *   npx tsx scripts/acceptance.ts          # replay, offline, free
 */
import { loadEnv } from '../lib/config/env.js';
loadEnv();

import { runScenario } from '../lib/harness/orchestrator.js';
import { LlmCaller } from '../lib/caller/llm.js';
import { llmAgent } from '../lib/agents/llm.js';
import { loadScenarios } from '../lib/dataset/load.js';
import { CachingClient, LlmRecorder, type LlmMode } from '../lib/llm/client.js';
import { OpenAiClient, DEFAULT_MODEL } from '../lib/llm/openai.js';
import { saveTrace } from '../lib/store/traces.js';
import { matchFinalState } from '../lib/eval/state-match.js';
import { Trace, type Trace as TraceT } from '../lib/types/trace.js';
import type { Scenario } from '../lib/types/scenario.js';
import type { AgentVersionKey } from '../lib/agents/prompts.js';

const MODE = (process.env.LLM_MODE as LlmMode) ?? 'replay';
const VERSION = (process.argv[2] as AgentVersionKey) ?? 'v1';
const { scenarios } = loadScenarios();

/** Which lookup confirms which write. Used for the ordering-aware read-back check. */
const READ_BACK_FOR = {
  'pharmacy.set_preferred': 'pharmacy.get_preferred',
  'appointments.reschedule': 'appointments.list',
  'refill.request': 'medications.list',
} as const;

/** Strip the fields that describe how a run was obtained rather than what happened. */
const normalise = (t: TraceT) =>
  JSON.stringify({
    ...t,
    mode: 'x',
    events: t.events.map((e) => (e.type === 'llm_call' ? { ...e, cache_hit: false } : e)),
  });

function firstDifference(a: string, b: string): string {
  const i = [...a].findIndex((c, n) => c !== b[n]);
  return i === -1 ? 'lengths differ' : `first divergence at char ${i}: ...${a.slice(Math.max(0, i - 60), i + 60)}`;
}

type Failure = { scenario: string; check: string; detail: string };
const failures: Failure[] = [];
const fail = (scenario: string, check: string, detail: string) => failures.push({ scenario, check, detail });

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

function checkInvariants(s: Scenario, t: TraceT) {
  if (t.termination === 'harness_error') fail(s.id, 'terminates cleanly', t.termination);

  const parsed = Trace.safeParse(t);
  if (!parsed.success) {
    fail(s.id, 'trace validates', parsed.error.issues.slice(0, 2).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }

  for (const e of t.events) {
    if (e.type !== 'tool_call') continue;
    const outcome = t.events.find((x) => x.parent_span_id === e.span_id);
    if (!outcome) fail(s.id, 'every tool call has an outcome', `${e.tool} at seq ${e.seq}`);
  }

  // The simulator-bias check: an LLM patient handed the persona will volunteer things
  // it was told to withhold, and if it does the trap dies silently while every scenario
  // still runs and reports.
  //
  // Only facts a reveal_if_asked beat can actually disclose are checked, and only for
  // turns BEFORE that beat fires. The first version compared against every hidden fact
  // over every turn, and false-positived on the red-flag scenario, whose "hidden" facts
  // paraphrased what the red_flag beat says out loud. That was a real dataset defect —
  // facts no beat could disclose — now rejected by the loader (D23).
  const turns = t.events.filter((e): e is Extract<TraceT['events'][number], { type: 'caller_turn' }> => e.type === 'caller_turn');
  for (const beat of s.turn_plan) {
    if (beat.kind !== 'reveal_if_asked') continue;
    const value = s.hidden_facts[beat.fact];
    if (!value) continue;
    const revealIdx = turns.findIndex((x) => x.beat_kind === 'reveal_if_asked');
    const cutoff = revealIdx === -1 ? turns.length : revealIdx;
    const words = value.toLowerCase().split(/\s+/).filter((w) => w.length > 4);
    turns.slice(0, cutoff).forEach((turn, i) => {
      const hits = words.filter((w) => turn.text.toLowerCase().includes(w));
      if (hits.length >= 2) {
        fail(s.id, 'hidden facts stay hidden', `"${beat.fact}" leaked at turn ${i} (${hits.join(', ')}): "${turn.text}"`);
      }
    });
  }

  const llm = t.events.filter((e) => e.type === 'llm_call');
  if (llm.length === 0) fail(s.id, 'model calls are recorded', 'no llm_call events');
  for (const c of llm) {
    if (!c.prompt_hash) fail(s.id, 'model calls carry a prompt hash', `seq ${c.seq}`);
    if (!c['gen_ai.usage.input_tokens']) fail(s.id, 'model calls carry token usage', `seq ${c.seq}`);
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function once(s: Scenario, mode: LlmMode): Promise<TraceT> {
  const rec = new LlmRecorder();
  const provider = mode === 'live' ? new OpenAiClient() : { async complete() { throw new Error('replay only'); } };
  const mk = () => new CachingClient(provider as never, mode, undefined, rec.observe);
  return runScenario(s, new LlmCaller(s, mk()), llmAgent(VERSION, mk()), { llm: rec, mode });
}

console.log(`\nacceptance run — agent ${VERSION}, model ${DEFAULT_MODEL}, mode ${MODE}\n`);

const traces: TraceT[] = [];
for (const s of scenarios) {
  process.stdout.write(`  ${s.id} ... `);
  try {
    const t = await once(s, MODE);
    checkInvariants(s, t);
    saveTrace(t);
    traces.push(t);
    console.log(`${t.termination} (${t.events.filter((e) => e.type === 'caller_turn').length} turns)`);
  } catch (e) {
    fail(s.id, 'run completes', String((e as Error).message).slice(0, 200));
    console.log('ERROR');
  }
}

// Reproducibility: a second pass in replay must be byte-identical.
if (MODE === 'live') {
  for (const s of scenarios) {
    try {
      const again = await once(s, 'replay');
      const first = traces.find((t) => t.scenario_id === s.id);
      // `mode` and `cache_hit` describe HOW a run was obtained, not what happened in
      // it, and must differ between a live run and its replay. Comparing them raw made
      // this check impossible to pass, which is worse than not having it.
      if (first && normalise(again) !== normalise(first)) {
        fail(s.id, 'replay reproduces the live run', firstDifference(normalise(first), normalise(again)));
      }
    } catch (e) {
      fail(s.id, 'replay reproduces the live run', String((e as Error).message).slice(0, 160));
    }
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log(`\n${'='.repeat(100)}\nINVARIANTS\n${'='.repeat(100)}`);
if (!failures.length) console.log('  all hold');
for (const f of failures) console.log(`  FAIL  ${f.scenario}\n        ${f.check}: ${f.detail}`);

console.log(`\n${'='.repeat(100)}\nOBSERVATIONS  (not verdicts — the evaluators do not exist yet)\n${'='.repeat(100)}`);
console.log(`${'scenario'.padEnd(40)} ${'termination'.padEnd(14)} turns tools esc read-back state`);
console.log('-'.repeat(100));
for (const t of traces) {
  const s = scenarios.find((x) => x.id === t.scenario_id)!;
  const tools = t.events.filter((e) => e.type === 'tool_call');
  const names = tools.map((e) => e.tool);
  // Ordering matters: a lookup BEFORE a write is not verification. The first version
  // asked only whether a read tool appeared anywhere, and reported "read-back: yes" for
  // every v1 run while the true count of read-after-write was zero.
  const wrote = names.some((n) => n in READ_BACK_FOR);
  const read = names.some((n, i) => {
    const expected = READ_BACK_FOR[n as keyof typeof READ_BACK_FOR];
    return expected !== undefined && names.slice(i + 1).includes(expected);
  });
  const primary = matchFinalState(s.expected_outcome.final_state as never, t.final_state);
  const variant = s.acceptable_variants.some((v) => matchFinalState(v.final_state as never, t.final_state).length === 0);
  console.log(
    `${t.scenario_id.padEnd(40)} ${t.termination.padEnd(14)} ${String(t.events.filter(e=>e.type==='caller_turn').length).padStart(5)} ` +
    `${String(tools.length).padStart(5)} ${(t.final_state.escalations.length ? 'yes' : 'no').padStart(3)} ` +
    `${(wrote ? (read ? 'yes' : 'NO') : '-').padStart(9)} ${primary.length === 0 || variant ? 'match' : `${primary.length} off`}`,
  );
}

console.log(`\n${'='.repeat(100)}\nTOOL SEQUENCES\n${'='.repeat(100)}`);
for (const t of traces) {
  console.log(`\n  ${t.scenario_id}`);
  console.log(`    ${t.events.filter((e) => e.type === 'tool_call').map((e) => e.tool).join(' -> ') || '(none)'}`);
  const last = t.events.filter((e) => e.type === 'agent_message').at(-1);
  if (last) console.log(`    closing: "${last.text.slice(0, 110)}"`);
}
console.log();
process.exit(failures.length ? 1 : 0);
