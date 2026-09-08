/** Ad-hoc semantic audit: are these scenarios actually satisfiable? */
import { loadScenarios } from '../lib/dataset/load.js';
const { scenarios } = loadScenarios();
let problems = 0;
const bad = (id: string, m: string) => { problems++; console.log(`  ✗ ${id}: ${m}`); };

for (const s of scenarios) {
  const w = s.world_state;
  const ids = new Set([
    ...w.patients.map(p => p.id), ...w.appointments.map(a => a.id),
    ...w.pharmacies.map(p => p.id), ...w.medications.map(m => m.name),
  ]);

  // 1. reveal_if_asked.fact must exist in hidden_facts
  for (const b of s.turn_plan) {
    if (b.kind === 'reveal_if_asked' && !(b.fact in s.hidden_facts)) {
      bad(s.id, `reveal_if_asked.fact "${b.fact}" not in hidden_facts [${Object.keys(s.hidden_facts)}]`);
    }
  }

  // 2. critical_entities values that look like world ids must exist
  for (const [k, v] of Object.entries(s.expected_outcome.critical_entities)) {
    const sv = String(v);
    if (/^(P|A|PH|RQ|ESC)-\d+$/.test(sv) && !ids.has(sv) && !/^(RQ|ESC)-/.test(sv)) {
      bad(s.id, `critical_entities.${k} = "${sv}" does not exist in world_state`);
    }
    if (k === 'medication' && !w.medications.some(m => m.name === sv)) {
      bad(s.id, `critical_entities.medication "${sv}" not in world_state.medications`);
    }
  }

  // 3. an expected new_start must be a real availability slot
  const ns = s.expected_outcome.critical_entities['new_start'];
  if (ns && !w.availability.some(a => a.start === ns)) {
    bad(s.id, `expected new_start "${ns}" is not in world_state.availability — unwinnable`);
  }
  for (const v of s.acceptable_variants) {
    const vs = v.critical_entities?.['new_start'];
    if (vs && !w.availability.some(a => a.start === vs)) bad(s.id, `variant new_start "${vs}" not available`);
  }

  // 4. choose_offer reject terms must actually match something offered
  for (const b of s.turn_plan) {
    if (b.kind === 'choose_offer') {
      for (const r of b.reject) {
        if (r === 'monday') {
          const hasMon = w.availability.some(a => new Date(a.start + ':00').getDay() === 1);
          if (!hasMon) bad(s.id, `choose_offer rejects "monday" but no Monday slot exists — the distractor is absent`);
        }
      }
    }
  }

  // 5. summary_must_mention terms should appear somewhere in the scenario text
  const blob = JSON.stringify(s).toLowerCase();
  for (const t of s.expected_outcome.escalation?.summary_must_mention ?? []) {
    if (!blob.includes(t.toLowerCase())) bad(s.id, `summary_must_mention "${t}" appears nowhere in the scenario`);
  }

  // 6. expected final_state pharmacy ids must exist
  for (const [pat, ph] of Object.entries(s.expected_outcome.final_state?.preferred_pharmacy ?? {})) {
    if (!w.pharmacies.some(p => p.id === ph)) bad(s.id, `expected preferred_pharmacy ${ph} not in world_state`);
    if (!w.patients.some(p => p.id === pat)) bad(s.id, `expected preferred_pharmacy key ${pat} is not a patient`);
  }
  for (const r of s.expected_outcome.final_state?.refill_requests ?? []) {
    if (r.pharmacy_id && !w.pharmacies.some(p => p.id === r.pharmacy_id)) bad(s.id, `expected refill pharmacy ${r.pharmacy_id} missing`);
    if (r.medication && !w.medications.some(m => m.name === r.medication)) bad(s.id, `expected refill medication "${r.medication}" missing`);
  }

  // 7. faulted tools must be ones the scenario could plausibly reach
  for (const f of s.tool_faults) {
    if (f.tool === 'pharmacy.set_preferred' && w.pharmacies.length === 0) bad(s.id, `fault on ${f.tool} but no pharmacies`);
  }
}
console.log(problems === 0 ? '\n  no semantic problems found' : `\n  ${problems} problem(s)`);
