/**
 * Trace persistence.
 *
 * Files on disk, not a database (amendment to D1). Twenty to forty traces do not
 * justify a schema and a migration layer, and committed JSON is readable in the repo
 * diff — which is what the assignment asks for under "saved example outputs". The
 * property that mattered in D1 is unchanged: the harness and the app never call each
 * other, and the app renders artifacts that already exist.
 *
 * Reads are validated. A trace that has drifted from the schema — hand-edited, written
 * by an older build, truncated by a crashed run — must fail loudly rather than load
 * partially, because a half-parsed trace produces evaluations that look real.
 */
import { readFileSync, writeFileSync, readdirSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Trace } from '../types/trace.js';

export const TRACE_DIR = 'traces';

export class TraceStoreError extends Error {}

const fileFor = (dir: string, run_id: string) => join(dir, `${run_id}.json`);

/**
 * Write a trace. The run id already encodes (scenario, agent, seed), so re-running the
 * same configuration overwrites rather than accumulating near-duplicates.
 *
 * Written to a temp path and renamed, so an interrupted write cannot leave a truncated
 * file that later parses as a shorter, plausible-looking trace.
 */
export function saveTrace(trace: Trace, dir = TRACE_DIR): string {
  const parsed = Trace.safeParse(trace);
  if (!parsed.success) {
    throw new TraceStoreError(
      `refusing to save an invalid trace (${trace.run_id}): ` +
        parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = fileFor(dir, trace.run_id);
  const tmp = `${path}.tmp`;
  // Write the PARSED value, not the input. Zod rebuilds objects in schema key order,
  // so writing the raw object would mean save -> load -> save produces a different
  // file from the same trace: committed artefacts would churn in git on every reload
  // and no byte comparison would be trustworthy.
  writeFileSync(tmp, JSON.stringify(parsed.data, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
  return path;
}

export function loadTrace(run_id: string, dir = TRACE_DIR): Trace {
  const path = fileFor(dir, run_id);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new TraceStoreError(`no trace "${run_id}" in ${dir}/`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new TraceStoreError(`trace "${run_id}" is not valid JSON: ${(e as Error).message}`);
  }
  const parsed = Trace.safeParse(json);
  if (!parsed.success) {
    throw new TraceStoreError(
      `trace "${run_id}" does not match the schema — ` +
        parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
    );
  }
  return parsed.data;
}

export function listRunIds(dir = TRACE_DIR): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
}

/**
 * What the runs list needs without rendering a whole trace. Derived rather than stored:
 * a cached summary is one more thing that can disagree with the trace it summarises.
 */
export type TraceSummary = {
  run_id: string;
  scenario_id: string;
  agent_version: string;
  seed: number;
  mode: 'live' | 'replay';
  termination: Trace['termination'];
  turns: number;
  tool_calls: number;
  memory_writes: number;
  escalated: boolean;
  faults_fired: string[];
};

export function summarise(t: Trace): TraceSummary {
  const faults = new Set<string>();
  let turns = 0;
  let tool_calls = 0;
  let memory_writes = 0;
  for (const e of t.events) {
    if (e.type === 'caller_turn') turns++;
    else if (e.type === 'tool_call') tool_calls++;
    else if (e.type === 'memory_write') memory_writes++;
    else if (e.type === 'tool_result' && e.fault_applied) faults.add(e.fault_applied);
  }
  return {
    run_id: t.run_id,
    scenario_id: t.scenario_id,
    agent_version: t.agent_version,
    seed: t.seed,
    mode: t.mode,
    termination: t.termination,
    turns,
    tool_calls,
    memory_writes,
    escalated: t.final_state.escalations.length > 0,
    faults_fired: [...faults].sort(),
  };
}

export function loadAll(dir = TRACE_DIR): Trace[] {
  return listRunIds(dir).map((id) => loadTrace(id, dir));
}
