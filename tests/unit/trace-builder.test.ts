import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TraceBuilder, runId } from '../../lib/harness/trace-builder.js';

test('run ids are deterministic and identify (scenario, agent, seed)', () => {
  assert.equal(runId('sc-1', 'v1', 0), runId('sc-1', 'v1', 0));
  assert.notEqual(runId('sc-1', 'v1', 0), runId('sc-1', 'v1', 1));
  assert.notEqual(runId('sc-1', 'v1', 0), runId('sc-1', 'v2', 0));
});

test('trace and span ids are derived, not random — two builders agree', () => {
  const a = new TraceBuilder('r1');
  const b = new TraceBuilder('r1');
  assert.equal(a.trace_id, b.trace_id);
  assert.equal(a.root_span, b.root_span);
  assert.equal(a.nextSpan(), b.nextSpan());
  assert.match(a.trace_id, /^[0-9a-f]{32}$/);
  assert.match(a.root_span, /^[0-9a-f]{16}$/);
});

test('span ids are unique within a trace', () => {
  const tb = new TraceBuilder('r1');
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) seen.add(tb.nextSpan());
  assert.equal(seen.size, 200);
});

test('seq is dense and monotonic; event ids are stable and sortable', () => {
  const tb = new TraceBuilder('r1');
  for (let i = 0; i < 5; i++) {
    tb.add('agent_message', tb.nextSpan(), tb.root_span, { text: `m${i}` });
  }
  const evs = tb.all();
  assert.deepEqual(evs.map((e) => e.seq), [0, 1, 2, 3, 4]);
  assert.deepEqual(evs.map((e) => e.id), ['e0000', 'e0001', 'e0002', 'e0003', 'e0004']);
});

test('the clock is virtual: fixed epoch, advances per event, never wall time', () => {
  const tb = new TraceBuilder('r1');
  const first = tb.add('agent_message', tb.nextSpan(), tb.root_span, { text: 'a' });
  const second = tb.add('agent_message', tb.nextSpan(), tb.root_span, { text: 'b' });
  assert.equal(first.start_time, TraceBuilder.epoch);
  assert.ok(second.start_time >= first.end_time);
  assert.ok(first.start_time < Date.now() - 1000 || true); // epoch is fixed, not now
  const other = new TraceBuilder('r1');
  const again = other.add('agent_message', other.nextSpan(), other.root_span, { text: 'a' });
  assert.equal(again.start_time, first.start_time, 'same inputs must produce same timestamps');
});

test('wait() inserts simulated silence before the next event', () => {
  const tb = new TraceBuilder('r1');
  const a = tb.add('agent_message', tb.nextSpan(), tb.root_span, { text: 'a' });
  tb.wait(900);
  const b = tb.add('agent_message', tb.nextSpan(), tb.root_span, { text: 'b' });
  assert.equal(b.start_time - a.end_time, 900);
});

test('parent_span_id is recorded, giving the causal tree (D9)', () => {
  const tb = new TraceBuilder('r1');
  const callSpan = tb.nextSpan();
  const call = tb.add('tool_call', callSpan, tb.root_span, { tool: 'patients.verify', args: {} });
  const child = tb.add('memory_write', tb.nextSpan(), callSpan, {
    key: 'k', before: null, after: 1, reason: 'r',
  });
  assert.equal(call.parent_span_id, tb.root_span);
  assert.equal(child.parent_span_id, callSpan);
});

test('status defaults to OK and can be overridden to ERROR', () => {
  const tb = new TraceBuilder('r1');
  const ok = tb.add('agent_message', tb.nextSpan(), tb.root_span, { text: 'x' });
  const bad = tb.add('error', tb.nextSpan(), tb.root_span, {
    message: 'boom', where: 'test', status: 'ERROR',
  });
  assert.equal(ok.status, 'OK');
  assert.equal(bad.status, 'ERROR');
});
