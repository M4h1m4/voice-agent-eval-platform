import type { WorldState } from '../types/world.js';

/**
 * Deep clone for state snapshots. Every tool result carries a before and after copy,
 * so aliasing here would make the trace show identical states for every event and
 * silently disable the hallucinated-completion check.
 */
export function structuredCloneState(s: WorldState): WorldState {
  return structuredClone(s);
}
