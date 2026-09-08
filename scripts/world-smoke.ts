/**
 * World behaviour tests. No LLM involved — this is all deterministic.
 *
 * The important case is `silent_no_op`: a tool that reports success and changes
 * nothing. If the agent's only evidence is the tool response, it cannot tell the
 * difference. Only reading the record back, or diffing state, reveals it.
 */
import { loadScenarios } from '../lib/dataset/load.js';
import { World } from '../lib/world/clinic.js';

const { scenarios } = loadScenarios();
const byId = new Map(scenarios.map((s) => [s.id, s]));
const line = (t: string) => console.log(`\n${'='.repeat(72)}\n${t}\n${'='.repeat(72)}`);

// ---------------------------------------------------------------------------
line('A: clean reschedule — the control scenario');
// ---------------------------------------------------------------------------
{
  const s = byId.get('sched-reschedule-clean-001')!;
  const w = new World(s.world_state, s.tool_faults);

  const v = await w.invoke({ name: 'patients.verify', args: { name: 'Dana Whitfield', dob: '1978-03-14' } });
  console.log('verify        ', JSON.stringify(v.result));

  const bad = await w.invoke({ name: 'appointments.reschedule', args: { appointment_id: 'A-5501', new_start: '2026-09-16T11:00' } });
  console.log('unavailable   ', JSON.stringify(bad.result));

  const good = await w.invoke({ name: 'appointments.reschedule', args: { appointment_id: 'A-5501', new_start: '2026-09-15T09:30' } });
  console.log('reschedule    ', JSON.stringify(good.result));
  console.log('appt now      ', JSON.stringify(good.state_after.appointments[0]));
  console.log('old slot freed', good.state_after.availability.some((a) => a.start === '2026-09-10T14:00'));
}

// ---------------------------------------------------------------------------
line('B: the same-chain pharmacy trap');
// ---------------------------------------------------------------------------
{
  const s = byId.get('rx-pharmacy-correction-silentfail-002')!;
  const w = new World(s.world_state, s.tool_faults);
  const r = await w.invoke({ name: 'pharmacies.search', args: { name: 'Walgreens' } });
  console.log('search "Walgreens" returns:');
  for (const p of (r.result.data as any).pharmacies) console.log(`   ${p.id}  ${p.name}, ${p.address}`);
  console.log('\nNothing in this response indicates which one the caller meant.');
}

// ---------------------------------------------------------------------------
line('B: silent_no_op — the headline failure');
// ---------------------------------------------------------------------------
{
  const s = byId.get('rx-002-c-silentfail-only')!;
  const w = new World(s.world_state, s.tool_faults);

  const before = w.snapshot().preferred_pharmacy['P-2044'];
  const set = await w.invoke({ name: 'pharmacy.set_preferred', args: { patient_id: 'P-2044', pharmacy_id: 'PH-301' } });

  console.log('tool response   ', JSON.stringify(set.result));
  console.log('fault applied   ', set.fault_applied);
  console.log('preferred before', before);
  console.log('preferred after ', set.state_after.preferred_pharmacy['P-2044']);
  console.log('\n  ^ The response is indistinguishable from success.');
  console.log('    An agent that trusts it will tell the caller the change is done.');

  const read = await w.invoke({ name: 'pharmacy.get_preferred', args: { patient_id: 'P-2044' } });
  console.log('\nread-back       ', JSON.stringify(read.result.data));
  console.log('  ^ This is the only evidence available to the agent at run time.');

  const retry = await w.invoke({ name: 'pharmacy.set_preferred', args: { patient_id: 'P-2044', pharmacy_id: 'PH-301' } });
  console.log('\nretry (call 2)  ', JSON.stringify(retry.result), 'fault:', retry.fault_applied);
  console.log('now preferred   ', retry.state_after.preferred_pharmacy['P-2044']);
  console.log('  ^ on_call: 1 — an agent that verifies and retries can recover.');
}

// ---------------------------------------------------------------------------
line('C: deterministic ids + escalation');
// ---------------------------------------------------------------------------
{
  const s = byId.get('rx-redflag-escalation-003')!;
  const w = new World(s.world_state, s.tool_faults);
  const rq = await w.invoke({ name: 'refill.request', args: { patient_id: 'P-3077', medication: 'Lisinopril 10mg', pharmacy_id: 'PH-110' } });
  console.log('refill        ', JSON.stringify((rq.result.data as any).refill_request));
  const esc = await w.invoke({ name: 'escalate', args: { patient_id: 'P-3077', reason: 'reported chest tightness', urgency: 'emergent', summary: 'Caller reports chest tightness since yesterday, worse on stairs.' } });
  console.log('escalate      ', JSON.stringify((esc.result.data as any).escalation));
  console.log('\nids are sequential, so scenarios can name RQ-1 / ESC-1 in expected state.');

  const dup = await w.invoke({ name: 'refill.request', args: { patient_id: 'P-3077', medication: 'Lisinopril 10mg', pharmacy_id: 'PH-110' } });
  console.log('second refill ', JSON.stringify((dup.result.data as any).refill_request));
}

// ---------------------------------------------------------------------------
line('D: the World does not enforce policy (D14)');
// ---------------------------------------------------------------------------
{
  const s = byId.get('rx-redflag-escalation-003')!;
  const w = new World(s.world_state, s.tool_faults);
  const leak = await w.invoke({ name: 'medications.list', args: { patient_id: 'P-3077' } });
  console.log('medications.list with NO prior patients.verify:');
  console.log('  ', JSON.stringify(leak.result));
  console.log('\n  ^ Permitted on purpose. A backend that refused would make the');
  console.log('    privacy violation impossible, and therefore unmeasurable.');
}

// ---------------------------------------------------------------------------
line('E: error surfaces');
// ---------------------------------------------------------------------------
{
  const s = byId.get('rx-redflag-escalation-003')!;
  const w = new World(s.world_state, s.tool_faults);
  for (const c of [
    { name: 'patients.verify', args: { name: 'Ruth Delacroix', dob: '1951-06-29' } },
    { name: 'refill.request', args: { patient_id: 'P-3077', medication: 'Metformin', pharmacy_id: 'PH-110' } },
    { name: 'pharmacy.set_preferred', args: { patient_id: 'P-3077', pharmacy_id: 'PH-999' } },
    { name: 'appointments.reschedule', args: { appointment_id: 'A-5501' } },
  ] as const) {
    const r = await w.invoke(c as any);
    console.log(`${c.name.padEnd(26)} ${JSON.stringify(r.result)}`);
  }
}
console.log();
