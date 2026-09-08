/**
 * Generates the committed sample traces: every scenario against every stub agent.
 *
 * These are the artefacts that let the application be reviewed with no API key and no
 * live run — the reviewer clones, installs, and every screen is populated.
 */
import { runScenario } from '../lib/harness/orchestrator.js';
import { ScriptedCaller } from '../lib/caller/scripted.js';
import { stubAgent, type StubKind } from '../lib/agents/scripted.js';
import { loadScenarios } from '../lib/dataset/load.js';
import { saveTrace, summarise, TRACE_DIR } from '../lib/store/traces.js';

const KINDS: StubKind[] = ['oracle', 'naive', 'panicky'];
const { scenarios } = loadScenarios();

console.log(`writing ${scenarios.length * KINDS.length} traces to ${TRACE_DIR}/\n`);
console.log(
  `${'run'.padEnd(52)} ${'termination'.padEnd(14)} turns tools mem  esc  faults`,
);
console.log('-'.repeat(104));

for (const s of scenarios) {
  for (const kind of KINDS) {
    const trace = await runScenario(s, new ScriptedCaller(s), stubAgent(s.id, kind), { seed: 0 });
    saveTrace(trace);
    const x = summarise(trace);
    console.log(
      `${x.run_id.padEnd(52)} ${x.termination.padEnd(14)} ${String(x.turns).padStart(5)} ` +
        `${String(x.tool_calls).padStart(5)} ${String(x.memory_writes).padStart(3)} ` +
        `${(x.escalated ? 'yes' : 'no').padStart(4)}  ${x.faults_fired.join(',') || '-'}`,
    );
  }
}
console.log();
