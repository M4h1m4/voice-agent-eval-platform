import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unexpectedRecordsEvaluator } from '../../lib/eval/outcome/unexpected-records.js';
import { loadScenarios } from '../../lib/dataset/load.js';
import { loadTrace } from '../../lib/store/traces.js';

const { scenarios } = loadScenarios();
const byId = new Map(scenarios.map((s) => [s.id, s]));
const run = (sid: string, rid: string) =>
  (unexpectedRecordsEvaluator(byId.get(sid)!, loadTrace(rid)) as never[])[0] as
    { verdict: string; details: { message: string; evidence_events?: string[] } };

test('a run that dispensed the right drug AND a wrong one fails', () => {
  // The bug this metric exists for: the agent submitted a mis-heard drug, was
  // corrected, submitted the right one, and every other outcome metric passed because
  // the expected record was present. Two prescriptions went out.
  const r = run('rx-002-d-asr-drugname', 'rx-002-d-asr-drugname__llm-v1__s0');
  assert.equal(r.verdict, 'fail');
  assert.match(r.details.message, /Hydroxyzine/);
  assert.ok((r.details.evidence_events ?? []).length > 0, 'must point at the writes');
});

test('a rescheduled appointment is a mutation, not a new record', () => {
  // A first version compared records to the initial state and flagged every reschedule,
  // because the row changed. Rescheduling moves a booking; it does not create one.
  const r = run('sched-reschedule-clean-001', 'sched-reschedule-clean-001__stub-oracle__s0');
  assert.equal(r.verdict, 'pass');
});

test('one record with a wrong field is not an extra record', () => {
  // rx-002-c ends with a single refill pointing at the wrong pharmacy. `final_state`
  // already reports that. Reporting it here too would add noise to a named failure.
  const r = run('rx-002-c-silentfail-only', 'rx-002-c-silentfail-only__stub-naive__s0');
  assert.equal(r.verdict, 'pass', "a wrong field is final_state work, not this metric work");
});

test('a clean run passes', () => {
  const r = run('rx-002-d-asr-drugname', 'rx-002-d-asr-drugname__stub-oracle__s0');
  assert.equal(r.verdict, 'pass');
});

test('scenarios that declare no final_state produce no metric at all', () => {
  const s = structuredClone(byId.get('rx-002-d-asr-drugname')!);
  delete (s.expected_outcome as { final_state?: unknown }).final_state;
  const out = unexpectedRecordsEvaluator(s, loadTrace('rx-002-d-asr-drugname__llm-v1__s0')) as never[];
  assert.deepEqual(out, [], 'an always-passing metric is worse than no metric');
});
