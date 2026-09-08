import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAgent, ALL_SPECS, STUB_KINDS, LLM_VERSIONS, needsLlm, AgentSpecError } from '../../lib/agents/registry.js';
import { AGENT_VERSIONS, PROMPT_V1, PROMPT_V2, VERIFY_WRITES } from '../../lib/agents/prompts.js';
import { FakeClient } from '../../lib/llm/fake.js';
import { loadScenarios } from '../../lib/dataset/load.js';

const { scenarios } = loadScenarios();
const SID = scenarios[0]!.id;

test('every advertised spec resolves for every scenario', () => {
  for (const spec of ALL_SPECS) {
    for (const s of scenarios) {
      assert.ok(resolveAgent(spec, s.id, new FakeClient()).version, `${spec} failed on ${s.id}`);
    }
  }
});

test('agent versions are unique across stubs and LLM agents', () => {
  // Version strings land in run ids. A collision would silently overwrite one run's
  // trace with another's.
  const versions = ALL_SPECS.map((spec) => resolveAgent(spec, SID, new FakeClient()).version);
  assert.equal(new Set(versions).size, versions.length, `collision in ${versions.join(', ')}`);
});

test('unknown specs fail loudly with the valid options', () => {
  for (const bad of ['stub:genius', 'llm:v9', 'robot:v1', 'oracle', '']) {
    assert.throws(() => resolveAgent(bad, SID, new FakeClient()), AgentSpecError, `"${bad}" was accepted`);
  }
});

test('an LLM agent without a client fails at configuration, not at first completion', () => {
  // A missing client and a missing cache entry are different mistakes and must not
  // produce the same message.
  assert.throws(
    () => resolveAgent('llm:v1', SID),
    (e: Error) => e instanceof AgentSpecError && /needs an LLM client/.test(e.message),
  );
});

test('stub agents need no client', () => {
  for (const k of STUB_KINDS) assert.ok(resolveAgent(`stub:${k}`, SID).version);
});

test('needsLlm separates the two families', () => {
  assert.deepEqual(ALL_SPECS.filter(needsLlm), LLM_VERSIONS.map((v) => `llm:${v}`));
});

test('v2 differs from v1 by exactly the read-back instruction', () => {
  const v1 = resolveAgent('llm:v1', SID, new FakeClient());
  const v2 = resolveAgent('llm:v2', SID, new FakeClient());
  assert.notEqual(v1.version, v2.version);
  assert.equal(AGENT_VERSIONS.v1.prompt, PROMPT_V1);
  assert.equal(AGENT_VERSIONS.v2.prompt, PROMPT_V2);
  assert.equal(PROMPT_V2.replace(`\n\n${VERIFY_WRITES}`, ''), PROMPT_V1);
});

test('the read-back instruction names the write tools and their lookups', () => {
  // If it named no tools the model could not follow it, and Part 5 would measure
  // whether a vague instruction helps rather than whether verification does.
  for (const t of ['pharmacy.set_preferred', 'appointments.reschedule', 'refill.request']) {
    assert.ok(VERIFY_WRITES.includes(t), `the rule does not mention ${t}`);
  }
  assert.match(VERIFY_WRITES, /read the record back/i);
});

test('the LLM agent version string is carried into the run id', async () => {
  const { runId } = await import('../../lib/harness/trace-builder.js');
  assert.match(runId(SID, resolveAgent('llm:v2', SID, new FakeClient()).version, 0), /llm-v2/);
});
