/**
 * Validates the scenario dataset. Run before any evaluation: a scenario that parses
 * but checks nothing reports PASS, and no downstream metric can detect that.
 */
import { loadScenarios, DatasetError } from '../lib/dataset/load.js';

try {
  const { scenarios, policies } = loadScenarios();
  console.log(`${scenarios.length} scenarios, ${policies.size} policies\n`);
  for (const s of scenarios) {
    const traps = s.tool_faults.map((f) => `${f.tool}:${f.mode}`).join(', ') || 'none';
    console.log(`  ${s.id}`);
    console.log(`    role=${s.role}  workflow=${s.workflow}  escalate=${s.expected_outcome.must_escalate}`);
    console.log(`    beats=${s.turn_plan.map((b) => b.kind).join(' -> ')}`);
    console.log(`    faults=${traps}`);
    console.log(`    entities=${Object.entries(s.expected_outcome.critical_entities).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    console.log(`    policies=${s.policy_refs.join(', ') || 'none'}`);
    console.log();
  }
  const unused = [...policies.keys()].filter((p) => !scenarios.some((s) => s.policy_refs.includes(p)));
  if (unused.length) console.log(`policies defined but not yet exercised: ${unused.join(', ')}`);
} catch (e) {
  console.error(e instanceof DatasetError ? `\n${e.message}\n` : e);
  process.exit(1);
}
