import { test } from 'node:test';
import assert from 'node:assert/strict';
import { perturb, faultForBeat } from '../../lib/caller/asr.js';
import { Scenario } from '../../lib/types/scenario.js';
import { loadScenarios } from '../../lib/dataset/load.js';

test('an explicit from -> to overrides the built-in tables', () => {
  // Lets a dataset author target the exact entity a scenario is about rather than
  // hoping a confusion table happens to match.
  assert.equal(
    perturb('I need my levothyroxine refilled', 'asr_substitution', 'levothyroxine -> levothyroxin'),
    'I need my levothyroxin refilled',
  );
});

test('a fault that does not apply leaves the words untouched', () => {
  // Returning the original would hide the fact that nothing happened; null lets the
  // orchestrator record no corruption at all.
  assert.equal(perturb('I need my aspirin', 'asr_substitution', 'levothyroxine -> levothyroxin'), null);
  assert.equal(perturb('nothing to confuse here', 'asr_digit_error'), null);
});

test('built-in confusions swap one real drug for another, not for a misspelling', () => {
  // The table originally held misspellings (levothyroxine -> levothyroxin), which any
  // fuzzy match recovers. Real ASR drug confusion is between different real drugs.
  assert.match(String(perturb('refill my hydralazine please', 'asr_substitution')), /hydroxyzine/);
  assert.match(String(perturb('my metformin', 'asr_substitution')), /metronidazole/);
  assert.match(String(perturb('my prednisone', 'asr_substitution')), /prednisolone/);
});

test('digit confusion produces a checkable error, not an unguessable one', () => {
  // "the fiftieth" is an impossible date. An agent that proceeds anyway failed a test
  // it had every means to pass — which is the bar for a fair fault.
  assert.equal(perturb('can I come on the fifteenth', 'asr_digit_error'), 'can I come on the fiftieth');
});

test('dropout removes an interior word, never the first or last', () => {
  const input = 'I would like to move my appointment please';
  const out = perturb(input, 'asr_dropout')!;
  assert.ok(out.startsWith('I'), 'the opening survives');
  assert.ok(out.endsWith('please'), 'the ending survives');
  assert.equal(out.split(' ').length, input.split(' ').length - 1, 'exactly one word is lost');
});

test('dropout declines to mangle a short utterance', () => {
  assert.equal(perturb('yes please', 'asr_dropout'), null);
});

test('faults are matched to the beat they target', () => {
  const faults = [{ mode: 'asr_substitution' as const, at_beat: 2 }];
  assert.equal(faultForBeat(faults, 0), undefined);
  assert.equal(faultForBeat(faults, 2)?.mode, 'asr_substitution');
});

test('a caller fault aimed at a beat that does not exist is rejected at load time', () => {
  const { scenarios } = loadScenarios();
  const base = scenarios.find((s) => s.id === 'rx-002-d-asr-drugname')!;
  const bad = { ...base, caller_faults: [{ mode: 'asr_substitution', at_beat: 99 }] };
  const r = Scenario.safeParse(bad);
  assert.equal(r.success, false);
  assert.match(String(r.success === false && r.error.issues[0]!.message), /does not exist/);
});

test('scenarios without caller faults default to none', () => {
  const { scenarios } = loadScenarios();
  assert.deepEqual(scenarios.find((s) => s.id === 'sched-reschedule-clean-001')!.caller_faults, []);
});
