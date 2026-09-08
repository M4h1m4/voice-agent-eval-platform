/**
 * The mock clinic — the ground-truth surface.
 *
 * Two properties this file exists to hold:
 *
 * 1. **It does not enforce policy.** The World will happily disclose a medication list
 *    to an unverified caller, because a permissive backend is the only way a policy
 *    violation can occur and therefore be measured. An API that made violations
 *    impossible would leave the evaluator with nothing to detect. Policies are
 *    evaluated, never enforced (D14).
 *
 * 2. **Generated ids are deterministic and sequential** (`RQ-1`, `ESC-1`), because
 *    scenarios declare expected final state that references them. UUIDs would make
 *    state comparison impossible to express.
 */
import { structuredCloneState } from './clone.js';
import type { WorldState } from '../types/world.js';
import type { ToolCall, ToolResult, ToolName } from '../types/tools.js';
import { parseToolArgs, ToolName as ToolNameEnum } from '../types/tools.js';

const KNOWN_TOOLS = new Set<string>(ToolNameEnum.options);
import type { ToolFault } from '../types/scenario.js';

export class WorldError extends Error {}

export type InvokeOutcome = {
  result: ToolResult;
  state_before: WorldState;
  state_after: WorldState;
  fault_applied: string | null;
};

const ok = (data?: unknown): ToolResult => ({ ok: true, ...(data === undefined ? {} : { data }) });
const err = (error: string): ToolResult => ({ ok: false, error });

export class World {
  private state: WorldState;
  private readonly faults: ToolFault[];
  private readonly callCounts = new Map<ToolName, number>();
  private readonly counters = new Map<string, number>();

  constructor(initial: WorldState, faults: ToolFault[] = []) {
    // Fail at construction rather than mid-run: a fault mode the World cannot apply
    // would otherwise leave the scenario silently testing nothing.
    const unsupported = faults.filter((f) => f.mode === 'partial_write');
    if (unsupported.length) {
      throw new WorldError(
        `fault mode "partial_write" is declared by ${unsupported
          .map((f) => f.tool)
          .join(', ')} but not implemented — implement it or remove it from the scenario`,
      );
    }
    this.state = structuredCloneState(initial);
    this.faults = faults;
  }

  snapshot(): WorldState {
    return structuredCloneState(this.state);
  }

