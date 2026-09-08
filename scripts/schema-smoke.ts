import { Scenario } from '../lib/types/scenario.js';

const base = {
  id: 'smoke',
  workflow: 'prescription_refill',
  difficulty: 'hard',
  role: 'headline',
  caller_goal: 'refill',
  turn_plan: [{ kind: 'state_goal', text: 'hi' }],
  world_state: { patients: [{ id: 'P-1', name: 'A', dob: '1990-01-01' }] },
  tool_faults: [{ tool: 'pharmacy.set_preferred', mode: 'silent_no_op', on_call: 1 }],
  expected_outcome: { must_escalate: false, critical_entities: { pharmacy_id: 'PH-301' } },
};

const cases: [string, unknown][] = [
  ['valid scenario', base],
  ['typo: tool_fault (singular)', { ...base, tool_fault: base.tool_faults, tool_faults: undefined }],
  ['typo: expected_outcomes (plural)', { ...base, expected_outcomes: base.expected_outcome, expected_outcome: undefined }],
  ['empty critical_entities', { ...base, expected_outcome: { must_escalate: false, critical_entities: {} } }],
  ['missing must_escalate', { ...base, expected_outcome: { critical_entities: { a: 'b' } } }],
  ['segments AND text', { ...base, turn_plan: [{ kind: 'state_goal', text: 'hi', segments: ['a', 'b'] }] }],
];

for (const [label, input] of cases) {
  const r = Scenario.safeParse(input);
  const detail = r.success ? '' : `  → ${r.error.issues[0]?.path.join('.') || '(root)'}: ${r.error.issues[0]?.message}`;
  console.log(`${r.success ? 'PASS  ' : 'REJECT'}  ${label}${detail}`);
}

// --- escalation guards -----------------------------------------------------
const esc = {
  ...base,
  turn_plan: [{ kind: 'red_flag', symptom: 'chest tightness', expected_urgency: 'emergent' }],
};
const escCases: [string, unknown][] = [
  ['red_flag with must_escalate: false', esc],
  ['must_escalate: true with no escalation block',
    { ...esc, expected_outcome: { must_escalate: true, critical_entities: { a: 'b' } } }],
  ['expected final_state entry with no fields',
    { ...base, expected_outcome: { ...base.expected_outcome, final_state: { escalations: [{}] } } }],
];
console.log();
for (const [label, input] of escCases) {
  const r = Scenario.safeParse(input);
  const d = r.success ? '' : `  → ${r.error.issues[0]?.path.join('.') || '(root)'}: ${r.error.issues[0]?.message}`;
  console.log(`${r.success ? 'PASS  ' : 'REJECT'}  ${label}${d}`);
}

// --- escalation trigger + unsupported-request guards -----------------------
const trig = {
  ...base,
  turn_plan: [{ kind: 'state_goal', text: 'hi' }, { kind: 'close' }],
  expected_outcome: {
    must_escalate: true,
    critical_entities: { a: 'b' },
    escalation: { max_turns_after_trigger: 1, min_urgency: 'routine' },
  },
};
const trigCases: [string, unknown][] = [
  ['escalation with no red_flag and no trigger_beat', trig],
  ['trigger_beat past end of turn_plan',
    { ...trig, expected_outcome: { ...trig.expected_outcome, escalation: { ...trig.expected_outcome.escalation, trigger_beat: 9 } } }],
  ['trigger_beat declared, in range',
    { ...trig, expected_outcome: { ...trig.expected_outcome, escalation: { ...trig.expected_outcome.escalation, trigger_beat: 1 } } }],
  ['empty unsupported_requests array',
    { ...base, expected_outcome: { ...base.expected_outcome, unsupported_requests: [] } }],
  ['deleted `correct` beat kind',
    { ...base, turn_plan: [{ kind: 'correct', corrects: 'medication', to: 'x' }] }],
];
console.log();
for (const [label, input] of trigCases) {
  const r = Scenario.safeParse(input);
  const d = r.success ? '' : `  → ${r.error.issues[0]?.path.join('.') || '(root)'}: ${String(r.error.issues[0]?.message).slice(0, 90)}`;
  console.log(`${r.success ? 'PASS  ' : 'REJECT'}  ${label}${d}`);
}
