/**
 * Full-Stack Evaluation Server (Part 4).
 *
 * Provides:
 *   1. REST API for scenarios, policies, runs, comparisons, and human reviews
 *   2. Interactive evaluation execution (POST /api/runs)
 *   3. Static file server for the web inspector UI
 */
import { evaluatorContext } from '../eval/context.js';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { parse as parseUrl } from 'node:url';
import { loadEnv } from '../config/env.js';
loadEnv();

import { loadScenarios } from '../dataset/load.js';
import { assertRegistryComplete, evaluateTrace } from '../eval/registry.js';
import { listRunIds, loadTrace, saveTrace, summarise } from '../store/traces.js';
import { loadReview, saveReview, listReviews, type HumanReview } from '../store/reviews.js';
import { runScenario } from '../harness/orchestrator.js';
import { ScriptedCaller } from '../caller/scripted.js';
import { LlmCaller } from '../caller/llm.js';
import { resolveAgent, needsLlm, ALL_SPECS, STUB_KINDS } from '../agents/registry.js';
import { CachingClient, LlmRecorder, type LlmMode } from '../llm/client.js';
import { OpenAiClient } from '../llm/openai.js';
import type { EvaluationReport } from '../eval/types.js';

const EVAL_CTX = evaluatorContext();

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = join(process.cwd(), 'public');

// Initialize scenarios and policies with 3.0 Startup Registry Guard
const { scenarios, policies } = loadScenarios();
assertRegistryComplete(policies.values(), scenarios);

const scenarioMap = new Map(scenarios.map((s) => [s.id, s]));

// In-memory evaluation report cache
const reportCache = new Map<string, EvaluationReport>();

async function getOrComputeReport(runId: string): Promise<EvaluationReport | null> {
  if (reportCache.has(runId)) return reportCache.get(runId)!;
  try {
    const trace = loadTrace(runId);
    const scenario = scenarioMap.get(trace.scenario_id);
    if (!scenario) return null;
    const rep = await evaluateTrace(scenario, trace, policies, EVAL_CTX);
    reportCache.set(runId, rep);
    return rep;
  } catch {
    return null;
  }
}

function parseJsonBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 5 * 1024 * 1024) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : ({} as T));
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

