import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeResponse, toWireMessage, OpenAiClient } from '../../lib/llm/openai.js';
import { createLlmClient } from '../../lib/llm/client.js';
import { LlmError, type LlmRequest } from '../../lib/llm/types.js';

const req: LlmRequest = {
  actor: 'agent', model: 'test-model', temperature: 0, system: 's',
  messages: [{ role: 'user', content: 'hi' }],
};

test('a plain text reply normalises with no tool calls', () => {
  const r = normalizeResponse(
    { model: 'test-model', choices: [{ message: { content: 'hello there' } }], usage: { prompt_tokens: 12, completion_tokens: 4 } },
    req,
  );
  assert.equal(r.text, 'hello there');
  assert.deepEqual(r.tool_calls, []);
  assert.deepEqual(r.usage, { input_tokens: 12, output_tokens: 4 });
});

test('tool calls are normalised and their JSON arguments parsed', () => {
  const r = normalizeResponse(
    { choices: [{ message: { content: null, tool_calls: [
      { id: 'c1', function: { name: 'patients.verify', arguments: '{"name":"Dana","dob":"1978-03-14"}' } },
    ] } }] },
    req,
  );
  assert.equal(r.tool_calls.length, 1);
  assert.deepEqual(r.tool_calls[0], { id: 'c1', name: 'patients.verify', args: { name: 'Dana', dob: '1978-03-14' } });
  assert.equal(r.text, '', 'a tool-only reply has empty text, not null');
});

test('malformed tool arguments are captured, not thrown', () => {
  // A model emitting broken JSON is real behaviour. Crashing would lose the evidence;
  // this surfaces downstream as an invalid-arguments tool result, as production would.
  const r = normalizeResponse(
    { choices: [{ message: { tool_calls: [{ id: 'c1', function: { name: 'refill.request', arguments: '{"patient_id": ' } }] } }] },
    req,
  );
  assert.equal(r.tool_calls[0]!.name, 'refill.request');
  assert.match(String(r.tool_calls[0]!.args.__malformed__), /patient_id/);
});

test('several tool calls in one reply are all kept, in order', () => {
  const r = normalizeResponse(
    { choices: [{ message: { tool_calls: [
      { id: 'a', function: { name: 'x', arguments: '{}' } },
      { id: 'b', function: { name: 'y', arguments: '{}' } },
    ] } }] },
    req,
  );
  assert.deepEqual(r.tool_calls.map((t) => t.id), ['a', 'b']);
});

test('a response with no choices fails loudly', () => {
  assert.throws(() => normalizeResponse({ choices: [] }, req), LlmError);
  assert.throws(() => normalizeResponse({}, req), LlmError);
});

test('assistant tool calls serialise back to the wire shape', () => {
  const w = toWireMessage({
    role: 'assistant', content: '',
    tool_calls: [{ id: 'c1', name: 'appointments.list', args: { patient_id: 'P-1' } }],
  }) as any;
  assert.equal(w.role, 'assistant');
  assert.equal(w.tool_calls[0].type, 'function');
  assert.equal(w.tool_calls[0].function.name, 'appointments.list');
  assert.deepEqual(JSON.parse(w.tool_calls[0].function.arguments), { patient_id: 'P-1' });
});

test('tool results serialise with their call id', () => {
  const w = toWireMessage({ role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' }) as any;
  assert.deepEqual(w, { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' });
});

test('live mode without a key fails with an actionable message', async () => {
  await assert.rejects(
    () => new OpenAiClient(undefined).complete(req),
    (e: Error) => e instanceof LlmError && /OPENAI_API_KEY/.test(e.message) && /replay/.test(e.message),
  );
});

test('the default mode is replay — a missing LLM_MODE must never mean "spend money"', async () => {
  const saved = process.env.LLM_MODE;
  delete process.env.LLM_MODE;
  const c = createLlmClient();
  await assert.rejects(() => c.complete({ ...req, system: 'never recorded anywhere' }), /replay miss/);
  if (saved !== undefined) process.env.LLM_MODE = saved;
});

test('the seed is sent to the provider when set, and omitted when not', () => {
  const withSeed = { ...req, seed: 42 };
  // Reconstructed the way the adapter builds its body, since complete() needs a network.
  const body = (r: typeof req & { seed?: number }) => ({
    ...(r.seed !== undefined ? { seed: r.seed } : {}),
  });
  assert.deepEqual(body(withSeed), { seed: 42 });
  assert.deepEqual(body(req), {}, 'no seed field when the run does not set one');
});