  private nextId(prefix: string): string {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}-${n}`;
  }

  /** The fault that applies to this invocation, if any. */
  private matchFault(tool: ToolName): ToolFault | undefined {
    const n = (this.callCounts.get(tool) ?? 0) + 1;
    this.callCounts.set(tool, n);
    return this.faults.find((f) => f.tool === tool && (f.on_call === undefined || f.on_call === n));
  }

  async invoke(call: ToolCall): Promise<InvokeOutcome> {
    const state_before = this.snapshot();

    if (call.name === 'memory.write') {
      throw new WorldError(
        'memory.write is agent state, not clinic state — the orchestrator intercepts it',
      );
    }

    // A real LLM agent will eventually invent a tool that does not exist. That is a
    // genuine production failure — hallucinated capability, arriving through the tool
    // channel instead of the transcript — so it must come back as an error the agent
    // can see and the trace can record. Crashing here would destroy the evidence.
    if (!KNOWN_TOOLS.has(call.name)) {
      return {
        result: err(`unknown tool "${call.name}"`),
        state_before,
        state_after: state_before,
        fault_applied: null,
      };
    }

    const parsed = parseToolArgs(call.name, call.args);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return {
        result: err(`invalid arguments: ${detail}`),
        state_before,
        state_after: state_before,
        fault_applied: null,
      };
    }

    const fault = this.matchFault(call.name);

    // Faults that short-circuit before any handler runs.
    if (fault?.mode === 'error_500') {
      return {
        result: err('HTTP 500: upstream service error'),
        state_before,
        state_after: state_before,
        fault_applied: 'error_500',
      };
    }
    if (fault?.mode === 'timeout') {
      return {
        result: err('request timed out after 30000ms'),
        state_before,
        state_after: state_before,
        fault_applied: 'timeout',
      };
    }

    /**
     * `silent_no_op`: run the handler against a throwaway copy so the response is
     * byte-for-byte the one a real success would produce, then discard every mutation.
     * The agent has no way to distinguish this from success — which is the point. It
     * is detectable only by reading the record back, or by comparing state afterwards.
     */
    if (fault?.mode === 'silent_no_op') {
      const scratch = structuredCloneState(this.state);
      const result = this.dispatch(call.name, parsed.data, scratch);
      return { result, state_before, state_after: state_before, fault_applied: 'silent_no_op' };
    }

    const result = this.dispatch(call.name, parsed.data, this.state);
    const state_after = this.snapshot();

    /** The write lands; the response is unreadable. Tests error handling, not honesty. */
    if (fault?.mode === 'malformed_response') {
      return {
        result: { ok: true, data: null },
        state_before,
        state_after,
        fault_applied: 'malformed_response',
      };
    }

    return { result, state_before, state_after, fault_applied: null };
  }

  // -------------------------------------------------------------------------
  // Handlers. Each mutates the `s` it is handed, never `this.state` directly, so
  // `silent_no_op` can run them against a scratch copy.
  // -------------------------------------------------------------------------

  private dispatch(name: ToolName, args: any, s: WorldState): ToolResult {
    switch (name) {
      case 'patients.verify': {
        const p = s.patients.find(
          (x) => x.name.toLowerCase() === String(args.name).toLowerCase() && x.dob === args.dob,
        );
        return p
          ? ok({ patient_id: p.id, name: p.name, verified: true })
          : err('no patient matches that name and date of birth');
      }

      case 'appointments.list': {
        const rows = s.appointments.filter(
          (a) => a.patient === args.patient_id && a.status === 'booked',
        );
        return ok({ appointments: rows });
      }

      case 'availability.search': {
        const rows = s.availability
          .filter((v) => v.provider === args.provider)
          .filter((v) => (args.after ? v.start >= args.after : true))
          .filter((v) => (args.before ? v.start <= args.before : true));
        return ok({ slots: rows });
      }

      case 'appointments.reschedule': {
        const appt = s.appointments.find((a) => a.id === args.appointment_id);
        if (!appt) return err(`no appointment ${args.appointment_id}`);
        if (appt.status !== 'booked') return err(`appointment ${appt.id} is ${appt.status}`);
        const slotIdx = s.availability.findIndex(
          (v) => v.provider === appt.provider && v.start === args.new_start,
        );
        if (slotIdx === -1) {
          return err(`${args.new_start} is not an available slot for ${appt.provider}`);
        }
        const released = appt.start;
        s.availability.splice(slotIdx, 1);
        s.availability.push({ provider: appt.provider, start: released });
        s.availability.sort((a, b) => a.start.localeCompare(b.start));
        appt.start = args.new_start;
        return ok({ appointment: { ...appt } });
      }

      case 'appointments.cancel': {
        const appt = s.appointments.find((a) => a.id === args.appointment_id);
        if (!appt) return err(`no appointment ${args.appointment_id}`);
        appt.status = 'cancelled';
        s.availability.push({ provider: appt.provider, start: appt.start });
        return ok({ appointment: { ...appt } });
      }

      case 'medications.list': {
        return ok({ medications: s.medications.filter((m) => m.patient === args.patient_id) });
      }

      case 'pharmacies.search': {
        const q = args.name ? String(args.name).toLowerCase() : null;
        // Returns every match. Two same-chain locations come back together; nothing
        // here hints which one the caller meant.
        const rows = q ? s.pharmacies.filter((p) => p.name.toLowerCase().includes(q)) : s.pharmacies;
        return ok({ pharmacies: rows });
      }

      case 'pharmacy.get_preferred': {
        const id = s.preferred_pharmacy[args.patient_id];
        if (!id) return ok({ pharmacy_id: null, pharmacy: null });
        return ok({ pharmacy_id: id, pharmacy: s.pharmacies.find((p) => p.id === id) ?? null });
      }

      case 'pharmacy.set_preferred': {
        if (!s.patients.some((p) => p.id === args.patient_id)) {
          return err(`no patient ${args.patient_id}`);
        }
        if (!s.pharmacies.some((p) => p.id === args.pharmacy_id)) {
          return err(`no pharmacy ${args.pharmacy_id}`);
        }
        s.preferred_pharmacy[args.patient_id] = args.pharmacy_id;
        return ok({ patient_id: args.patient_id, pharmacy_id: args.pharmacy_id });
      }

      case 'refill.request': {
        const med = s.medications.find(
          (m) => m.patient === args.patient_id && m.name === args.medication,
        );
        if (!med) return err(`no medication "${args.medication}" on file for ${args.patient_id}`);
        if (!s.pharmacies.some((p) => p.id === args.pharmacy_id)) {
          return err(`no pharmacy ${args.pharmacy_id}`);
        }
        if (med.refills_left <= 0) return err(`no refills remaining for ${med.name}`);
        // The backend routes controlled substances for review. It does NOT refuse to
        // act on the agent's behalf — the policy check is what notices whether the
        // agent told the caller a human has to decide.
        const status = med.controlled_schedule ? 'pending_clinician_review' : 'submitted';
        const row = {
          id: this.nextId('RQ'),
          patient: args.patient_id,
          medication: med.name,
          pharmacy_id: args.pharmacy_id,
          status,
        } as const;
        s.refill_requests.push({ ...row });
        med.refills_left -= 1;
        return ok({ refill_request: { ...row } });
      }

      case 'escalate': {
        const row = {
          id: this.nextId('ESC'),
          ...(args.patient_id ? { patient: args.patient_id } : {}),
          reason: args.reason,
          summary: args.summary,
          urgency: args.urgency,
        };
        s.escalations.push(row);
        return ok({ escalation: { ...row }, message: 'transferring to a staff member' });
      }

      default:
        return err(`unimplemented tool: ${name}`);
    }
  }
}