function sendFile(res: ServerResponse, filePath: string, contentType: string) {
  try {
    const content = readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = createServer(async (req, res) => {
  const parsed = parseUrl(req.url || '/', true);
  const pathname = parsed.pathname || '/';
  const method = req.method || 'GET';

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // -------------------------------------------------------------------------
  // API Endpoints
  // -------------------------------------------------------------------------

  // GET /api/scenarios
  if (method === 'GET' && pathname === '/api/scenarios') {
    return sendJson(res, 200, {
      // The dataset is the part of this platform a reader most needs explained. A run
      // id names a scenario but cannot describe it, so the API carries the beats, the
      // injected faults, and the withheld facts — the things that make a run's verdict
      // interpretable by someone who did not write the scenario.
      scenarios: scenarios.map((s) => ({
        id: s.id,
        workflow: s.workflow,
        role: s.role,
        difficulty: s.difficulty,
        caller_goal: s.caller_goal,
        policy_refs: s.policy_refs,
        expected_outcome: s.expected_outcome,
        acceptable_variants: s.acceptable_variants,
        persona_facts: s.persona_facts,
        /** Withheld until the agent asks. Disclosed here because the reader is not the agent. */
        hidden_facts: s.hidden_facts,
        turn_plan: s.turn_plan,
        tool_faults: s.tool_faults,
        extends: s.extends ?? null,
        world_summary: {
          patients: s.world_state.patients.length,
          appointments: s.world_state.appointments.length,
          medications: s.world_state.medications.map((m) => m.name),
          pharmacies: s.world_state.pharmacies.map((p) => `${p.name} — ${p.address}`),
          availability: s.world_state.availability.map((a) => `${a.provider} ${a.start}`),
        },
      })),
      policies: Array.from(policies.values()),
      available_agents: ALL_SPECS,
    });
  }

  // GET /api/policies
  if (method === 'GET' && pathname === '/api/policies') {
    return sendJson(res, 200, Array.from(policies.values()));
  }

  // GET /api/runs
  if (method === 'GET' && pathname === '/api/runs') {
    const runIds = listRunIds();
    const reviews = listReviews();
    const runs = [];

    for (const id of runIds) {
      try {
        const trace = loadTrace(id);
        const rep = await getOrComputeReport(id);
        const summary = summarise(trace);
        const review = reviews.get(id) || null;

        // Apply verdict override if present
        const effectiveVerdict = review?.verdict_override ?? rep?.overall_verdict ?? 'unexercised';

        runs.push({
          run_id: id,
          scenario_id: trace.scenario_id,
          agent_version: trace.agent_version,
          seed: trace.seed,
          mode: trace.mode,
          termination: trace.termination,
          started_at: trace.started_at,
          ended_at: trace.ended_at,
          summary,
          overall_verdict: rep?.overall_verdict ?? 'fail',
          effective_verdict: effectiveVerdict,
          metrics_summary: rep
            ? {
                pass: rep.metrics.filter((m) => m.verdict === 'pass').length,
                fail: rep.metrics.filter((m) => m.verdict === 'fail').length,
                unexercised: rep.metrics.filter((m) => m.verdict === 'unexercised').length,
                critical_failures: rep.metrics.filter((m) => m.verdict === 'fail' && m.severity === 'critical').length,
                failure_messages: rep.metrics.filter((m) => m.verdict === 'fail').map((m) => m.details.message),
              }
            : null,
          has_review: !!review,
          review,
        });
      } catch (e) {
        // Skip corrupted run gracefully
      }
    }

    return sendJson(res, 200, { runs });
  }

  // GET /api/runs/:id
  if (method === 'GET' && pathname.startsWith('/api/runs/')) {
    const runId = pathname.slice('/api/runs/'.length);
    if (!runId) return sendJson(res, 400, { error: 'Missing run id' });

    try {
      const trace = loadTrace(runId);
      const scenario = scenarioMap.get(trace.scenario_id);
      const rep = await getOrComputeReport(runId);
      const review = loadReview(runId);

      return sendJson(res, 200, {
        trace,
        scenario,
        report: rep,
        review,
      });
    } catch (e) {
      return sendJson(res, 404, { error: `Run not found: ${(e as Error).message}` });
    }
  }

  // POST /api/runs - Trigger evaluation simulation
  if (method === 'POST' && pathname === '/api/runs') {
    try {
      const body = await parseJsonBody<{
        scenario_id: string;
        agent_spec: string;
        seed?: number;
        mode?: 'replay' | 'live';
      }>(req);

      if (!body.scenario_id || !scenarioMap.has(body.scenario_id)) {
        return sendJson(res, 400, { error: `Invalid or missing scenario_id: ${body.scenario_id}` });
      }
      if (!body.agent_spec || !ALL_SPECS.includes(body.agent_spec as never)) {
        return sendJson(res, 400, { error: `Invalid agent_spec: ${body.agent_spec}` });
      }

      const scenario = scenarioMap.get(body.scenario_id)!;
      const seed = typeof body.seed === 'number' ? body.seed : 0;
      const mode = body.mode ?? 'replay';

      const rec = new LlmRecorder();
      const provider = mode === 'live' ? new OpenAiClient() : undefined;
      const mk = () =>
        new CachingClient(
          provider ?? ({ async complete() { throw new Error('replay only'); } } as never),
          mode,
          undefined,
          rec.observe,
        );

      const caller = needsLlm(body.agent_spec) ? new LlmCaller(scenario, mk()) : new ScriptedCaller(scenario);
      const agent = resolveAgent(body.agent_spec, scenario.id, needsLlm(body.agent_spec) ? mk() : undefined);

      const trace = await runScenario(scenario, caller, agent, {
        seed,
        mode,
        llm: rec,
      });

      saveTrace(trace);
      reportCache.delete(trace.run_id);
      const report = await getOrComputeReport(trace.run_id);

      return sendJson(res, 201, {
        success: true,
        run_id: trace.run_id,
        trace,
        report,
      });
    } catch (err) {
      return sendJson(res, 500, { error: `Execution failed: ${(err as Error).message}` });
    }
  }

  // POST /api/runs/:id/review - Human Review / Verdict Override
  if (method === 'POST' && pathname.includes('/review')) {
    const parts = pathname.split('/');
    const runId = parts[3];
    if (!runId) return sendJson(res, 400, { error: 'Missing run id' });

    try {
      const body = await parseJsonBody<Partial<HumanReview>>(req);
      const review: HumanReview = {
        run_id: runId,
        reviewer: body.reviewer || 'Anonymous Reviewer',
        verdict_override: body.verdict_override ?? null,
        notes: body.notes || '',
        tags: Array.isArray(body.tags) ? body.tags : [],
        reviewed_at: Date.now(),
      };

      saveReview(review);
      return sendJson(res, 200, { success: true, review });
    } catch (err) {
      return sendJson(res, 500, { error: `Failed to save review: ${(err as Error).message}` });
    }
  }

  // GET /api/compare?a=:idA&b=:idB - Side-by-side comparison
  if (method === 'GET' && pathname === '/api/compare') {
    const idA = String(parsed.query.a || '');
    const idB = String(parsed.query.b || '');

    if (!idA || !idB) {
      return sendJson(res, 400, { error: 'Both query params "a" and "b" are required' });
    }

    try {
      const traceA = loadTrace(idA);
      const traceB = loadTrace(idB);
      const repA = await getOrComputeReport(idA);
      const repB = await getOrComputeReport(idB);

      // Diff metrics
      const metricsMap = new Map<string, { metric: string; repA?: any; repB?: any }>();
      for (const m of repA?.metrics ?? []) {
        metricsMap.set(m.metric, { metric: m.metric, repA: m });
      }
      for (const m of repB?.metrics ?? []) {
        const existing = metricsMap.get(m.metric) || { metric: m.metric };
        existing.repB = m;
        metricsMap.set(m.metric, existing);
      }

      const metricsDiff = Array.from(metricsMap.values()).map(({ metric, repA: a, repB: b }) => {
        const vA = a?.verdict ?? 'missing';
        const vB = b?.verdict ?? 'missing';
        let status: 'same' | 'regressed' | 'improved' = 'same';
        if (vA === 'pass' && vB === 'fail') status = 'regressed';
        else if (vA === 'fail' && vB === 'pass') status = 'improved';

        return {
          metric,
          category: a?.category || b?.category,
          severity: a?.severity || b?.severity,
          verdictA: vA,
          verdictB: vB,
          status,
          detailA: a?.details?.message,
          detailB: b?.details?.message,
        };
      });

      return sendJson(res, 200, {
        runA: { trace: traceA, report: repA, summary: summarise(traceA) },
        runB: { trace: traceB, report: repB, summary: summarise(traceB) },
        metricsDiff,
      });
    } catch (err) {
      return sendJson(res, 500, { error: `Comparison failed: ${(err as Error).message}` });
    }
  }

  // -------------------------------------------------------------------------
  // Static Assets Server
  // -------------------------------------------------------------------------
  let filePath = join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);

  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = join(PUBLIC_DIR, 'index.html');
  }

  if (existsSync(filePath)) {
    const ext = extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    return sendFile(res, filePath, contentType);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

export function startServer(port = PORT): Promise<number> {
  return new Promise((resolve) => {
    server.listen(port, () => {
      console.log(`\n🩺 Kyron Evaluation Platform UI listening at: http://localhost:${port}`);
      resolve(port);
    });
  });
}

// Automatically start if executed directly
if (process.argv[1]?.endsWith('server/index.ts') || process.argv[1]?.endsWith('server/index.js')) {
  startServer().catch((e) => {
    console.error('Failed to start server:', e);
    process.exit(1);
  });
}
