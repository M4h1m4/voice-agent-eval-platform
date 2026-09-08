/**
 * Compares a scenario's declared `expected_outcome.final_state` against the world the
 * run actually produced.
 *
 * Subset semantics: a scenario declares only the fields that must hold, and each
 * declared element must find *some* actual record matching all of them. Scenarios
 * cannot predict agent-authored free text (an escalation's `reason`), nor should they
 * have to restate every column of a row to assert one of them.
 *
 * The empty-expectation case is guarded in the schema, not here — an expectation that
 * declares nothing would be satisfied by anything, which is the failure this whole
 * layer exists to prevent.
 */
import type { WorldState } from '../types/world.js';

export type Mismatch = { path: string; expected: unknown; actual: unknown; note: string };

type Rec = Record<string, unknown>;

const subsetOf = (want: Rec, got: Rec) =>
  Object.entries(want).every(([k, v]) => JSON.stringify(got[k]) === JSON.stringify(v));

/** Collections compared element-wise by subset match. */
const COLLECTIONS = [
  'patients',
  'appointments',
  'availability',
  'medications',
  'pharmacies',
  'refill_requests',
  'escalations',
] as const;

export function matchFinalState(
  expected: Record<string, unknown> | undefined,
  actual: WorldState,
): Mismatch[] {
  if (!expected) return [];
  const out: Mismatch[] = [];

  for (const key of COLLECTIONS) {
    const want = expected[key] as Rec[] | undefined;
    if (!want) continue;
    const got = (actual[key] ?? []) as unknown as Rec[];
    want.forEach((w, i) => {
      if (!got.some((g) => subsetOf(w, g))) {
        out.push({
          path: `${key}[${i}]`,
          expected: w,
          actual: got,
          note: `no ${key.replace(/s$/, '')} matches every declared field`,
        });
      }
    });
  }

  const wantPref = expected['preferred_pharmacy'] as Record<string, string> | undefined;
  if (wantPref) {
    for (const [patient, pharmacy] of Object.entries(wantPref)) {
      const got = actual.preferred_pharmacy[patient];
      if (got !== pharmacy) {
        out.push({
          path: `preferred_pharmacy.${patient}`,
          expected: pharmacy,
          actual: got ?? null,
          note: got ? 'set to a different pharmacy' : 'never set',
        });
      }
    }
  }

  return out;
}
