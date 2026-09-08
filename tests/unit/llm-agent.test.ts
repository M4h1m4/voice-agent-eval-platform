import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LlmAgent, toMessages, llmAgent } from '../../lib/agents/llm.js';
import { toolDefinitions, toWireName, fromWireName } from '../../lib/agents/tool-defs.js';
import { PROMPT_V1, PROMPT_V2, VERIFY_WRITES, AGENT_VERSIONS } from '../../lib/agents/prompts.js';
import { ToolName } from '../../lib/types/tools.js';
import type { LlmRequest } from '../../lib/llm/types.js';
import type { AgentContext } from '../../lib/harness/types.js';

const client = (reply: (req: LlmRequest) => { text?: string; tool_calls?: any[] }) => {
  const prompts: LlmRequest[] = [];
  return {
    prompts,
    async complete(req: LlmRequest) {
      prompts.push(req);
      const r = reply(req);
      return {
        text: r.text ?? '', tool_calls: r.tool_calls ?? [], provider: 'fake', model: req.model,
        usage: { input_tokens: 1, output_tokens: 1 }, prompt_hash: 'h', cache_hit: false,
      };
    },
  };
};
const ctx = (history: AgentContext['history'] = []): AgentContext => ({ history, memory: {}, tools: [] });

// --- tool naming ------------------------------------------------------------

test('dotted tool names round-trip through the wire encoding', () => {
  for (const n of ToolName.options) {
    assert.equal(fromWireName(toWireName(n)), n, `${n} did not survive the round trip`);
  }
});

test('every wire name is legal for the provider', () => {
  // OpenAI requires /^[a-zA-Z0-9_-]{1,64}$/. Dots are rejected outright, so an
  // unencoded name would fail every request rather than degrade quietly.
  for (const d of toolDefinitions()) {
    assert.match(d.name, /^[a-zA-Z0-9_-]{1,64}$/, `${d.name} is not a legal function name`);
  }
});

test('wire names are unique — the encoding cannot collide', () => {
  const names = toolDefinitions().map((d) => d.name);
  assert.equal(new Set(names).size, names.length);
});

// --- tool definitions -------------------------------------------------------

test('every tool the World implements is offered to the model', () => {
  assert.deepEqual(
    toolDefinitions().map((d) => fromWireName(d.name)).sort(),
    [...ToolName.options].sort(),
  );
});

test('tool schemas are derived from the World\'s zod schemas, not written twice', () => {
  const verify = toolDefinitions().find((d) => d.name === 'patients__verify')!;
  const p = verify.parameters as any;
  assert.deepEqual(Object.keys(p.properties).sort(), ['dob', 'name']);
  assert.deepEqual([...p.required].sort(), ['dob', 'name']);
});

test('optional arguments are not marked required', () => {
  const search = toolDefinitions().find((d) => d.name === 'availability__search')!;
  const p = search.parameters as any;
  assert.deepEqual(p.required, ['provider'], 'after/before are optional');
});

test('every tool carries a description — an undescribed tool is one the model misuses', () => {
  for (const d of toolDefinitions()) assert.ok(d.description.length > 20, `${d.name} is under-described`);
});

// --- prompts ----------------------------------------------------------------

test('v2 is v1 plus exactly one block', () => {
  assert.ok(!PROMPT_V1.includes(VERIFY_WRITES), 'the read-back rule must be absent from the baseline');
  assert.ok(PROMPT_V2.includes(VERIFY_WRITES));
  assert.equal(PROMPT_V2.replace(`\n\n${VERIFY_WRITES}`, ''), PROMPT_V1, 'nothing else may differ');
});

test('the baseline is a fair prompt, not a strawman', () => {
  // If v1 were deliberately weak the experiment would measure the gap I designed
  // rather than the change I made.
  for (const [what, re] of [
    ['identity verification', /patients\.verify/],
    ['scope limits', /cannot do it on this line/],
    ['no false claims', /Never state or imply/],
    ['urgent symptoms', /urgency "emergent"/],
    ['memory on correction', /corrects you, write the same key again/],
  ] as const) {
    assert.match(PROMPT_V1, re, `baseline is missing ${what}`);
  }
});

test('agent versions are distinct so runs never collide', () => {
  assert.notEqual(AGENT_VERSIONS.v1.version, AGENT_VERSIONS.v2.version);
});

// --- conversation mapping ---------------------------------------------------

