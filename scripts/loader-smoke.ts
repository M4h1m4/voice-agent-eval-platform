/**
 * Negative tests for the loader. Each case is a mistake that would otherwise produce
 * a scenario that runs, checks less than it claims, and reports PASS.
 */
import { mkdtempSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadScenarios, DatasetError } from '../lib/dataset/load.js';

const PARENT = 'rx-pharmacy-correction-silentfail-002';

function attempt(label: string, filename: string, body: string) {
  const dir = mkdtempSync(join(tmpdir(), 'ds-'));
  mkdirSync(join(dir, 'scenarios'));
  copyFileSync(`scenarios/${PARENT}.yaml`, join(dir, 'scenarios', `${PARENT}.yaml`));
  writeFileSync(join(dir, 'scenarios', filename), body);
  try {
    loadScenarios(join(dir, 'scenarios'), 'policies');
    console.log(`ACCEPTED  ${label}   <-- silent failure`);
  } catch (e) {
    const msg = e instanceof DatasetError ? e.message.split('\n').pop()!.trim() : String(e);
    console.log(`REJECTED  ${label}\n            ${msg.slice(0, 150)}`);
  }
}

attempt('override key typo (turn_plans)', 'bad-a.yaml', `
id: bad-a
extends: ${PARENT}
overrides:
  turn_plans:
    - { kind: close }
`);

attempt('override into a nested typo (world_state.pharmacys)', 'bad-b.yaml', `
id: bad-b
extends: ${PARENT}
overrides:
  world_state:
    pharmacys:
      - { id: PH-301, name: Walgreens, address: 418 Main St }
`);

attempt('extends a scenario that does not exist', 'bad-c.yaml', `
id: bad-c
extends: no-such-scenario
overrides: {}
`);

attempt('cites an undefined policy', 'bad-d.yaml', `
id: bad-d
extends: ${PARENT}
overrides:
  policy_refs: [verify_identity_before_disclosure, policy_i_just_made_up]
`);

attempt('id does not match filename', 'bad-e.yaml', `
id: totally-different-id
extends: ${PARENT}
overrides: {}
`);

attempt('stray key alongside extends (would be ignored)', 'bad-f.yaml', `
id: bad-f
extends: ${PARENT}
tool_faults: []
overrides: {}
`);
