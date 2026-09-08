/**
 * The LLM agent driven through the real orchestrator and World, with a scripted model.
 * Proves the wiring — message mapping across turns, tool round-trips, trace shape —
 * without a network call.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScenario } from '../../lib/harness/orchestrator.js';
import { ScriptedCaller } from '../../lib/caller/scripted.js';
import { LlmAgent } from '../../lib/agents/llm.js';
import { PROMPT_V1 } from '../../lib/agents/prompts.js';
import { loadScenarios } from '../../lib/dataset/load.js';
import { LlmRecorder, CachingClient } from '../../lib/llm/client.js';
import { Trace } from '../../lib/types/trace.js';
import type { LlmRequest } from '../../lib/llm/types.js';

const { scenarios } = loadScenarios();
const byId = new Map(scenarios.map((s) => [s.id, s]));

/** A model that plays a fixed script of replies, and records what it was sent. */
function scriptedModel(replies: { text?: string; tool?: [string, Record<string, unknown>] }[]) {
  const prompts: LlmRequest[] = [];
  let i = 0;
  return {
    prompts,
    async complete(req: LlmRequest) {
      prompts.push(req);
      const r = replies[i++] ?? { text: 'Goodbye.' };
      return {
        text: r.text ?? '',
        tool_calls: r.tool ? [{ id: `c${i}`, name: r.tool[0], args: r.tool[1] }] : [],
        provider: 'fake', model: req.model,
        usage: { input_tokens: 30, output_tokens: 10 }, prompt_hash: `h${i}`, cache_hit: false,
      };
    },
  };
}

test('the agent drives the World through the orchestrator and reaches the right state', async () => {
  const s = byId.get('sched-reschedule-clean-001')!;
  const model = scriptedModel([
    { text: 'Can I take your name and date of birth?' },
    { tool: ['patients__verify', { name: 'Dana Whitfield', dob: '1978-03-14' }] },
    { tool: ['appointments__list', { patient_id: 'P-1001' }] },
    { tool: ['availability__search', { provider: 'Dr. Patel' }] },
    { text: 'I have Monday at 9, Tuesday at 9:30, or Tuesday at 3.' },
    { tool: ['appointments__reschedule', { appointment_id: 'A-5501', new_start: '2026-09-15T09:30' }] },
    { text: 'Done, Tuesday at 9:30.' },
  ]);
  const t = await runScenario(s, new ScriptedCaller(s), new LlmAgent('llm-test', PROMPT_V1, model));

  assert.ok(Trace.safeParse(t).success);
  assert.equal(t.final_state.appointments[0]!.start, '2026-09-15T09:30');
  assert.deepEqual(
    t.events.filter((e) => e.type === 'tool_call').map((e) => e.tool),
    ['patients.verify', 'appointments.list', 'availability.search', 'appointments.reschedule'],
    'wire names decoded back to ours',
  );
});

test('tool results reach the model on the following call', async () => {
  const s = byId.get('sched-reschedule-clean-001')!;
  const model = scriptedModel([
    { tool: ['patients__verify', { name: 'Dana Whitfield', dob: '1978-03-14' }] },
    { text: 'Thanks, verified.' },
  ]);
  await runScenario(s, new ScriptedCaller(s), new LlmAgent('llm-test', PROMPT_V1, model));

  const second = model.prompts[1]!;
  const toolMsg = second.messages.find((m) => m.role === 'tool') as { content: string } | undefined;
  assert.ok(toolMsg, 'the result was sent back');
  assert.match(toolMsg!.content, /P-1001/, 'and it carries the data the World returned');

  const assistantCall = second.messages.find((m) => m.role === 'assistant' && 'tool_calls' in m) as any;
  assert.equal(assistantCall.tool_calls[0].id, (toolMsg as any).tool_call_id ?? undefined,
    'every tool_call id is answered — an unanswered one is a hard provider error');
});

test('a model that invents a tool gets an error it can act on, not a crash', async () => {
  const s = byId.get('sched-reschedule-clean-001')!;
  const model = scriptedModel([
    { tool: ['providers__change', { provider: 'Dr. Okafor' }] },   // no such tool
    { text: 'Sorry, I cannot do that.' },
  ]);
  const t = await runScenario(s, new ScriptedCaller(s), new LlmAgent('llm-test', PROMPT_V1, model));

  const res = t.events.find((e) => e.type === 'tool_result')!;
  assert.equal(res.ok, false);
  assert.match(String(res.error), /unknown tool/);
  assert.equal(res.status, 'ERROR');
  assert.notEqual(t.termination, 'harness_error');
  assert.match(String((model.prompts[1]!.messages.find((m) => m.role === 'tool') as any).content), /unknown tool/);
});

test('a model that mis-shapes arguments gets a validation error back', async () => {
  const s = byId.get('sched-reschedule-clean-001')!;
  const model = scriptedModel([{ tool: ['appointments__reschedule', { appointment_id: 'A-5501' }] }, { text: 'Hmm.' }]);
  const t = await runScenario(s, new ScriptedCaller(s), new LlmAgent('llm-test', PROMPT_V1, model));
  const res = t.events.find((e) => e.type === 'tool_result')!;
  assert.match(String(res.error), /invalid arguments.*new_start/);
});

test('an agent that thrashes on a failing tool terminates and the trace says so', async () => {
  const s = byId.get('sched-reschedule-clean-001')!;
  const model = scriptedModel(Array(40).fill({ tool: ['appointments__list', { patient_id: 'P-1001' }] }));
  const t = await runScenario(s, new ScriptedCaller(s), new LlmAgent('llm-test', PROMPT_V1, model), {
    limits: { maxToolCallsPerTurn: 5 },
  });
  assert.equal(t.termination, 'max_tool_calls');
  assert.ok(t.events.some((e) => e.type === 'error'));
});

test('agent model calls are recorded as llm_call events with actor=agent', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'agentrec-'));

  const s = byId.get('sched-reschedule-clean-001')!;
  const rec = new LlmRecorder();
  const client = new CachingClient(scriptedModel([{ text: 'Hello.' }]), 'live', dir, rec.observe);
  const t = await runScenario(s, new ScriptedCaller(s), new LlmAgent('llm-test', PROMPT_V1, client), { llm: rec });

  const calls = t.events.filter((e) => e.type === 'llm_call');
  assert.ok(calls.length > 0);
  for (const c of calls) {
    assert.equal(c.actor, 'agent');
    assert.ok(c['gen_ai.usage.input_tokens']! > 0);
  }
  rmSync(dir, { recursive: true });
});

test('caller and agent model calls are distinguishable in one trace', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { LlmCaller } = await import('../../lib/caller/llm.js');
  const dir = mkdtempSync(join(tmpdir(), 'bothrec-'));

  const s = byId.get('sched-reschedule-clean-001')!;
  const rec = new LlmRecorder();
  const mk = () => new CachingClient(scriptedModel([{ text: 'ok' }]), 'live', dir, rec.observe);
  const t = await runScenario(s, new LlmCaller(s, mk()), new LlmAgent('llm-test', PROMPT_V1, mk()), { llm: rec });

  const actors = new Set(t.events.filter((e) => e.type === 'llm_call').map((e) => e.actor));
  assert.deepEqual([...actors].sort(), ['agent', 'caller'], 'both sides are attributed');
  rmSync(dir, { recursive: true });
});