test('tool calls and results are paired by adjacency with matching ids', () => {
  // Every tool_call id must be answered; an unanswered one is a hard provider error.
  const m = toMessages(ctx([
    { role: 'caller', text: 'move my appointment' },
    { role: 'tool_call', name: 'appointments.list', args: { patient_id: 'P-1' } },
    { role: 'tool_result', name: 'appointments.list', result: { ok: true, data: { appointments: [] } } },
    { role: 'agent', text: 'I see one booked.' },
  ]));
  assert.deepEqual(m.map((x) => x.role), ['user', 'assistant', 'tool', 'assistant']);
  const call = (m[1] as any).tool_calls[0];
  assert.equal(call.name, 'appointments__list', 'encoded for the wire');
  assert.equal(call.id, (m[2] as any).tool_call_id, 'result answers its call');
});

test('consecutive tool calls each get their own id', () => {
  const m = toMessages(ctx([
    { role: 'tool_call', name: 'patients.verify', args: {} },
    { role: 'tool_result', name: 'patients.verify', result: { ok: true } },
    { role: 'tool_call', name: 'medications.list', args: {} },
    { role: 'tool_result', name: 'medications.list', result: { ok: true } },
  ]));
  const ids = m.filter((x) => x.role === 'tool').map((x: any) => x.tool_call_id);
  assert.equal(new Set(ids).size, 2);
});

test('a failed tool result is shown to the model, not hidden', () => {
  const m = toMessages(ctx([
    { role: 'tool_call', name: 'appointments.reschedule', args: {} },
    { role: 'tool_result', name: 'appointments.reschedule', result: { ok: false, error: 'slot taken' } },
  ]));
  assert.match((m[1] as any).content, /slot taken/);
});

// --- action mapping ---------------------------------------------------------

test('a tool call becomes a tool action with the name decoded', async () => {
  const c = client(() => ({ tool_calls: [{ id: 'c1', name: 'pharmacy__set_preferred', args: { patient_id: 'P-1', pharmacy_id: 'PH-1' } }] }));
  const a = new LlmAgent('t', PROMPT_V1, c);
  const act = await a.next(ctx());
  assert.deepEqual(act, { kind: 'tool', call: { name: 'pharmacy.set_preferred', args: { patient_id: 'P-1', pharmacy_id: 'PH-1' } } });
});

test('only the first tool call is taken; the rest are dropped, not queued', async () => {
  // A queued call would execute without the model having seen the previous result, and
  // the history rebuilt next turn would not contain it.
  const c = client(() => ({ tool_calls: [
    { id: 'a', name: 'patients__verify', args: {} },
    { id: 'b', name: 'medications__list', args: {} },
  ] }));
  const act = await new LlmAgent('t', PROMPT_V1, c).next(ctx());
  assert.equal((act as any).call.name, 'patients.verify');
});

test('text with no tool call becomes speech', async () => {
  const act = await new LlmAgent('t', PROMPT_V1, client(() => ({ text: '  All set.  ' }))).next(ctx());
  assert.deepEqual(act, { kind: 'speak', text: 'All set.' });
});

test('a tool call wins over accompanying text', async () => {
  const c = client(() => ({ text: 'let me check', tool_calls: [{ id: 'c1', name: 'patients__verify', args: {} }] }));
  assert.equal((await new LlmAgent('t', PROMPT_V1, c).next(ctx())).kind, 'tool');
});

test('an empty response ends the turn instead of looping', async () => {
  assert.deepEqual(await new LlmAgent('t', PROMPT_V1, client(() => ({}))).next(ctx()), { kind: 'end' });
});

test('malformed arguments are passed through for the World to reject', async () => {
  // The World returns a usable error the model can act on; throwing here would lose it.
  const c = client(() => ({ tool_calls: [{ id: 'c1', name: 'refill__request', args: { __malformed__: '{"x":' } }] }));
  const act = await new LlmAgent('t', PROMPT_V1, c).next(ctx());
  assert.equal((act as any).call.args.__malformed__, '{"x":');
});

test('the agent is pinned to temperature 0 and caches as the agent', async () => {
  const c = client(() => ({ text: 'hi' }));
  await new LlmAgent('t', PROMPT_V1, c).next(ctx());
  assert.equal(c.prompts[0]!.temperature, 0);
  assert.equal(c.prompts[0]!.actor, 'agent');
  assert.equal(c.prompts[0]!.tools?.length, ToolName.options.length);
});

test('llmAgent builds the requested version with its prompt', () => {
  const c = client(() => ({}));
  assert.equal(llmAgent('v1', c).version, 'llm-v1');
  assert.equal(llmAgent('v2', c).version, 'llm-v2');
});
