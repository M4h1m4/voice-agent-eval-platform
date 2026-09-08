import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveTrace, loadTrace, listRunIds, summarise, loadAll, TraceStoreError } from '../../lib/store/traces.js';
import { runScenario } from '../../lib/harness/orchestrator.js';
import { ScriptedCaller } from '../../lib/caller/scripted.js';
import { stubAgent } from '../../lib/agents/scripted.js';
import { loadScenarios } from '../../lib/dataset/load.js';
import type { Trace } from '../../lib/types/trace.js';

const { scenarios } = loadScenarios();
const fresh = () => mkdtempSync(join(tmpdir(), 'traces-'));
const make = (id = 'rx-002-c-silentfail-only', kind: 'oracle' | 'naive' = 'oracle') => {
  const s = scenarios.find((x) => x.id === id)!;
  return runScenario(s, new ScriptedCaller(s), stubAgent(id, kind));
};

test('a saved trace reloads byte-identically', async () => {
  const dir = fresh();
  const t = await make();
  saveTrace(t, dir);
  assert.deepEqual(loadTrace(t.run_id, dir), t);
  rmSync(dir, { recursive: true });
});

test('re-saving the same configuration overwrites rather than accumulating', async () => {
  const dir = fresh();
  const t = await make();
  saveTrace(t, dir);
  saveTrace(t, dir);
  assert.deepEqual(listRunIds(dir), [t.run_id]);
  rmSync(dir, { recursive: true });
});

test('the write is atomic — no .tmp file survives', async () => {
  const dir = fresh();
  saveTrace(await make(), dir);
  assert.ok(!readdirSync(dir).some((f) => f.endsWith('.tmp')), 'a partial file would parse as a shorter trace');
  rmSync(dir, { recursive: true });
});

test('a missing trace fails with a useful message, not undefined', () => {
  const dir = fresh();
  assert.throws(() => loadTrace('nope', dir), (e: Error) => e instanceof TraceStoreError && /no trace "nope"/.test(e.message));
  rmSync(dir, { recursive: true });
});

test('a corrupt file fails loudly instead of loading partially', () => {
  const dir = fresh();
  writeFileSync(join(dir, 'broken.json'), '{ "run_id": "broken", ', 'utf8');
  assert.throws(() => loadTrace('broken', dir), (e: Error) => e instanceof TraceStoreError && /not valid JSON/.test(e.message));
  rmSync(dir, { recursive: true });
});

test('a trace that has drifted from the schema is rejected, with the reason', async () => {
  // The case that matters: written by an older build, or hand-edited. A half-parsed
  // trace produces evaluations that look real.
  const dir = fresh();
  const t = await make();
  const damaged = { ...t, events: t.events.map((e, i) => (i === 2 ? { ...e, seq: 'two' } : e)) };
  writeFileSync(join(dir, `${t.run_id}.json`), JSON.stringify(damaged), 'utf8');
  assert.throws(
    () => loadTrace(t.run_id, dir),
    (e: Error) => e instanceof TraceStoreError && /does not match the schema/.test(e.message) && /seq/.test(e.message),
  );
  rmSync(dir, { recursive: true });
});

test('an invalid trace is refused at save time, not discovered on read', async () => {
  const dir = fresh();
  const t = await make();
  assert.throws(
    () => saveTrace({ ...t, termination: 'exploded' } as unknown as Trace, dir),
    (e: Error) => e instanceof TraceStoreError && /refusing to save/.test(e.message),
  );
  assert.deepEqual(listRunIds(dir), [], 'nothing was written');
  rmSync(dir, { recursive: true });
});

test('listRunIds is sorted and ignores non-trace files', async () => {
  const dir = fresh();
  saveTrace(await make('rx-002-c-silentfail-only', 'oracle'), dir);
  saveTrace(await make('rx-002-c-silentfail-only', 'naive'), dir);
  writeFileSync(join(dir, 'README.md'), 'not a trace', 'utf8');
  const ids = listRunIds(dir);
  assert.equal(ids.length, 2);
  assert.deepEqual(ids, [...ids].sort());
  rmSync(dir, { recursive: true });
});

test('listing an empty or absent directory returns nothing rather than throwing', () => {
  assert.deepEqual(listRunIds(join(tmpdir(), 'definitely-not-here-9f2a')), []);
});

test('the summary is derived from the trace, so it cannot disagree with it', async () => {
  const t = await make('rx-002-c-silentfail-only', 'oracle');
  const s = summarise(t);
  assert.equal(s.turns, t.events.filter((e) => e.type === 'caller_turn').length);
  assert.equal(s.tool_calls, t.events.filter((e) => e.type === 'tool_call').length);
  assert.equal(s.memory_writes, t.events.filter((e) => e.type === 'memory_write').length);
  assert.equal(s.escalated, t.final_state.escalations.length > 0);
  assert.deepEqual(s.faults_fired, ['silent_no_op'], 'the fault that fired is surfaced');
});

test('loadAll round-trips every trace in a directory', async () => {
  const dir = fresh();
  const a = await make('rx-002-c-silentfail-only', 'oracle');
  const b = await make('rx-002-c-silentfail-only', 'naive');
  saveTrace(a, dir);
  saveTrace(b, dir);
  const all = loadAll(dir);
  assert.equal(all.length, 2);
  assert.deepEqual(new Set(all.map((t) => t.run_id)), new Set([a.run_id, b.run_id]));
  rmSync(dir, { recursive: true });
});

test('save -> load -> save is byte-stable', async () => {
  // Zod rebuilds objects in schema key order. Writing the raw input instead of the
  // parsed value made a reloaded trace serialise differently from the original, so
  // committed artefacts would churn on every regeneration.
  const dir = fresh();
  const t = await make();
  const p1 = saveTrace(t, dir);
  const first = readFileSync(p1, 'utf8');
  saveTrace(loadTrace(t.run_id, dir), dir);
  assert.equal(readFileSync(p1, 'utf8'), first, 'a round-trip must not rewrite the file');
  rmSync(dir, { recursive: true });
});

test('what is on disk is exactly what loads back', async () => {
  const dir = fresh();
  const t = await make();
  const path = saveTrace(t, dir);
  const onDisk = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(onDisk, loadTrace(t.run_id, dir));
  rmSync(dir, { recursive: true });
});
