import { test } from 'node:test';
import { loadScenarios } from '../../lib/dataset/load.js';
import { listRunIds, loadTrace } from '../../lib/store/traces.js';
import assert from 'node:assert/strict';
import { startServer } from '../../lib/server/index.js';
import { loadReview, deleteReview } from '../../lib/store/reviews.js';

/**
 * A recorded v2 run that actually exhibits the write loop.
 *
 * Chosen by search rather than pinned to a seed: the loop reproduces on 4 of 5 seeds,
 * and seed 0 happens to be the one that does not. Hardcoding it made these tests depend
 * on which sample the cache held.
 */
const LOOPING_V2 = (() => {
  const id = listRunIds().find(
    (r) =>
      r.startsWith('sched-reschedule-clean-001__llm-v2__s') && !r.includes('c-scripted') &&
      loadTrace(r).events.filter((e) => e.type === 'tool_call' && e.tool === 'appointments.reschedule').length >= 4,
  );
  if (!id) throw new Error('no recorded v2 run exhibits the write loop');
  return id as string;
})();
const BASELINE_V1 = LOOPING_V2.replace('llm-v2', 'llm-v1');

let serverPort: number;
let baseUrl: string;

test('Full-Stack Server API Tests', async (t) => {
  // Start server on an ephemeral or dedicated port
  serverPort = await startServer(3099);
  baseUrl = `http://localhost:${serverPort}`;

  await t.test('GET /api/scenarios returns every scenario and policy', async () => {
    const res = await fetch(`${baseUrl}/api/scenarios`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.scenarios.length, loadScenarios().scenarios.length, 'derived, so adding a scenario extends the suite rather than failing a count');
    assert.ok(data.policies.length >= 6);
    assert.ok(data.available_agents.includes('llm:v1'));
    assert.ok(data.available_agents.includes('llm:v2'));
  });

  await t.test('GET /api/runs returns trace summaries and evaluation reports', async () => {
    const res = await fetch(`${baseUrl}/api/runs`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.runs));
    assert.ok(data.runs.length >= 18);

    const oracleRun = data.runs.find((r: any) => r.run_id === 'sched-reschedule-clean-001__stub-oracle__s0');
    assert.ok(oracleRun);
    assert.equal(oracleRun.overall_verdict, 'pass');
  });

  await t.test('GET /api/runs/:id returns full trace, scenario, and metrics breakdown', async () => {
    const runId = LOOPING_V2;
    const res = await fetch(`${baseUrl}/api/runs/${encodeURIComponent(runId)}`);
    assert.equal(res.status, 200);
    const data = await res.json();

    assert.equal(data.trace.run_id, runId);
    assert.equal(data.scenario.id, 'sched-reschedule-clean-001');
    assert.equal(data.report.overall_verdict, 'fail');

    // Confirm process metric failure is present in report
    const writesMetric = data.report.metrics.find((m: any) => m.metric === 'redundant_writes');
    assert.ok(writesMetric);
    assert.equal(writesMetric.verdict, 'fail');
    assert.match(writesMetric.details.message, /Oscillating write cycle detected/);
  });

  await t.test('POST /api/runs/:id/review persists human review and verdict override', async () => {
    const runId = LOOPING_V2;
    const reviewPayload = {
      reviewer: 'Clinical Lead Dr. Evans',
      verdict_override: 'fail',
      notes: 'Confirmed severe thrashing: agent looped 5 times on reschedule without communicating.',
      tags: ['thrashing', 'patient_abandonment'],
    };

    const postRes = await fetch(`${baseUrl}/api/runs/${encodeURIComponent(runId)}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reviewPayload),
    });
    assert.equal(postRes.status, 200);

    const saved = loadReview(runId);
    assert.ok(saved);
    assert.equal(saved.reviewer, reviewPayload.reviewer);
    assert.equal(saved.verdict_override, 'fail');

    // Clean up review file after test
    deleteReview(runId);
  });

  await t.test('GET /api/compare compares v1 vs v2 and highlights regressions', async () => {
    const runA = BASELINE_V1;
    const runB = LOOPING_V2;
    const res = await fetch(`${baseUrl}/api/compare?a=${encodeURIComponent(runA)}&b=${encodeURIComponent(runB)}`);
    assert.equal(res.status, 200);
    const comp = await res.json();

    assert.ok(comp.metricsDiff);
    const regressed = comp.metricsDiff.filter((m: any) => m.status === 'regressed');
    assert.ok(regressed.length >= 2, 'Expected regressions in redundant_writes, tool budget exhaustion, or state match');

    const writeDiff = comp.metricsDiff.find((m: any) => m.metric === 'redundant_writes');
    assert.ok(writeDiff);
    assert.equal(writeDiff.verdictA, 'pass');
    assert.equal(writeDiff.verdictB, 'fail');
    assert.equal(writeDiff.status, 'regressed');
  });

  await t.test('POST /api/runs triggers replay simulation and returns evaluated trace', async () => {
    const payload = {
      scenario_id: 'sched-reschedule-clean-001',
      agent_spec: 'stub:oracle',
      mode: 'replay',
      seed: 0,
    };

    const res = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    assert.equal(res.status, 201);
    const result = await res.json();
    assert.equal(result.success, true);
    assert.equal(result.run_id, 'sched-reschedule-clean-001__stub-oracle__s0');
    assert.equal(result.report.overall_verdict, 'pass');
  });

  // End process after tests
  process.exit(0);
});
