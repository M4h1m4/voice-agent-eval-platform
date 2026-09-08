/**
 * Tool definitions handed to the model, derived from the same zod schemas the World
 * validates against.
 *
 * Derived, not hand-written. A second copy of each schema would drift from the first,
 * and the failure would be quiet: the model would be told a tool takes arguments the
 * World rejects, every call would come back invalid, and the run would look like an
 * incompetent agent rather than a broken definition.
 */
import { zodToJsonSchema } from 'zod-to-json-schema';
import { TOOL_ARGS, ToolName } from '../types/tools.js';
import type { LlmToolDef } from '../llm/types.js';

/**
 * OpenAI function names must match /^[a-zA-Z0-9_-]{1,64}$/ — our dotted names are not
 * legal. `__` is the separator because a single underscore would be ambiguous to
 * decode (`pharmacy.get_preferred` and `pharmacy_get.preferred` would collide).
 */
export const toWireName = (name: string) => name.replace(/\./g, '__');
export const fromWireName = (wire: string) => wire.replace(/__/g, '.');

const DESCRIPTIONS: Record<ToolName, string> = {
  'patients.verify': 'Confirm a caller identity from name and date of birth. Returns their patient id.',
  'appointments.list': 'List a patient\'s booked appointments.',
  'availability.search': 'Find open appointment slots for a provider.',
  'appointments.reschedule': 'Move a booked appointment to a different open slot.',
  'appointments.cancel': 'Cancel a booked appointment.',
  'medications.list': 'List the medications on file for a patient, with refills remaining.',
  'pharmacies.search': 'Look up pharmacies. Searching by chain name may return several locations.',
  'pharmacy.get_preferred': 'Read back which pharmacy is currently set for a patient.',
  'pharmacy.set_preferred': 'Set a patient\'s preferred pharmacy.',
  'refill.request': 'Submit a prescription refill to a pharmacy.',
  'escalate': 'Hand the call to a human staff member. Include a summary they can act on.',
  'memory.write': 'Record a fact you have established, so it survives the rest of the call. Overwrite the same key when a caller corrects you.',
};

export function toolDefinitions(): LlmToolDef[] {
  return ToolName.options.map((name) => ({
    name: toWireName(name),
    description: DESCRIPTIONS[name],
    parameters: zodToJsonSchema(TOOL_ARGS[name], { target: 'openApi3' }) as Record<string, unknown>,
  }));
}
