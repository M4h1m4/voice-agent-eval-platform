import { loadTrace } from '../lib/store/traces.js';
import { loadScenarios } from '../lib/dataset/load.js';
const { scenarios } = loadScenarios();
for (const s of scenarios) {
  console.log(`\n${'='.repeat(94)}\n${s.id}`);
  for (const v of ['llm-v1', 'llm-v2']) {
    const t = loadTrace(`${s.id}__${v}__s0`);
    const seq = t.events.filter(e => e.type === 'tool_call').map(e => e.tool);
    console.log(`  ${v}  ${t.termination}`);
    console.log(`         ${seq.join(' -> ') || '(none)'}`);
    const last = t.events.filter(e => e.type === 'agent_message').at(-1);
    console.log(`         closing: "${(last?.text ?? '(silence)').slice(0, 88)}"`);
    const err = t.events.find(e => e.type === 'error');
    if (err) console.log(`         ERROR: ${err.message.slice(0, 80)}`);
  }
}
