import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLANS, stubAgent, toolSequence, type StubKind } from '../../lib/agents/scripted.js';
import { loadScenarios } from '../../lib/dataset/load.js';
import { World } from '../../lib/world/clinic.js';
import { ToolName } from '../../lib/types/tools.js';

const { scenarios } = loadScenarios();
const KINDS: StubKind[] = ['oracle', 'naive', 'panicky'];

test('every scenario has a plan for every stub kind', () => {
  for (const s of scenarios) {
    for (const k of KINDS) {
      assert.ok(PLANS[s.id]?.[k], `${s.id} is missing a ${k} plan`);
    }
  }
});

test('no plan exists for a scenario that was deleted', () => {
  const orphans = Object.keys(PLANS).filter((id) => !scenarios.some((s) => s.id === id));
  assert.deepEqual(orphans, [], 'plans must not outlive their scenario');
});

test('every tool named in every plan is a real tool', () => {
  const known = new Set<string>(ToolName.options);
  for (const [id, byKind] of Object.entries(PLANS)) {
    for (const k of KINDS) {
      for (const c of toolSequence(byKind[k])) {
        assert.ok(known.has(c.name), `${id}/${k} calls unknown tool "${c.name}"`);
      }
    }
  }
});

test('an unknown tool name is an error the agent can see, not a crash', async () => {
  // A real LLM will eventually invent a tool. The World must return it as a normal
  // failed result so the trace records it — crashing would destroy the evidence.
  const w = new World(scenarios[0]!.world_state, []);
  const out = await w.invoke({ name: 'pharmacy.set_prefered' as never, args: {} });
  assert.equal(out.result.ok, false);
  assert.match(String(out.result.error), /unknown tool/);
  assert.deepEqual(out.state_before, out.state_after);
});

test('a scripted agent yields its plan in order, then ends forever', async () => {
  const a = stubAgent('sched-reschedule-clean-001', 'oracle');
  const plan = PLANS['sched-reschedule-clean-001']!.oracle;
  const ctx = { history: [], memory: {}, tools: [] as never[] };
  for (const expected of plan) {
    assert.deepEqual(await a.next(ctx), expected);
  }
  assert.deepEqual(await a.next(ctx), { kind: 'end' });
  assert.deepEqual(await a.next(ctx), { kind: 'end' }, 'and stays ended');
});

test('agent versions are distinct, so runs never collide', () => {
  const versions = KINDS.map((k) => stubAgent('sched-reschedule-clean-001', k).version);
  assert.equal(new Set(versions).size, KINDS.length);
});

test('asking for a plan that does not exist fails loudly', () => {
  assert.throws(() => stubAgent('no-such-scenario', 'oracle'), /no oracle plan/);
});

test('the three stubs are behaviourally distinct on every scenario', () => {
  for (const s of scenarios) {
    const sigs = KINDS.map((k) => JSON.stringify(toolSequence(PLANS[s.id]![k])));
    assert.equal(new Set(sigs).size, 3, `${s.id}: two stubs behave identically`);
  }
});

test('only the oracle reads a write back before confirming it', () => {
  for (const id of ['rx-002-c-silentfail-only', 'rx-pharmacy-correction-silentfail-002']) {
    const reads = (k: StubKind) =>
      toolSequence(PLANS[id]![k]).filter((c) => c.name === 'pharmacy.get_preferred').length;
    assert.ok(reads('oracle') > 0, `${id}: oracle must verify`);
    assert.equal(reads('naive'), 0, `${id}: naive must not verify — that is the variable`);
  }
});

test('the discrimination check and the stub agents share one definition', async () => {
  // They were duplicated at first: the answer key and the traces could drift into
  // describing different agents while both looked correct.
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync('scripts/dataset-discrimination.ts', 'utf8'),
  );
  assert.ok(src.includes('toolSequence(PLANS'), 'sequences must be derived from PLANS');
  assert.ok(!/name: 'patients\.verify'/.test(src), 'no hardcoded second copy');
});
