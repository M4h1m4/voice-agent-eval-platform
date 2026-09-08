/**
 * End-to-end persistence: the committed artefacts are the reviewer's entry point, so
 * they must load, validate, and stay stable across regeneration.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runScenario } from '../../lib/harness/orchestrator.js';
import { ScriptedCaller } from '../../lib/caller/scripted.js';
import { stubAgent, type StubKind } from '../../lib/agents/scripted.js';
import { loadScenarios } from '../../lib/dataset/load.js';
import { listRunIds, loadTrace, loadAll, saveTrace, summarise } from '../../lib/store/traces.js';
import { Trace } from '../../lib/types/trace.js';

const { scenarios } = loadScenarios();
const KINDS: StubKind[] = ['oracle', 'naive', 'panicky'];

test('the committed trace set covers every scenario and every stub', () => {
  const ids = new Set(listRunIds());
  for (const s of scenarios) {
    for (const k of KINDS) {
      assert.ok(ids.has(`${s.id}__stub-${k}__s0`), `missing committed trace for ${s.id}/${k}`);
    }
  }
});

test('every committed trace loads and validates', () => {
  // No count assertion: LLM-agent traces from a live run live alongside the stub set,
  // and a test about validity should not fail because a legitimate artefact was added.
  const all = loadAll();
  assert.ok(all.length >= scenarios.length * KINDS.length);
  for (const t of all) assert.ok(Trace.safeParse(t).success, `${t.run_id} failed validation`);
});

test('committed traces match what the harness produces today', async () => {
  // Catches the artefacts going stale after a harness change — a reviewer would
  // otherwise be reading traces the code can no longer generate.
  for (const s of scenarios) {
    for (const k of KINDS) {
      const fresh = await runScenario(s, new ScriptedCaller(s), stubAgent(s.id, k), { seed: 0 });
      const committed = loadTrace(fresh.run_id);
      assert.deepEqual(committed, fresh, `${fresh.run_id} on disk is stale — run "npm run traces"`);
    }
  }
});

test('regenerating rewrites the same bytes', async () => {
  const s = scenarios[0]!;
  const path = `traces/${s.id}__stub-oracle__s0.json`;
  const before = readFileSync(path, 'utf8');
  const t = await runScenario(s, new ScriptedCaller(s), stubAgent(s.id, 'oracle'), { seed: 0 });
  saveTrace(t);
  assert.equal(readFileSync(path, 'utf8'), before, 'regeneration must not churn the artefacts');
});

test('summaries of the committed set reproduce the known behavioural facts', () => {
  const by = new Map(loadAll().map((t) => [t.run_id, summarise(t)]));

  const oracleC = by.get('rx-002-c-silentfail-only__stub-oracle__s0')!;
  const naiveC = by.get('rx-002-c-silentfail-only__stub-naive__s0')!;
  assert.deepEqual(oracleC.faults_fired, ['silent_no_op']);
  assert.deepEqual(naiveC.faults_fired, ['silent_no_op'], 'both met the same fault');
  assert.ok(oracleC.tool_calls > naiveC.tool_calls, 'verification costs extra calls');

  assert.equal(by.get('rx-redflag-escalation-003__stub-oracle__s0')!.escalated, true);
  assert.equal(by.get('rx-redflag-escalation-003__stub-naive__s0')!.escalated, false);
  assert.equal(by.get('sched-reschedule-clean-001__stub-panicky__s0')!.escalated, true);
  assert.equal(by.get('sched-reschedule-clean-001__stub-oracle__s0')!.escalated, false);
});

test('every committed trace records the correction as a memory overwrite where one is expected', () => {
  const t = loadTrace('rx-pharmacy-correction-silentfail-002__stub-oracle__s0');
  const writes = t.events.filter((e) => e.type === 'memory_write' && e.key === 'entities.medication');
  assert.equal(writes.length, 1);
  assert.equal(writes[0]!.after, 'Levothyroxine 75mcg');

  const n = loadTrace('rx-pharmacy-correction-silentfail-002__stub-naive__s0');
  assert.equal(n.final_memory['entities.medication'], 'Lisinopril 10mg');
});
