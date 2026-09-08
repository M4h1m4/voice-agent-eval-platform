/**
 * The runner as a component: agent selection, caller pairing, and persistence together.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScenario } from '../../lib/harness/orchestrator.js';
import { ScriptedCaller } from '../../lib/caller/scripted.js';
import { LlmCaller } from '../../lib/caller/llm.js';
import { resolveAgent, needsLlm, ALL_SPECS } from '../../lib/agents/registry.js';
import { loadScenarios } from '../../lib/dataset/load.js';
import { FakeClient } from '../../lib/llm/fake.js';
import { Trace } from '../../lib/types/trace.js';

const { scenarios } = loadScenarios();

test('every agent spec runs end to end on every scenario and yields a valid trace', async () => {
  for (const s of scenarios) {
    for (const spec of ALL_SPECS) {
      const client = new FakeClient(() => ({ text: 'Understood.' }));
      const caller = needsLlm(spec) ? new LlmCaller(s, client) : new ScriptedCaller(s);
      const t = await runScenario(s, caller, resolveAgent(spec, s.id, client));
      assert.ok(Trace.safeParse(t).success, `${s.id}/${spec} produced an invalid trace`);
      assert.notEqual(t.termination, 'harness_error', `${s.id}/${spec}`);
    }
  }
});

test('run ids are unique across the whole matrix', async () => {
  // Two runs sharing an id would overwrite each other's trace file.
  const ids = new Set<string>();
  for (const s of scenarios) {
    for (const spec of ALL_SPECS) {
      for (const seed of [0, 1]) {
        const client = new FakeClient();
        const caller = needsLlm(spec) ? new LlmCaller(s, client) : new ScriptedCaller(s);
        const t = await runScenario(s, caller, resolveAgent(spec, s.id, client), { seed });
        assert.ok(!ids.has(t.run_id), `duplicate run id ${t.run_id}`);
        ids.add(t.run_id);
      }
    }
  }
  assert.equal(ids.size, scenarios.length * ALL_SPECS.length * 2);
});

test('v1 and v2 produce different run ids on the same scenario and seed', async () => {
  const s = scenarios[0]!;
  const mk = async (spec: string) => {
    const c = new FakeClient();
    return runScenario(s, new LlmCaller(s, c), resolveAgent(spec, s.id, c), { seed: 0 });
  };
  const [a, b] = [await mk('llm:v1'), await mk('llm:v2')];
  assert.notEqual(a.run_id, b.run_id, 'the Part 5 comparison depends on these not colliding');
  assert.notEqual(a.trace_id, b.trace_id);
});

test('an LLM agent is paired with an LLM caller, not a scripted one', async () => {
  // A real agent against a template caller only half-tests the loop.
  const s = scenarios[0]!;
  const c = new FakeClient(() => ({ text: 'spoken by the model' }));
  const t = await runScenario(s, new LlmCaller(s, c), resolveAgent('llm:v1', s.id, c));
  const turns = t.events.filter((e) => e.type === 'caller_turn');
  assert.ok(turns.every((x) => x.text.startsWith('spoken by the model')), 'the caller should be model-driven');
});
